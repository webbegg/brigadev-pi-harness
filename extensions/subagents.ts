/**
 * brigadev subagents: focused agents with isolated context, each in its own
 * `pi --mode json -p` process. Adapted from Pi's official subagent example.
 *
 * Adds the brigadev delegation contract on top: every launch names its
 * reason, the verifier needs a named risk item, writers need disjoint
 * allowed edit surfaces, and requirements travel by reference.
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { agentsCard, FINISHED_TTL_MS, formatElapsed, visibleRuns, type AgentRun, type RunState } from "../lib/agents-card.ts";
import { threadRows } from "../lib/agent-thread.ts";
import { queuedFields, runState, subagentRow, syncRowTimer, type RowInput, type RowTimerState } from "../lib/subagent-row.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { listWidth, maxScroll, renderTwoPane, type Row } from "../lib/two-pane.ts";
import { emptyTally, formatCost, formatTokens } from "../lib/cost.ts";
import { failed, output, runChild, type RunResult } from "../lib/child-run.ts";
import { newRunId } from "../lib/run-artifacts.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { runLaunch, toResult, type Details, type FallbackStep, type LaunchHooks, type LaunchResult, type LaunchTask, type TaskView } from "../lib/subagent-launch.ts";
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
const STATUS_KEY = "brigadev-agents";
const CARD_KEY = "brigadev-agents-card";
const CARD_COLLAPSE_KEY = "ctrl+shift+a";
const VIEWER_KEY = "alt+a";
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

	let skills: SkillRef[] = [];
	const activeWriters: ActiveWriter[] = [];
	let running = 0;

	// One concurrency cap for every launch in this process, sync or async.
	const slots = createSemaphore(MAX_CONCURRENCY);
	// Async launches: each runs under its own AbortController, collected by subagent_wait / subagent_cancel.
	const registry = createSubagentRegistry<LaunchResult>({
		setTimer: (fn, ms) => setTimeout(fn, ms),
		clearTimer: (handle) => clearTimeout(handle as NodeJS.Timeout),
		newId: () => newRunId("launch"),
	});

	// Agents card: live rows above the editor while subagents run.
	let runs: AgentRun[] = [];
	// Live results by card run id, for the Agents viewer while a run is in flight.
	const liveResults = new Map<string, RunResult>();
	let cardCollapsed = false;
	// True while the agents card widget is installed (collapsed or not).
	let widgetShown = false;
	let renderCard: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let expiry: ReturnType<typeof setTimeout> | undefined;

	const stopTimers = () => {
		if (ticker) clearInterval(ticker);
		if (expiry) clearTimeout(expiry);
		ticker = expiry = undefined;
	};

	// The footer count duplicates the card, so it only shows while the card does not.
	const syncStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, running > 0 && !widgetShown ? `◐ ${running} agent${running === 1 ? "" : "s"}` : undefined);
	};

	const showCard = (ctx: ExtensionContext) => {
		// The side panel reads copies; the runs below keep mutating while they work.
		panelState().publish("agents", runs.map((r) => ({ ...r })));
		if (!ctx.hasUI) return;
		if (visibleRuns(runs, Date.now()).length === 0) {
			stopTimers();
			renderCard = undefined;
			widgetShown = false;
			ctx.ui.setWidget(CARD_KEY, undefined);
			syncStatus(ctx);
			return;
		}
		if (!renderCard) {
			widgetShown = true;
			syncStatus(ctx);
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
		// Tick the elapsed column while work runs; drop finished rows after their TTL.
		const anyRunning = runs.some((r) => r.state === "running");
		if (anyRunning && !ticker) ticker = setInterval(() => renderCard?.(), 1000);
		if (!anyRunning) {
			if (ticker) clearInterval(ticker);
			ticker = undefined;
			if (expiry) clearTimeout(expiry);
			expiry = setTimeout(() => showCard(ctx), FINISHED_TTL_MS + 100);
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		// Launches left from a previous session in this process are stopped and forgotten.
		registry.clear();
		runs = [];
		showCard(ctx);
	});
	// Children of running async launches get the usual SIGTERM, then SIGKILL after 5 s.
	pi.on("session_shutdown", async () => {
		registry.abortAll();
		stopTimers();
	});

	pi.registerShortcut(CARD_COLLAPSE_KEY, {
		description: "Collapse or expand the brigadev agents card",
		handler: async (ctx) => {
			cardCollapsed = !cardCollapsed;
			showCard(ctx);
		},
	});

	const setRunning = (ctx: ExtensionContext, delta: number) => {
		running += delta;
		syncStatus(ctx);
	};

	pi.on("before_agent_start", async (event) => {
		skills = (event.systemPromptOptions.skills ?? []).map((s) => ({ name: s.name, filePath: s.filePath }));
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: "Run a focused brigadev agent in its own context, only for a named delegation trigger. Single: agent, task, reason. Parallel: tasks[]. Writers need allowedEditSurfaces.",
		parameters: Params,

		async execute(_id, params, signal, onUpdate, ctx) {
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
				const syncCard = (cardRun: AgentRun, r: RunResult) => {
					cardRun.tokens = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
					cardRun.cost = r.usage.cost;
					if (r.model) cardRun.model = r.model;
				};
				const view: TaskView = {
					start(index, info) {
						setRunning(ctx, 1);
						const cardRun: AgentRun = { id: randomUUID().slice(0, 8), agent: info.agent, task: info.task, state: "running", model: info.model, thinking: info.thinking, tokens: 0, cost: 0, startedAt: info.startedAt };
						cards.set(index, cardRun);
						runs.push(cardRun);
						showCard(ctx);
						liveResults.set(cardRun.id, results[index]);
					},
					attempt(index, result) {
						const cardRun = cards.get(index)!;
						Object.assign(cardRun, { model: result.model, thinking: result.thinking });
						liveResults.set(cardRun.id, result);
					},
					update(index, partial) {
						const cardRun = cards.get(index)!;
						liveResults.set(cardRun.id, partial);
						syncCard(cardRun, partial);
					},
					finish(index, result) {
						const cardRun = cards.get(index)!;
						syncCard(cardRun, result);
						cardRun.state = failed(result) || result.exitCode === -1 ? "failed" : "done";
						cardRun.endedAt = Date.now();
						liveResults.delete(cardRun.id);
						showCard(ctx);
						setRunning(ctx, -1);
					},
				};

				return runLaunch(
					{ mode, tasks, results, signal, hooks },
					{
						slots,
						runAgent: (call) =>
							runChild(
								{ cwd: ctx.cwd, agent: tasks[call.index].agent, request: tasks[call.index].request, taskText: call.taskText, route: call.route, routeLabel: call.routeLabel, schema: schemas[call.index], price, signal: call.signal, onUpdate: call.onUpdate },
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
							add: (writers) => void activeWriters.push(...writers),
							remove: (writer) => {
								const at = activeWriters.indexOf(writer);
								if (at >= 0) activeWriters.splice(at, 1);
							},
						},
						view,
						snapshot: () => takeSnapshot(exec, canonicalPath(ctx.cwd)),
					},
				);
			};

			if (!params.async) return toResult(mode, await launch(signal, { onUpdate: onUpdate as LaunchHooks["onUpdate"], tolerateAbort: false }));

			// Async: the launch runs under the registry's own AbortController (the tool call's signal ends with the call).
			// Admission errors were already returned above, before anything started.
			const id = registry.start({ total: results.length, run: async (runSignal, control) => toResult(mode, await launch(runSignal, { onProgress: control.progress, tolerateAbort: true })) });
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

	pi.registerTool({
		name: "subagent_wait",
		label: "Subagent wait",
		description: `Wait for an async subagent launch (default ${WAIT_DEFAULT_SECONDS}s, max ${WAIT_MAX_SECONDS}s). Returns its result, or its progress if still running.`,
		parameters: WaitParams,
		async execute(_id, params, signal) {
			const seconds = Math.min(WAIT_MAX_SECONDS, Math.max(1, params.timeoutSeconds ?? WAIT_DEFAULT_SECONDS));
			return collected(params.runId, await registry.wait(params.runId, seconds * 1000, signal), seconds);
		},
	});

	pi.registerTool({
		name: "subagent_cancel",
		label: "Subagent cancel",
		description: "Cancel an async subagent launch; returns the partial results.",
		parameters: CancelParams,
		async execute(_id, params) {
			return collected(params.runId, await registry.cancel(params.runId));
		},
	});

	interface ViewerRun {
		result: RunResult;
		state: "running" | "done" | "failed";
		startedAt?: number;
		elapsed?: string;
	}

	/** Runs in flight plus every finished run recorded on this branch, newest first. */
	const viewerRuns = (ctx: ExtensionContext): ViewerRun[] => {
		const finished: ViewerRun[] = [];
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message" || entry.message.role !== "toolResult" || !VIEWER_TOOLS.has(entry.message.toolName)) continue;
			const details = entry.message.details as Details | undefined;
			// An async launch's immediate return (and a timed-out wait) holds placeholders, not final results.
			if (details?.pending) continue;
			const at = Date.parse(entry.timestamp);
			for (const result of details?.results ?? []) finished.push({ result, state: failed(result) ? "failed" : "done", startedAt: at });
		}
		const live: ViewerRun[] = runs
			.filter((r) => r.state === "running" && liveResults.has(r.id))
			.map((r) => ({ result: liveResults.get(r.id)!, state: "running", startedAt: r.startedAt, elapsed: formatElapsed(Date.now() - r.startedAt) }));
		return [...live, ...finished.reverse()];
	};

	const openViewer = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("The Agents viewer needs the interactive UI", "error");
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const painter = themePainter(theme);
			let selected = 0;
			let scroll = 0;
			let detailOnly = false;
			let follow = true;
			// Live runs stream new messages; repaint while the viewer is open.
			const timer = setInterval(() => tui.requestRender(), 1000);
			const close = () => {
				clearInterval(timer);
				done();
			};
			const glyph = { running: "◐", done: "✓", failed: "✗" } as const;
			const tone = { running: "accent", done: "success", failed: "error" } as const;

			const detailFor = (run: ViewerRun | undefined, width: number): Row[] => {
				if (!run) return [];
				const r = run.result;
				const u = r.usage;
				const header = [
					`${r.agent} · ${run.state}${run.elapsed ? ` · ${run.elapsed}` : ""}`,
					`${r.model ?? "?"}${r.thinking ? ` · ${r.thinking}` : ""}${r.route ? ` · ${r.route}` : ""}`,
					`${u.turns} turns · ↑${formatTokens(u.input + u.cacheRead + u.cacheWrite)} ↓${formatTokens(u.output)} · ${formatCost(u.cost)}`,
					`task: ${r.task.split("\n")[0]}`,
				];
				const rows = threadRows(header, r.messages, width);
				if (run.state === "failed" && (r.errorMessage || r.stderr)) rows.push({ text: `error: ${(r.errorMessage || r.stderr).split("\n")[0]}`, tone: "error" });
				return rows;
			};

			return {
				invalidate() {},
				handleInput(data: string) {
					const list = viewerRuns(ctx);
					const bodyHeight = Math.max(1, tui.terminal.rows - 3);
					const width = tui.terminal.columns;
					const detail = detailFor(list[selected], detailOnly ? width - 2 : width - listWidth(width) - 4);
					if (matchesKey(data, Key.escape) || data === "q") return close();
					if (matchesKey(data, Key.down) || data === "j") [selected, scroll, follow] = [Math.min(list.length - 1, selected + 1), 0, true];
					else if (matchesKey(data, Key.up) || data === "k") [selected, scroll, follow] = [Math.max(0, selected - 1), 0, true];
					else if (matchesKey(data, Key.pageDown) || data === " " || data === "J") [scroll, follow] = [Math.min(maxScroll(detail.length, bodyHeight), scroll + 10), false];
					else if (matchesKey(data, Key.pageUp) || data === "K") [scroll, follow] = [Math.max(0, scroll - 10), false];
					else if (data === "g") [scroll, follow] = [0, false];
					else if (data === "G") [scroll, follow] = [maxScroll(detail.length, bodyHeight), true];
					else if (data === "F") detailOnly = !detailOnly;
					tui.requestRender();
				},
				render(width: number): string[] {
					const list = viewerRuns(ctx);
					selected = Math.min(selected, Math.max(0, list.length - 1));
					const run = list[selected];
					const detail = detailFor(run, detailOnly ? width - 2 : width - listWidth(width) - 4);
					const bodyHeight = Math.max(1, tui.terminal.rows - 3);
					// A running thread follows its newest lines until the user scrolls.
					if (follow && run?.state === "running") scroll = maxScroll(detail.length, bodyHeight);
					const running = list.filter((r) => r.state === "running").length;
					return renderTwoPane(
						{
							width,
							height: tui.terminal.rows,
							title: `Agents · ${running} running · ${list.length - running} finished`,
							list: list.map((r) => ({ text: `${glyph[r.state]} ${r.result.agent} · ${r.result.task.split("\n")[0]}`, tone: tone[r.state] })),
							selected,
							detail,
							detailScroll: scroll,
							detailOnly,
							empty: "No subagent runs in this session yet",
							footer: "j/k run · space/J/K scroll · g/G top/end · F thread only · q close",
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
