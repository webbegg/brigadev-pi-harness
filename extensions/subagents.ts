/**
 * brigadev subagents: focused agents with isolated context, each in its own `pi --mode json`
 * process (the task is the message, the call returns when every task has ended). Adapted from Pi's
 * official subagent example.
 *
 * Adds the brigadev delegation contract on top: every launch names its
 * reason, the verifier needs a named risk item, writers need disjoint
 * allowed edit surfaces, and requirements travel by reference.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import { agentsCard, FINISHED_TTL_MS, visibleRuns, type AgentRun, type RunState } from "../lib/agents-card.ts";
import { autoScroll, buildEntries, entryDetail, listRow, moveSelection, resolveSelection, scrollView, VIEWER_FOOTER, viewerTitle, type RecordedRun, type Selection, type TrackedRun } from "../lib/subagent-viewer.ts";
import { formatStatus, statusCounts } from "../lib/subagent-status.ts";
import { queuedFields, subagentRow, syncRowTimer, type RowInput, type RowTimerState } from "../lib/subagent-row.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { listWidth, renderTwoPane } from "../lib/two-pane.ts";
import { emptyTally, formatCost, formatTokens } from "../lib/cost.ts";
import { installParentExitGuard, KILL_GRACE_MS, liveChildren, runChild } from "../lib/child-run.ts";
import { isUnfinished, output, runStatus, toRunState, type RunResult } from "../lib/run-status.ts";
import { BUS, onAction, publish, tail, type AgentState, type AgentStep } from "../lib/bus.ts";
import { pruneRunFolders, pruneWarning } from "../lib/run-artifacts.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { runLaunch, toResult, type Details, type LaunchHooks, type LaunchTask, type TaskView } from "../lib/subagent-launch.ts";
import { admitLaunch, enterVerifyAdmission, parseRecheck, pendingVerifies, reserveVerify, riskCategories, verifyBudget, VERIFY_AGENT, writerConflicts, type ActiveWriter, type LaunchRequest, type SkillRef } from "../lib/delegation.ts";
import { appendEvidence, buildVerifyRecord, evidenceFile, readEvidence, type EvidenceRecord } from "../lib/evidence.ts";
import { readCurrentBranch } from "../lib/commit-branch.ts";
import { RECHECK_KEY, resolveAgentRoute, resolveModelRef, type ResolvedRoute } from "../lib/model-routing.ts";
import { costCalculator, currentModelRef, loadAgents, modelCatalog } from "../lib/pi-adapters.ts";
import { effectiveProfile, readProfiles } from "../lib/profiles-store.ts";
import { canonicalPath } from "../lib/paths.ts";
import { redact } from "../lib/redact.ts";
import { isChildSession, readSettings } from "../lib/runtime.ts";
import { loadOutputSchema } from "../lib/structured-output.ts";
import { takeSnapshot } from "../lib/worktree-snapshot.ts";
import { worktreeTreeResult } from "../lib/worktree-tree.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
/** Extra time on top of the SIGTERM->SIGKILL grace that session shutdown waits for children to settle. */
const SHUTDOWN_SLACK_MS = 1000;
const STATUS_KEY = "brigadev-agents";
const CARD_KEY = "brigadev-agents-card";
const CARD_COLLAPSE_KEY = "ctrl+shift+a";
const VIEWER_KEY = "alt+a";
/** Settled runs this process remembers for the viewer (older ones are still on the session branch). */
const MAX_SETTLED_VIEW_RUNS = 100;
/** Tool results that carry finished runs. */
const VIEWER_TOOLS = new Set(["subagent"]);

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exec = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(exec) ? { command: "pi", args } : { command: process.execPath, args };
}

// Field descriptions live on the top-level fields only; parallel items reuse
// the same fields without repeating them (every tool byte is sent each turn).
const launchFields = (described: boolean) => {
	const d = (description: string) => (described ? { description } : {});
	return {
		agent: Type.String(d("Agent name")),
		task: Type.String(d("Task; requirements by reference or verbatim")),
		reason: Type.String(d('Delegation trigger, or "Risk: <category> (why)" for brigadev-verify')),
		allowedEditSurfaces: Type.Optional(Type.Array(Type.String(), d("Writers: narrow repo-relative paths/globs"))),
		featureDoc: Type.Optional(Type.String(d("Feature document path (read until ## Log)"))),
		skills: Type.Optional(Type.Array(Type.String(), d("Skill names to read first"))),
	};
};

