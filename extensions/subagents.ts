/**
 * brigadev subagents: focused agents with isolated context, each in its own
 * `pi --mode rpc` process (the task is sent as an RPC prompt, so a running child can
 * be steered or aborted from the Agents viewer). Adapted from Pi's official subagent example.
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
import { Box, Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { agentsCard, FINISHED_TTL_MS, visibleRuns, type AgentRun, type RunState } from "../lib/agents-card.ts";
import { ABORT_PROMPT, abortArmFor, autoScroll, buildEntries, canTakeOver, entryDetail, listRow, moveSelection, openTakeover, pressAbort, printableText, resolveSelection, scrollView, takeoverFooter, takeoverKey, takeoverKind, takeoverNotice, viewerFooter, viewerTitle, type AbortArm, type RecordedRun, type Selection, type TakeoverKey, type TakeoverState, type TrackedRun } from "../lib/subagent-viewer.ts";
import type { ChildControl } from "../lib/child-rpc.ts";
import { formatStatus, statusCounts } from "../lib/subagent-status.ts";
import { queuedFields, runState, subagentRow, syncRowTimer, type RowInput, type RowTimerState } from "../lib/subagent-row.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { listWidth, renderTwoPane } from "../lib/two-pane.ts";
import { emptyTally, formatCost, formatTokens } from "../lib/cost.ts";
import { failed, installParentExitGuard, KILL_GRACE_MS, liveChildren, output, runChild, type RunResult } from "../lib/child-run.ts";
import { newRunId, pruneRunFolders } from "../lib/run-artifacts.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { runLaunch, toResult, type Details, type FallbackStep, type LaunchHooks, type LaunchResult, type LaunchTask, type TaskView } from "../lib/subagent-launch.ts";
import { createResultDelivery, deliveredNote, omittedLaunchIds, omittedResultText, resultBatchMessage, resultCard, RESULT_MESSAGE_TYPE, type BatchEntry, type ResultMessageDetails } from "../lib/result-delivery.ts";
import { createSubagentRegistry, type WaitOutcome } from "../lib/subagent-registry.ts";
import { admitLaunch, writerConflicts, type ActiveWriter, type LaunchRequest, type SkillRef } from "../lib/delegation.ts";
import { cooldownMs, launchOrder, priceNote } from "../lib/fallback.ts";
import { blockedReason, fallbackState } from "../lib/fallback-state.ts";
import { resolveAgentRoute, resolveModelRef, routeFor, type ResolvedRoute } from "../lib/model-routing.ts";
import { costCalculator, currentModelRef, listPrice, loadAgents, modelCatalog } from "../lib/pi-adapters.ts";
import { effectiveProfile, readProfiles } from "../lib/profiles-store.ts";
import { panelState } from "../lib/panel-state.ts";
import { canonicalPath } from "../lib/paths.ts";
import { isChildSession } from "../lib/runtime.ts";
import { loadOutputSchema } from "../lib/structured-output.ts";
import { takeSnapshot } from "../lib/worktree-snapshot.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const WAIT_DEFAULT_SECONDS = 60;
const WAIT_MAX_SECONDS = 300;
/** Extra time on top of the SIGTERM->SIGKILL grace that session shutdown waits for children to settle. */
const SHUTDOWN_SLACK_MS = 1000;
const STATUS_KEY = "brigadev-agents";
const CARD_KEY = "brigadev-agents-card";
const CARD_COLLAPSE_KEY = "ctrl+shift+a";
const VIEWER_KEY = "alt+a";
/** Settled runs this process remembers for the viewer (older ones are still on the session branch when collected). */
const MAX_SETTLED_VIEW_RUNS = 100;
/** Tool results that carry finished runs: a sync call, or an async launch collected by wait/cancel. */
const VIEWER_TOOLS = new Set(["subagent", "subagent_wait", "subagent_cancel"]);

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
		reason: Type.String(d('Delegation trigger, or "Risk: item N (why)" for brigadev-verify')),
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
	async: Type.Optional(Type.Boolean({ description: "Return a launch id now; collect it with subagent_wait" })),
});

const WaitParams = Type.Object({
	runId: Type.String({ description: "Launch id from an async subagent call" }),
	timeoutSeconds: Type.Optional(Type.Number({ description: `Default ${WAIT_DEFAULT_SECONDS}, max ${WAIT_MAX_SECONDS}` })),
});
const CancelParams = Type.Object({ runId: Type.String({ description: "Launch id from an async subagent call" }) });

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