const described = launchFields(true);
const Params = Type.Object({
	agent: Type.Optional(described.agent),
	task: Type.Optional(described.task),
	reason: Type.Optional(described.reason),
	allowedEditSurfaces: described.allowedEditSurfaces,
	featureDoc: described.featureDoc,
	skills: described.skills,
	tasks: Type.Optional(Type.Array(Type.Object(launchFields(false)), { description: `Parallel independent units (max ${MAX_PARALLEL_TASKS}), same fields` })),
});

function formatUsage(r: RunResult): string {
	const u = r.usage;
	const prompt = u.input + u.cacheRead + u.cacheWrite;
	return [
		r.model && `${r.model}${r.thinking ? ` · ${r.thinking}` : ""}`,
		r.route,
		u.turns && `${u.turns} turns`,
		prompt && `↑${formatTokens(prompt)}`,
		u.output && `↓${formatTokens(u.output)}`,
		u.cost && formatCost(u.cost),
	]
		.filter(Boolean)
		.join(" · ");
}

/** Row state: queued counts as running, an aborted placeholder (exitCode -1 with an end time) as failed. */
function rowState(r: RunResult): RunState {
	return toRunState(runStatus(r));
}

function rowInput(r: RunResult): RowInput {
	const calls = r.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall") : []));
	return {
		agent: r.agent,
		state: rowState(r),
		model: r.model,
		thinking: r.thinking,
		route: r.route,
		inherited: r.inherited,
		queued: r.queued,
		cancelled: r.cancelled,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		cost: r.usage.cost,
		calls: calls.flatMap((c) => (c.type === "toolCall" ? [{ name: c.name, arguments: c.arguments as Record<string, unknown> }] : [])),
		error: r.errorMessage,
	};
}

/** The agents card's numbers for one run: every kind of token, and the cost. */
function cardUsage(r: RunResult): { tokens: number; cost: number } {
	return { tokens: r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output, cost: r.usage.cost };
}

const MAX_BUS_STEPS = 12;
const MAX_BUS_TASK = 4000;
const MAX_BUS_OUTPUT = 20_000;
const STEP_FIELDS = ["path", "file_path", "command", "pattern", "query", "agent"] as const;
const capText = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
/** Text for the bus: credentials masked first, then capped (so a cut never leaves half a token). */
const busText = (text: string, max: number) => capText(redact(text), max);

/** The child's last tool calls as one-line steps, for a detail view. */
function recentSteps(r: RunResult): AgentStep[] {
	const calls = r.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall") : []));
	return calls.slice(-MAX_BUS_STEPS).map((c) => {
		const args = (c.arguments ?? {}) as Record<string, unknown>;
		const field = STEP_FIELDS.find((f) => typeof args[f] === "string" && args[f]);
		return { tool: capText(String(c.name), 80), summary: field ? busText(String(args[field]).replace(/\s+/g, " ").trim(), 160) : "" };
	});
}

/** One task as the bus shows it (`brigadev:agent`): a full snapshot, from the same run data as the card. */
function agentState(launchId: number, index: number, r: RunResult, cancellable: boolean, over: Partial<AgentState> = {}): AgentState {
	const status = runStatus(r);
	const live = isUnfinished(status);
	const steps = recentSteps(r);
	return {
		id: `${launchId}:${index}`,
		launchId: String(launchId),
		index,
		agent: r.agent,
		task: redact(r.task.split("\n")[0]),
		taskText: busText(r.task, MAX_BUS_TASK),
		steps: steps.length ? steps : undefined,
		output: live || r.exitCode === -1 ? undefined : busText(output(r), MAX_BUS_OUTPUT),
		status,
		model: r.model,
		thinking: r.thinking,
		...cardUsage(r),
		partial: live ? tail(r.partial === undefined ? undefined : redact(r.partial)) : undefined,
		runId: r.runId,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		cancellable: cancellable && live,
		...over,
	};
}

/** The evidence log of the repository and branch a verify launches from, and the source tree it would verify. */
interface VerifyLog {
	branch: string | null;
	file: string;
	records: EvidenceRecord[];
	/** The worktree trees; undefined without git, or when they could not be computed (no record is written then). */
	keyed?: { tree: string; srcTree?: string; root: string };
	srcTree?: string;
}