/** Row state: an aborted placeholder (exitCode -1 with an end time) counts as failed. */
function rowState(r: RunResult): RunState {
	return runState(r, failed(r));
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
		fallbacks: r.fallbacks,
		startedAt: r.startedAt,
		endedAt: r.endedAt,
		cost: r.usage.cost,
		calls: calls.flatMap((c) => (c.type === "toolCall" ? [{ name: c.name, arguments: c.arguments as Record<string, unknown> }] : [])),
		error: r.errorMessage,
	};
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
	// Async launches record the writers other launches register while they run (the A1 backstop exclusion).
	const writerListeners = new Set<(writers: readonly ActiveWriter[]) => void>();
	// Launches in flight, sync or async, by id: their result placeholders are the one source of the footer's running count
	// and of the viewer's live rows, so nothing is counted by hand and no exit path can leave a count behind.
	const launches = new Map<RunResult[], number>();
	let launchSeq = 0;
	// Steering handles of the running children, by viewer entry key (`<launch>:<task>`). A finished run has none.
	const controls = new Map<string, ChildControl>();
	// Runs of launches that ended in this session, for the viewer (async launches stay visible before they are collected).
	let settled: TrackedRun[] = [];
	// Bumped on session start: a launch left from the previous session must not add to the new one.
	let epoch = 0;
	// Repaint hook of the open Agents viewer.
	let repaintViewer: (() => void) | undefined;

	// One concurrency cap for every launch in this process, sync or async.
	const slots = createSemaphore(MAX_CONCURRENCY);
	// Async launches: each runs under its own AbortController, collected by subagent_wait / subagent_cancel.
	const registry = createSubagentRegistry<LaunchResult>({
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
		newId: () => newRunId("launch"),
		// A result held for the idle parent is never pruned before it is delivered or collected.
		isPinned: (id) => delivery.isHeld(id),
	});

	// Idle delivery of async results the model did not collect: injected as a custom message that starts a parent turn.
	// Pi API (docs/extensions.md in the installed pi-coding-agent): `pi.sendMessage(..., { triggerTurn: true, deliverAs: "steer" })`
	// starts a turn when idle and joins the run when busy (L1627-1649); `ctx.isIdle()` (L1255-1257); `agent_settled` is the
	// final-idle signal, `agent_end` is not (L336, L661-693); a renderer is registered per customType (L1805, L3165-3200).
	let parentCtx: ExtensionContext | undefined;
	// Launches the last delivery left as a pointer (size guard): recorded as such when the delivery succeeds.
	let omittedInDelivery = new Set<string>();
	const delivery = createResultDelivery<LaunchResult>({
		isIdle: () => {
			try {
				return parentCtx?.isIdle() ?? false;
			} catch {
				return false; // a stale context (session replaced): treat as busy; session_start resets the buffer
			}
		},
		isConsumed: (id) => registry.get(id)?.consumed ?? true,
		markConsumed: (id) => void registry.markConsumed(id, omittedInDelivery.has(id) ? "delivered-omitted" : "delivered"),
		// One message per flush (D1): every ready launch in one combined message, so one parent turn starts and its model sees all of them.
		deliver: (batch) => {
			const entries = batch.map(({ id, launch, result }): BatchEntry => {
				const collectedResult = collected(id, launch.error === undefined ? { status: "settled", launch, result } : { status: "settled", launch, error: launch.error });
				const tasks = (result?.details.results ?? []).map((r) => ({ agent: r.agent, artifactsDir: r.artifactsDir }));
				return { id, text: collectedResult.content.map((c) => c.text).join("\n"), failed: collectedResult.isError === true || launch.error !== undefined, pointer: omittedResultText(id, tasks) };
			});
			const message = resultBatchMessage(entries);
			omittedInDelivery = new Set(omittedLaunchIds(entries));
			pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
		},
		// Retried at each idle flush; when the bound is spent the result is still collectable with subagent_wait.
		onDeliveryFailed: ({ id }) => {
			try {
				if (parentCtx?.hasUI) parentCtx.ui.notify(`brigadev: could not deliver the result of async subagent launch ${id}; collect it with subagent_wait {"runId":"${id}"}`, "warning");
			} catch {
				// A stale context: nobody to tell.
			}
		},
	});
	registry.subscribe((event) => {
		if (event.type === "settle") delivery.settled(event);
	});

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

	// Footer: `agents: 2 running · 3 done · alt+a`, counted across sync and async launches. Done follows the card's lifetime.
	const syncStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		try {
			ctx.ui.setStatus(STATUS_KEY, formatStatus(statusCounts(launches.keys(), runs, Date.now()), VIEWER_KEY));
		} catch {
			// A stale context (session replaced): the new session sets its own status.
		}
	};

	const showCard = (ctx: ExtensionContext) => {
		// The side panel reads copies; the runs below keep mutating while they work.
		panelState().publish("agents", runs.map((r) => ({ ...r })));
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
		parentCtx = ctx;
		// Launches left from a previous session in this process are stopped and forgotten, with any result held for them.
		delivery.reset();
		registry.clear();
		runs = [];
		launches.clear();
		controls.clear();
		settled = [];
		epoch++;
		showCard(ctx);
		// Run folders hold full transcripts: keep 14 days and at most 200 (lib/run-artifacts.ts). Never fails the session.
		try {
			pruneRunFolders(repoDocsDir(ctx.cwd));
		} catch {
			// Retention is housekeeping, not part of starting a session.
		}
	});
	// Children (async and sync) get SIGTERM, and are given KILL_GRACE_MS + 1 s to settle; a group still alive then is
	// SIGKILLed before this returns, so no child or grandchild outlives the parent. The wait is bounded: shutdown cannot hang.
	pi.on("session_shutdown", async () => {
		// Aborted children settle after this; their results must not be sent to a session that is going away.
		delivery.stop();
		registry.abortAll();
		stopTimers();
		await liveChildren.shutdown({ graceMs: KILL_GRACE_MS + SHUTDOWN_SLACK_MS, setTimer: (fn, ms) => setTimeout(fn, ms), clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout) });
	});

	pi.registerShortcut(CARD_COLLAPSE_KEY, {
		description: "Collapse or expand the brigadev agents card",
		handler: async (ctx) => {
			cardCollapsed = !cardCollapsed;
			showCard(ctx);
		},
	});

	// The parent is idle for good (not between retries or queued continuations): deliver what settled meanwhile.
	pi.on("agent_settled", async (_event, ctx) => {
		parentCtx = ctx;
		delivery.flush();
	});

	pi.registerMessageRenderer<ResultMessageDetails>(RESULT_MESSAGE_TYPE, (message, { expanded, outputPad, keyHint }, theme) => {
		const content = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const card = resultCard(content, message.details, expanded);
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		card.lines.forEach((line, i) => {
			box.addChild({ render: (width: number) => [theme.fg(line.tone, i === 0 ? theme.bold(truncateToWidth(line.text, Math.max(1, width), "…")) : truncateToWidth(line.text, Math.max(1, width), "…"))], invalidate: () => {} });
		});
		if (expanded) box.addChild(new Markdown(card.body, 0, 0, getMarkdownTheme()));
		else if (card.hidden > 0) box.addChild(new Text(theme.fg("muted", `  (${keyHint("app.tools.expand", "to expand")})`), 0, 0));
		return box;
	});

	pi.on("before_agent_start", async (event) => {
		skills = (event.systemPromptOptions.skills ?? []).map((s) => ({ name: s.name, filePath: s.filePath }));
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run a focused brigadev agent in its own context, only for a named delegation trigger. Single: agent, task, reason. Parallel: tasks[]. Writers need allowedEditSurfaces.",
		parameters: Params,

		async execute(_id, params, signal, onUpdate, ctx) {
			parentCtx = ctx;
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
			const problems = resolved.flatMap(({ request, agent }, i) => admitLaunch(request, agent, agents).map((p) => (requests.length > 1 ? `task ${i + 1}: ${p}` : p)));
			problems.push(...writerConflicts(resolved.filter((r) => r.agent).map((r) => ({ agent: r.agent!, surfaces: r.request.allowedEditSurfaces ?? [] })), activeWriters));

			// Model routing: session profile > default profile > agent definition > this session's model.
			const { file } = readProfiles();
			const profile = effectiveProfile(file, ctx.sessionManager.getBranch());
			const parent = { model: currentModelRef(ctx), thinking: ctx.thinkingLevel };
			const catalog = modelCatalog(ctx);
			const routes = resolved.map(({ agent }) => (agent ? resolveAgentRoute({ profile: profile.profile, agent, parent }) : undefined));
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
			// The launch body, shared by both modes: validation is done, so everything from here on runs the children.
			const tasks: LaunchTask[] = resolved.map(({ request, agent }, i) => ({ request, agent: agent!, route: routes[i]!, routeLabel: routeLabel(routes[i]!, profile.name) }));
			const launch = (signal: AbortSignal | undefined, hooks: LaunchHooks) => {
				const price = costCalculator(ctx);
				const exec = (command: string, args: string[], options: { cwd: string; timeout: number }) => pi.exec(command, args, options);

				// Agents card rows, one per task that got a slot.
				const cards = new Map<number, AgentRun>();
				const id = launchSeq++;
				const syncCard = (cardRun: AgentRun, r: RunResult) => {
					cardRun.tokens = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
					cardRun.cost = r.usage.cost;
					if (r.model) cardRun.model = r.model;
				};
				const view: TaskView = {
					start(index, info) {
						const cardRun: AgentRun = { id: randomUUID().slice(0, 8), agent: info.agent, task: info.task, state: "running", model: info.model, thinking: info.thinking, tokens: 0, cost: 0, startedAt: info.startedAt };
						cards.set(index, cardRun);
						runs.push(cardRun);
						showCard(ctx);
						repaintViewer?.();
					},
					attempt(index, result) {
						const cardRun = cards.get(index)!;
						Object.assign(cardRun, { model: result.model, thinking: result.thinking });
						repaintViewer?.();
					},
					update(index, partial) {
						const cardRun = cards.get(index)!;
						syncCard(cardRun, partial);
						repaintViewer?.();
					},
					finish(index, result) {
						const cardRun = cards.get(index)!;
						syncCard(cardRun, result);
						cardRun.state = failed(result) || result.exitCode === -1 ? "failed" : "done";
						cardRun.endedAt = Date.now();
						showCard(ctx);
						repaintViewer?.();
					},
					control(index, control) {
						const key = `${id}:${index}`;
						if (control) controls.set(key, control);
						else controls.delete(key);
						repaintViewer?.();
					},
				};

				const launchEpoch = epoch;
				launches.set(results, id);
				syncStatus(ctx);
				repaintViewer?.();

				return runLaunch(
					{ mode, tasks, results, signal, hooks },
					{
						slots,
						runAgent: (call) =>
							runChild(
								{ cwd: ctx.cwd, agent: tasks[call.index].agent, request: tasks[call.index].request, taskText: call.taskText, route: call.route, routeLabel: call.routeLabel, schema: schemas[call.index], price, signal: call.signal, onUpdate: call.onUpdate, onControl: call.onControl },
								{ piInvocation },
							),
						skills: () => skills,
						// The primary, then the profile's fallbacks, with cooling or out-of-quota models moved behind usable ones.
						chain: (index): FallbackStep[] => {
							const { route, agent } = tasks[index];
							return route.model
								? launchOrder({ model: route.model, thinking: route.thinking }, routeFor(profile.profile, agent.name)?.entry.fallbacks ?? [], (m) => blockedReason(m, Date.now()) !== undefined)
								: [{ model: route.model, thinking: route.thinking }];
						},
						coolModel: (model, category) => fallbackState().cooldowns.cool(model, Date.now() + cooldownMs(category)),
						fallbackNotice: ({ agent, from, to, category }) => {
							pi.appendEntry("brigadev-fallback", { agent, from, to, category });
							if (ctx.hasUI) ctx.ui.notify(`brigadev: ${agent} hit ${category} on ${from} → retrying on ${to}${priceNote(listPrice(ctx, from), listPrice(ctx, to))}`, "warning");
						},
						writers: {
							list: () => activeWriters,
							onAdd: (listener) => (writerListeners.add(listener), () => void writerListeners.delete(listener)),
							add: (writers) => {
								activeWriters.push(...writers);
								writerListeners.forEach((listener) => listener(writers));
							},
							remove: (writer) => {
								const at = activeWriters.indexOf(writer);
								if (at >= 0) activeWriters.splice(at, 1);
							},
						},
						view,
						snapshot: () => takeSnapshot(exec, canonicalPath(ctx.cwd)),
					},
				).finally(() => {
					// Whatever way the launch ended: no child of it can be steered any more.
					results.forEach((_, i) => controls.delete(`${id}:${i}`));
					// It no longer counts as running, its rows settle, and its runs stay viewable.
					if (launchEpoch !== epoch) return;
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
				});
			};

			if (!params.async) return toResult(mode, await launch(signal, { onUpdate: onUpdate as LaunchHooks["onUpdate"], tolerateAbort: false }));

			// Async: the launch runs under the registry's own AbortController (the tool call's signal ends with the call).
			// Admission errors were already returned above, before anything started.
			const id = registry.start({ total: results.length, run: async (runSignal, control) => toResult(mode, await launch(runSignal, { onProgress: control.progress, tolerateAbort: true, async: true })) });
			const names = [...new Set(requests.map((r) => r.agent))].join(", ");
			return {
				content: [{ type: "text", text: `Started async launch ${id} (${results.length} task${results.length === 1 ? "" : "s"}: ${names}). Collect it with subagent_wait {"runId":"${id}"}; stop it with subagent_cancel.` }],
				details: { mode, results: results.map((r) => ({ ...r })), launchId: id, pending: true } as Details,
			};
		},

		renderCall(args, theme) {
			const launches = args.tasks?.length ? args.tasks : [{ agent: args.agent ?? "...", task: args.task ?? "", reason: args.reason ?? "" }];
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", launches.length > 1 ? `parallel (${launches.length})` : launches[0].agent) + (args.async ? theme.fg("muted", " async") : "");
			for (const l of launches.slice(0, 4)) {
				const preview = l.task.length > 60 ? `${l.task.slice(0, 60)}…` : l.task;
				text += `\n  ${launches.length > 1 ? `${theme.fg("accent", l.agent)} ` : ""}${theme.fg("dim", preview)}`;
				if (l.reason) text += theme.fg("muted", ` — ${l.reason}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, context) {
			const details = result.details as Details | undefined;
			// An async launch's immediate return shows its text (launch id, how to collect), not rows that would never update.
			if (!details?.results.length || details.pending) {
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

	/** What `subagent_wait` / `subagent_cancel` answer for each registry outcome. */
	const collected = (id: string, outcome: WaitOutcome<LaunchResult>, waitedSeconds?: number): LaunchResult => {
		const text = (t: string, isError?: boolean): LaunchResult => ({ content: [{ type: "text", text: t }], details: { mode: "single", results: [], launchId: id, pending: true }, ...(isError ? { isError } : {}) });
		if (outcome.status === "unknown") return text(`Unknown launch id "${id}" (not started in this session, or pruned).`, true);
		if (outcome.status === "running") {
			const { done, total } = outcome.launch;
			return text(`Launch ${id} still running: ${done}/${total} done${waitedSeconds === undefined ? "" : ` after ${waitedSeconds}s`}. Call subagent_wait again, or subagent_cancel.`);
		}
		if (outcome.error !== undefined || !outcome.result) return text(`Launch ${id} failed: ${outcome.error ?? "no result"}`, true);
		return { ...outcome.result, details: { ...outcome.result.details, launchId: id } };
	};

	/** The idle delivery already put this result in the session: point at the saved folders instead of repeating it (wait and cancel alike). */
	const deliveredResult = (id: string, outcome: WaitOutcome<LaunchResult>): LaunchResult | undefined => {
		const note = deliveredNote(id, outcome);
		return note === undefined ? undefined : ({ content: [{ type: "text", text: note }], details: { mode: "single", results: [], launchId: id, pending: true } } as LaunchResult);
	};

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent wait",
		description: `Wait for an async subagent launch (default ${WAIT_DEFAULT_SECONDS}s, max ${WAIT_MAX_SECONDS}s). Returns its result, or its progress if still running.`,
		parameters: WaitParams,
		async execute(_id, params, signal) {
			const seconds = Math.min(WAIT_MAX_SECONDS, Math.max(1, params.timeoutSeconds ?? WAIT_DEFAULT_SECONDS));
			const outcome = await registry.wait(params.runId, seconds * 1000, signal);
			return deliveredResult(params.runId, outcome) ?? collected(params.runId, outcome, seconds);
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent cancel",
		description: "Cancel an async subagent launch; returns the partial results.",
		parameters: CancelParams,
		async execute(_id, params) {
			const outcome = await registry.cancel(params.runId);
			return deliveredResult(params.runId, outcome) ?? collected(params.runId, outcome);
		},
	});

	/** Every run: those this process tracks (queued, running, and settled since the session started, async ones included) plus the finished ones recorded on this branch. */
	const viewerEntries = (ctx: ExtensionContext) => {
		const tracked: TrackedRun[] = [...settled];
		for (const [results, id] of launches) results.forEach((result, i) => tracked.push({ id: `${id}:${i}`, result }));
		const recorded: RecordedRun[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || !VIEWER_TOOLS.has(entry.message.toolName)) continue;
			const details = entry.message.details as Details | undefined;
			// An async launch's immediate return (and a timed-out wait) holds placeholders, not final results.
			if (details?.pending) continue;
			const at = Date.parse(entry.timestamp);
			for (const result of details?.results ?? []) recorded.push({ result, at });
		}
		return buildEntries({ tracked, recorded, now: Date.now() });
	};

	const openViewer = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("The Agents viewer needs the interactive UI", "error");
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const painter = themePainter(theme);
			let selection: Selection = { key: undefined, index: 0 };
			let view = scrollView.initial();
			let detailOnly = false;
			// Takeover: the open input line (steer / follow up), and a one-line result shown in the footer until the next key.
			let takeover: TakeoverState | undefined;
			let notice: string | undefined;
			// `x` pressed once on a run: a second one within 3 s aborts it (pure state in lib/subagent-viewer.ts).
			let armed: AbortArm | undefined;
			let closed = false;
			// What the user typed goes to the child as an RPC steer while it is streaming, as a follow_up between turns.
			const sendTakeover = (key: string, text: string): string => {
				const control = controls.get(key);
				if (!control) return "Not sent: the run has finished";
				const kind = takeoverKind(control.isStreaming());
				// The notice reports Pi's answer to this command (matched by id), not that the write succeeded.
				const answer = kind === "steer" ? control.steer(text) : control.followUp(text);
				void answer.then((outcome) => {
					if (closed) return;
					notice = takeoverNotice(kind, outcome);
					tui.requestRender();
				});
				return kind === "steer" ? "Steering message sent, waiting for Pi…" : "Follow-up sent, waiting for Pi…";
			};
			// The list changes while the viewer is open: repaint on every progress update, and once a second so elapsed times tick.
			repaintViewer = () => tui.requestRender();
			const timer = setInterval(() => tui.requestRender(), 1000);
			const close = () => {
				closed = true;
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
					notice = undefined;
					if (takeover && !controls.has(takeover.key)) [takeover, notice] = [undefined, "The run finished"];
					// Only an `x` on the same run, within the timeout, completes an abort; any other key disarms it.
					armed = takeover || data !== "x" ? undefined : abortArmFor(armed, entry?.key, Date.now());
					if (takeover) {
						// The input line owns every key until Enter or Esc, so j/k/q/x are typed, not commands.
						const typed = printableText(data);
						const key: TakeoverKey | undefined = matchesKey(data, Key.enter)
							? { kind: "submit" }
							: matchesKey(data, Key.escape)
								? { kind: "cancel" }
								: matchesKey(data, Key.backspace)
									? { kind: "backspace" }
									: matchesKey(data, "ctrl+u")
										? { kind: "clear" }
										: typed !== undefined
											? { kind: "text", text: typed }
											: undefined;
						if (key) {
							const open = takeover;
							const step = takeoverKey(open, key);
							takeover = step.state;
							if (step.submit !== undefined) notice = sendTakeover(open.key, step.submit);
						}
						return tui.requestRender();
					}
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
					else if (matchesKey(data, Key.enter)) {
						takeover = openTakeover(entry, entry !== undefined && controls.has(entry.key));
						if (!takeover) notice = "Only a running agent can be steered";
					} else if (data === "x") {
						const control = entry && controls.get(entry.key);
						if (!canTakeOver(entry, control !== undefined)) notice = "Only a running agent can be aborted";
						else {
							const press = pressAbort(armed, entry.key, Date.now());
							armed = press.armed;
							if (press.abort) notice = control?.abort() ? "Abort sent" : "Only a running agent can be aborted";
						}
					}
					tui.requestRender();
				},
				render(width: number): string[] {
					const entries = viewerEntries(ctx);
					selection = resolveSelection(entries, selection);
					const entry = entries[selection.index];
					const detail = entryDetail(entry, detailWidth(width), home);
					if (takeover && !controls.has(takeover.key)) [takeover, notice] = [undefined, "The run finished"];
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
							footer: takeover ? takeoverFooter(takeover, takeoverKind(controls.get(takeover.key)?.isStreaming() ?? false), width) : (notice ?? (abortArmFor(armed, entry?.key, Date.now()) ? ABORT_PROMPT : viewerFooter(canTakeOver(entry, entry !== undefined && controls.has(entry.key))))),
						},
						painter,
					);
				},
			};
		}, FULLSCREEN_OVERLAY);
	};

	pi.registerCommand("brigadev:runs", { description: "Agents viewer: every subagent run in this session with its thread", handler: async (_args, ctx) => openViewer(ctx) });
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