async function readVerifyLog(exec: Parameters<typeof readCurrentBranch>[0], cwd: string): Promise<VerifyLog> {
	const tree = await worktreeTreeResult(cwd, { sourceTree: true });
	const branch = await readCurrentBranch(exec, cwd);
	const file = evidenceFile(repoDocsDir(cwd), branch);
	const keyed = tree.kind === "tree" ? { tree: tree.tree, srcTree: tree.sourceTree, root: tree.root } : undefined;
	let records: EvidenceRecord[] = [];
	try {
		records = readEvidence(file);
	} catch {
		// An unreadable log (a directory, no permission) counts as no records, as before the budget existed; the reservation still holds.
	}
	return { branch, file, records, keyed, srcTree: keyed?.srcTree };
}

function verifyRecordFor(request: LaunchRequest, log: VerifyLog, result: { failed: boolean; structured?: unknown }, runId?: string) {
	return buildVerifyRecord({ ts: new Date().toISOString(), branch: log.branch, ...log.keyed, runId, scope: parseRecheck(request.reason) ? "recheck" : "branch", categories: riskCategories(request.reason), rechecked: parseRecheck(request.reason), result });
}

function routeLabel(route: ResolvedRoute, profileName: string | undefined): string {
	if (route.profileKey && profileName) return `profile:${profileName}/${route.profileKey}`;
	return route.modelSource === "none" ? "pi default" : route.modelSource;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	// Children run in their own process group, so a parent that dies without `session_shutdown` would leave them running:
	// SIGKILL their groups when the process exits (once per process, whatever the number of /reloads). SIGTERM/SIGHUP are
	// Pi's to handle (graceful shutdown then process.exit), so no signal listeners here.
	installParentExitGuard(liveChildren);

	let skills: SkillRef[] = [];
	const activeWriters: ActiveWriter[] = [];
	// Launches in flight by id: their result placeholders are the one source of the footer's running count
	// and of the viewer's live rows, so nothing is counted by hand and no exit path can leave a count behind.
	const launches = new Map<RunResult[], number>();
	let launchSeq = 0;
	// Runs of launches that ended in this session, for the viewer.
	let settled: TrackedRun[] = [];
	// Bumped on session start: a launch left from the previous session must not add to the new one.
	let epoch = 0;
	// Repaint hook of the open Agents viewer.
	let repaintViewer: (() => void) | undefined;

	// One concurrency cap for every launch in this process.
	const slots = createSemaphore(MAX_CONCURRENCY);

	// Tasks a UI may cancel, by row id (`<launchId>:<index>`): present from admission until the launch ends. A cancel of an
	// unknown or settled id is ignored. The subscription follows the session so a /reload never leaves a stale listener.
	const cancelTasks = new Map<string, () => boolean>();
	let stopListening: (() => void) | undefined;
	const listen = () => {
		stopListening ??= onAction(pi.events, "cancel-agent", ({ id }) => void cancelTasks.get(id)?.());
	};
	listen();

	// Agents card: live rows above the editor while subagents run.
	let runs: AgentRun[] = [];
	let cardCollapsed = false;
	let renderCard: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let expiry: ReturnType<typeof setTimeout> | undefined;

	const stopTimers = () => {
		if (ticker) clearInterval(ticker);
		if (expiry) clearTimeout(expiry);
		ticker = expiry = undefined;
	};

	// Footer: `agents: 2 running · 3 done · alt+a`. Done follows the card's lifetime.
	const syncStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, formatStatus(statusCounts(launches.keys(), runs, Date.now()), VIEWER_KEY));
		} catch {
			// A stale context (session replaced): the new session sets its own status.
		}
	};

	const showCard = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (visibleRuns(runs, Date.now()).length === 0) {
			stopTimers();
			renderCard = undefined;
			ctx.ui.setWidget(CARD_KEY, undefined);
			syncStatus(ctx);
			return;
		}
		if (!renderCard) {
			ctx.ui.setWidget(CARD_KEY, (tui, theme) => {
				renderCard = () => tui.requestRender();
				return {
					dispose() {
						renderCard = undefined;
					},
					invalidate() {},
					render(width: number): string[] {
						// Rows are indented by 2 columns, so lay them out for the remaining width.
						return agentsCard(runs, { width: Math.max(10, width - 2), now: Date.now(), collapsed: cardCollapsed, measure: visibleWidth }).map((line, i) =>
							truncateToWidth(i === 0 ? `${theme.fg("borderMuted", "─ ")}${theme.fg(line.tone, theme.bold(line.text))}` : `  ${theme.fg(line.tone, line.text)}`, width),
						);
					},
				};
			});
		}
		renderCard?.();
		syncStatus(ctx);
		// Tick the elapsed column while work runs; drop finished rows after their TTL (the footer's done count expires with them).
		const anyRunning = runs.some((r) => r.state === "running");
		if (anyRunning && !ticker) {
			ticker = setInterval(() => {
				renderCard?.();
				syncStatus(ctx);
			}, 1000);
		}
		if (!anyRunning) {
			if (ticker) clearInterval(ticker);
			ticker = undefined;
			if (expiry) clearTimeout(expiry);
			expiry = setTimeout(() => showCard(ctx), FINISHED_TTL_MS + 100);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		listen();
		runs = [];
		launches.clear();
		settled = [];
		epoch++;
		showCard(ctx);
		// Run folders hold full transcripts: keep 14 days and at most 200 (lib/run-artifacts.ts). Never fails the session.
		try {
			const warning = pruneWarning(pruneRunFolders(repoDocsDir(ctx.cwd)));
			if (warning !== undefined && ctx.hasUI) ctx.ui.notify(warning, "warning");
		} catch {
			// Retention is housekeeping, not part of starting a session.
		}
	});
	// Children get SIGTERM, and are given KILL_GRACE_MS + 1 s to settle; a group still alive then is
	// SIGKILLed before this returns, so no child or grandchild outlives the parent. The wait is bounded: shutdown cannot hang.
	pi.on("session_shutdown", async () => {
		stopTimers();
		stopListening?.();
		stopListening = undefined;
		await liveChildren.shutdown({ graceMs: KILL_GRACE_MS + SHUTDOWN_SLACK_MS, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout) });
	});

	pi.registerShortcut(CARD_COLLAPSE_KEY, {
		description: "Collapse or expand the brigadev agents card",
		handler: async (ctx) => {
			cardCollapsed = !cardCollapsed;
			showCard(ctx);
		},
	});

	pi.on("before_agent_start", async (event) => {
		skills = (event.systemPromptOptions.skills ?? []).map((s) => ({ name: s.name, filePath: s.filePath }));
	});

	// The launch behind the `subagent` tool: always synchronous, it returns when every task has ended.
	async function launch(params: Static<typeof Params>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext) {
		// Verify reservations of this call: released once the call is over and its records are appended (or it was rejected).
		const held: Array<() => void> = [];
		try {
			return await launchWithin(params, signal, onUpdate, ctx, held);
		} finally {
			for (const release of held) release();
		}
	}

	async function launchWithin(params: Static<typeof Params>, signal: AbortSignal | undefined, onUpdate: unknown, ctx: ExtensionContext, held: Array<() => void>) {
		const agents = loadAgents(ctx);
		const requests: LaunchRequest[] = params.tasks?.length
			? params.tasks
			: params.agent
				? [{ agent: params.agent, task: params.task ?? "", reason: params.reason ?? "", allowedEditSurfaces: params.allowedEditSurfaces, featureDoc: params.featureDoc, skills: params.skills }]
				: [];
		const mode: Details["mode"] = params.tasks?.length ? "parallel" : "single";
		const reject = (text: string) => ({ content: [{ type: "text" as const, text }], details: { mode, results: [] } as Details, isError: true });

		if (requests.length === 0) return reject(`Provide {agent, task, reason} or tasks[]. Agents: ${agents.map((a) => a.name).join(", ")}`);
		if (requests.length > MAX_PARALLEL_TASKS) return reject(`Too many parallel tasks (${requests.length}); max ${MAX_PARALLEL_TASKS}.`);

		const resolved = requests.map((request) => ({ request, agent: agents.find((a) => a.name === request.agent) }));
		const admission = resolved.map(({ request, agent }) => admitLaunch(request, agent, agents));
		const problems = admission.flatMap((found, i) => found.map((p) => (requests.length > 1 ? `task ${i + 1}: ${p}` : p)));
		problems.push(...writerConflicts(resolved.filter((r) => r.agent).map((r) => ({ agent: r.agent!, surfaces: r.request.allowedEditSurfaces ?? [] })), activeWriters));

		const exec = (command: string, args: string[], options: { cwd: string; timeout: number }) => pi.exec(command, args, options);

		// Verify budget (S7), read from the evidence log of this repository and branch; a launch that is already rejected is not judged.
		const verifyTasks = resolved.flatMap(({ request, agent }, i) => (agent?.name === VERIFY_AGENT && admission[i].length === 0 ? [{ index: i, request }] : []));
		// Sibling tool calls of one message run concurrently and nothing is on disk until a verify ends, so the section that reads the
		// log, judges the budget, and reserves is entered synchronously (before any await) and runs one call at a time.
		const leaveAdmission = verifyTasks.length > 0 ? await enterVerifyAdmission() : undefined;
		let verifyLog: VerifyLog | undefined;
		const asks: string[] = [];
		try {
			verifyLog = verifyTasks.length > 0 ? await readVerifyLog(exec, ctx.cwd) : undefined;
			if (verifyLog) {
				const key = `${verifyLog.keyed?.root ?? canonicalPath(ctx.cwd)}\0${verifyLog.branch ?? ""}`;
				for (const { index, request } of verifyTasks) {
					// Verifies reserved by this call and by sibling calls count like finished ones: the log has no record of them yet.
					const verdict = verifyBudget([...verifyLog.records, ...pendingVerifies(key)], { reason: request.reason, branch: verifyLog.branch }, verifyLog.srcTree);
					const label = requests.length > 1 ? `task ${index + 1}: ` : "";
					if (!verdict.ok && !verdict.ask) {
						problems.push(`${label}${verdict.message}`);
						continue;
					}
					if (!verdict.ok) asks.push(`${label}${verdict.message}`);
					const record = verifyRecordFor(request, verifyLog, { failed: false });
					held.push(reserveVerify(key, { ...record, outcome: "clean", blockers: [], pending: true }));
				}
			}
		} finally {
			leaveAdmission?.();
		}

		// Model routing: session profile > default profile > agent definition > this session's model. One model per agent.
		const { file } = readProfiles();
		const profile = effectiveProfile(file, ctx.sessionManager.getBranch());
		const parent = { model: currentModelRef(ctx), thinking: ctx.thinkingLevel };
		const catalog = modelCatalog(ctx);
		// A recheck routes through the profile's recheck key when it has one, else like any verify.
		const routes = resolved.map(({ request, agent }) => (agent ? resolveAgentRoute({ profile: profile.profile, agent, parent, routeKey: agent.name === VERIFY_AGENT && parseRecheck(request.reason) ? RECHECK_KEY : undefined }) : undefined));
		routes.forEach((route, i) => {
			if (route?.model && route.modelSource !== "parent" && "error" in resolveModelRef(route.model, catalog, ctx.model?.provider)) {
				problems.push(`${requests.length > 1 ? `task ${i + 1}: ` : ""}${resolved[i].request.agent} routes to unknown model "${route.model}" (${routeLabel(route, profile.name)}); fix it with /brigadev:profile set`);
			}
		});
		// Output schemas are read once here; a broken one rejects the launch instead of failing the child.
		const schemas = resolved.map(({ agent }, i) => {
			if (!agent?.outputSchema) return undefined;
			const loaded = loadOutputSchema(agent.outputSchema);
			if ("schema" in loaded) return loaded.schema;
			problems.push(`${requests.length > 1 ? `task ${i + 1}: ` : ""}${agent.name}: ${loaded.error}`);
			return undefined;
		});
		if (problems.length > 0) return reject(`Launch rejected by brigadev delegation rules:\n- ${problems.join("\n- ")}`);
		// Another branch verify on a changed source tree is the user's call.
		for (const message of asks) {
			const instead = "Prove the fix with a repro test RED→GREEN via check instead.";
			if (!ctx.hasUI) return reject(`Launch rejected by brigadev delegation rules:\n- ${message} It needs the user's confirmation, and there is no UI. ${instead}`);
			if (!(await ctx.ui.confirm("brigadev: another branch verify?", `${message}\n\nA full verify is the costliest review step. Run it anyway?`))) {
				return reject(`Launch rejected by brigadev delegation rules:\n- ${message} The user declined. ${instead}`);
			}
		}

		// Placeholders carry the routed model so a queued task (beyond MAX_CONCURRENCY) already shows it.
		const results: RunResult[] = resolved.map(({ request }, i) => ({
			agent: request.agent,
			task: request.task,
			exitCode: -1,
			messages: [],
			stderr: "",
			usage: emptyTally(),
			...(routes[i] ? queuedFields(routes[i]!, routeLabel(routes[i]!, profile.name)) : { queued: true }),
		}));
		// `/brigadev:codemode off` also covers the children: their tool lists lose codemode (a list that would become empty is left alone: no `--tools` flag would mean every tool).
		const codemodeOff = readSettings().codemode === false;
		const withoutCodemode = <A extends { tools?: string[] }>(agent: A): A => {
			const kept = agent.tools?.filter((tool) => tool !== "codemode");
			return codemodeOff && kept?.length && kept.length !== agent.tools?.length ? { ...agent, tools: kept } : agent;
		};
		const tasks: LaunchTask[] = resolved.map(({ request, agent }, i) => ({ request, agent: withoutCodemode(agent!), route: routes[i]!, routeLabel: routeLabel(routes[i]!, profile.name) }));
		const hooks: LaunchHooks = { onUpdate: onUpdate as LaunchHooks["onUpdate"] };

		const price = costCalculator(ctx);
		// Agents card rows, one per task that got a slot.
		const cards = new Map<number, AgentRun>();
		const id = launchSeq++;
		const syncCard = (cardRun: AgentRun, r: RunResult) => {
			Object.assign(cardRun, cardUsage(r));
			if (r.model) cardRun.model = r.model;
		};
		// Bus snapshots of this launch's tasks. Never throws: an observer must not change the launch.
		let cancelTask: ((index: number) => boolean) | undefined;
		const lastStatus = new Map<number, string>();
		const announce = (index: number, over?: Partial<AgentState>) => {
			try {
				const state = agentState(id, index, results[index], cancelTasks.has(`${id}:${index}`), { reason: busText(resolved[index]?.request.reason ?? "", 500) || undefined, ...over });
				lastStatus.set(index, state.status);
				publish(pi.events, BUS.agent, state);
			} catch {
				// A snapshot that cannot be built is skipped.
			}
		};
		const view: TaskView = {
			start(index, info) {
				const cardRun: AgentRun = { id: randomUUID().slice(0, 8), agent: info.agent, task: info.task, state: "running", model: info.model, thinking: info.thinking, tokens: 0, cost: 0, startedAt: info.startedAt };
				cards.set(index, cardRun);
				runs.push(cardRun);
				// The placeholder is replaced right after this hook: the task is running now.
				announce(index, { status: "running", startedAt: info.startedAt, model: info.model, thinking: info.thinking, cancellable: cancelTasks.has(`${id}:${index}`) });
				showCard(ctx);
				repaintViewer?.();
			},
			attempt(index, result) {
				const cardRun = cards.get(index)!;
				Object.assign(cardRun, { model: result.model, thinking: result.thinking });
				announce(index);
				repaintViewer?.();
			},
			update(index, partial) {
				const cardRun = cards.get(index)!;
				syncCard(cardRun, partial);
				announce(index);
				repaintViewer?.();
			},
			finish(index, result) {
				const cardRun = cards.get(index)!;
				syncCard(cardRun, result);
				cardRun.state = runStatus(result) === "done" ? "done" : "failed";
				cardRun.endedAt = Date.now();
				announce(index);
				showCard(ctx);
				repaintViewer?.();
			},
			// A queued task the user cancelled has no card row; the bus still hears how it ended.
			skipped(index) {
				announce(index);
				repaintViewer?.();
			},
		};

		const launchEpoch = epoch;
		launches.set(results, id);
		results.forEach((_, i) => cancelTasks.set(`${id}:${i}`, () => cancelTask?.(i) ?? false));
		results.forEach((_, i) => announce(i));
		syncStatus(ctx);
		repaintViewer?.();

		try {
			return toResult(
				mode,
				await runLaunch(
					{ mode, tasks, results, signal, hooks, exposeCancel: (cancel) => void (cancelTask = cancel) },
					{
						slots,
						runAgent: (call) =>
							runChild(
								{ cwd: ctx.cwd, agent: tasks[call.index].agent, request: tasks[call.index].request, taskText: call.taskText, route: call.route, routeLabel: call.routeLabel, schema: schemas[call.index], price, signal: call.signal, onUpdate: call.onUpdate },
								{ piInvocation },
							),
						skills: () => skills,
						writers: {
							add: (writers) => void activeWriters.push(...writers),
							remove: (writer) => {
								const at = activeWriters.indexOf(writer);
								if (at >= 0) activeWriters.splice(at, 1);
							},
						},
						view,
						snapshot: () => takeSnapshot(exec, canonicalPath(ctx.cwd)),
					},
				),
			);
		} finally {
			// Nothing of this launch can be cancelled any more; each task's last word reaches the bus (a task the launch abort ended included).
			cancelTask = undefined;
			results.forEach((_, i) => cancelTasks.delete(`${id}:${i}`));
			results.forEach((result, i) => {
				if (lastStatus.get(i) !== runStatus(result) || isUnfinished(runStatus(result))) announce(i);
			});
			// Every verify that ran leaves one record (S6), whatever its outcome; the log must never fail the launch.
			if (verifyLog?.keyed) {
				try {
					for (const { index, request } of verifyTasks) {
						const result = results[index];
						const status = runStatus(result);
						if (status === "done" || status === "failed") appendEvidence(verifyLog.file, verifyRecordFor(request, verifyLog, { failed: status === "failed", structured: result.structured }, result.runId));
					}
				} catch {
					// Evidence is a ledger, not part of the run.
				}
			}
			// It no longer counts as running, its rows settle, and its runs stay viewable.
			if (launchEpoch === epoch) {
				launches.delete(results);
				for (const cardRun of cards.values()) if (cardRun.state === "running") Object.assign(cardRun, { state: "failed", endedAt: Date.now() });
				results.forEach((result, i) => {
					if (result.exitCode !== -1 || result.endedAt !== undefined) settled.push({ id: `${id}:${i}`, result });
				});
				settled = settled.slice(-MAX_SETTLED_VIEW_RUNS);
				try {
					showCard(ctx);
				} catch {
					// A stale context: the launch's outcome matters more than its card.
				}
				repaintViewer?.();
			}
		}
	}

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run a focused brigadev agent in its own context, only for a named delegation trigger. Single: agent, task, reason. Parallel: tasks[]. Writers need allowedEditSurfaces.",
		parameters: Params,

		execute: async (_id, params, signal, onUpdate, ctx) => launch(params, signal, onUpdate, ctx),

		renderCall(args, theme) {
			const shown = args.tasks?.length ? args.tasks : [{ agent: args.agent ?? "...", task: args.task ?? "", reason: args.reason ?? "" }];
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", shown.length > 1 ? `parallel (${shown.length})` : shown[0].agent);
			for (const l of shown.slice(0, 4)) {
				const preview = l.task.length > 60 ? `${l.task.slice(0, 60)}…` : l.task;
				text += `\n  ${shown.length > 1 ? `${theme.fg("accent", l.agent)} ` : ""}${theme.fg("dim", preview)}`;
				if (l.reason) text += theme.fg("muted", ` — ${l.reason}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as Details | undefined;
			if (!details?.results.length) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const now = Date.now();
			const container = new Container();
			for (const r of details.results) {
				subagentRow(rowInput(r), { now, expanded }).forEach((line, i) => {
					// The header stays one line: it truncates from the end (cost, calls) and keeps agent and model.
					if (i === 0) container.addChild({ render: (width: number) => [theme.fg(line.tone, theme.bold(truncateToWidth(line.text, Math.max(1, width), "…")))], invalidate: () => {} });
					else container.addChild(new Text(theme.fg(line.tone, line.text), 0, 0));
				});
				if (expanded && formatUsage(r)) container.addChild(new Text(theme.fg("dim", `  ${formatUsage(r)}`), 0, 0));
				if (expanded && r.exitCode !== -1) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(output(r).trim(), 0, 0, getMarkdownTheme()));
					container.addChild(new Spacer(1));
				}
			}
			if (!expanded) container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			// Redraw once a second while a run is live so the elapsed time ticks. Started only now that the rows
			// were built, and it stops itself when this component is no longer drawn (chat rebuild).
			const live = details.results.some((r) => rowState(r) === "running");
			const touch = syncRowTimer(context?.state as RowTimerState | undefined, { live: live && Boolean(context?.isPartial), invalidate: () => context?.invalidate() });
			return {
				render: (width: number) => {
					touch();
					return container.render(width);
				},
				invalidate: () => container.invalidate(),
			};
		},
	});

	/** Every run: those this process tracks (queued, running, and settled since the session started) plus the finished ones recorded on this branch. */
	const viewerEntries = (ctx: ExtensionContext) => {
		const tracked: TrackedRun[] = [...settled];
		for (const [results, id] of launches) results.forEach((result, i) => tracked.push({ id: `${id}:${i}`, result }));
		const recorded: RecordedRun[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || !VIEWER_TOOLS.has(entry.message.toolName)) continue;
			const details = entry.message.details as Details | undefined;
			const at = Date.parse(entry.timestamp);
			for (const result of details?.results ?? []) recorded.push({ result, at });
		}
		return buildEntries({ tracked, recorded, now: Date.now() });
	};

	// Read-only: browse the runs and their threads. Nothing here steers or stops a child.
	const openViewer = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("The Agents viewer needs the interactive UI", "error");
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const painter = themePainter(theme);
			let selection: Selection = { key: undefined, index: 0 };
			let view = scrollView.initial();
			let detailOnly = false;
			// The list changes while the viewer is open: repaint on every progress update, and once a second so elapsed times tick.
			repaintViewer = () => tui.requestRender();
			const timer = setInterval(() => tui.requestRender(), 1000);
			const close = () => {
				clearInterval(timer);
				repaintViewer = undefined;
				done();
			};
			const detailWidth = (width: number) => (detailOnly ? width - 2 : width - listWidth(width) - 4);
			const home = os.homedir();

			return {
				invalidate() {},
				handleInput(data: string) {
					const entries = viewerEntries(ctx);
					selection = resolveSelection(entries, selection);
					const entry = entries[selection.index];
					const bodyHeight = Math.max(1, tui.terminal.rows - 3);
					const total = entryDetail(entry, detailWidth(tui.terminal.columns), home).length;
					// Scroll keys act on what is on screen (a pinned thread is at its end).
					const shown = { scroll: autoScroll(view, total, bodyHeight, entry?.active ?? false), follow: view.follow };
					if (matchesKey(data, Key.escape) || data === "q") return close();
					if (matchesKey(data, Key.down) || data === "j") [selection, view] = [moveSelection(entries, selection, 1), scrollView.initial()];
					else if (matchesKey(data, Key.up) || data === "k") [selection, view] = [moveSelection(entries, selection, -1), scrollView.initial()];
					else if (matchesKey(data, Key.pageDown) || data === " " || data === "J") view = scrollView.by(shown, 10, total, bodyHeight);
					else if (matchesKey(data, Key.pageUp) || data === "K") view = scrollView.by(shown, -10, total, bodyHeight);
					else if (data === "g") view = scrollView.to(shown, "top", total, bodyHeight);
					else if (data === "G") view = scrollView.to(shown, "bottom", total, bodyHeight);
					else if (data === "F") detailOnly = !detailOnly;
					tui.requestRender();
				},
				render(width: number): string[] {
					const entries = viewerEntries(ctx);
					selection = resolveSelection(entries, selection);
					const entry = entries[selection.index];
					const detail = entryDetail(entry, detailWidth(width), home);
					const bodyHeight = Math.max(1, tui.terminal.rows - 3);
					// A queued or running thread follows its newest lines until the user scrolls up.
					view = { scroll: autoScroll(view, detail.length, bodyHeight, entry?.active ?? false), follow: view.follow };
					return renderTwoPane(
						{
							width,
							height: tui.terminal.rows,
							title: viewerTitle(entries),
							list: entries.map(listRow),
							selected: selection.index,
							detail,
							detailScroll: view.scroll,
							detailOnly,
							empty: "No subagent runs in this session yet",
							footer: VIEWER_FOOTER,
						},
						painter,
					);
				},
			};
		}, FULLSCREEN_OVERLAY);
	};

	pi.registerCommand("brigadev:runs", { description: "Agents viewer: every subagent run in this session with its thread (read-only)", handler: async (_args, ctx) => openViewer(ctx) });
	pi.registerShortcut(VIEWER_KEY, { description: "Open the brigadev Agents viewer", handler: async (ctx) => openViewer(ctx) });

	pi.registerCommand("brigadev:agents", {
		description: "List brigadev agents (package, user, and trusted project agents)",
		handler: async (_args, ctx) => {
			const profile = effectiveProfile(readProfiles().file, ctx.sessionManager.getBranch());
			const parent = { model: currentModelRef(ctx), thinking: ctx.thinkingLevel };
			const lines = loadAgents(ctx).map((a) => {
				const flags = [a.writer ? "writer" : "read-only", a.admission === "risk" ? "risk-gated" : "", a.source].filter(Boolean).join(", ");
				const route = resolveAgentRoute({ profile: profile.profile, agent: a, parent });
				return `${a.name} (${flags}) → ${route.model ?? "?"} · ${route.thinking ?? "default"} [${routeLabel(route, profile.name)}]\n    ${a.description}`;
			});
			ctx.ui.notify(lines.join("\n") || "No agents found", "info");
		},
	});
}
