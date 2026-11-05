/**
 * brigadev subagents: focused agents with isolated context, each in its own
 * `pi --mode json -p` process. Adapted from Pi's official subagent example.
 *
 * Adds the brigadev delegation contract on top: every launch names its
 * reason, the verifier needs a named risk item, writers need disjoint
 * allowed edit surfaces, and requirements travel by reference.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Key, Markdown, matchesKey, Spacer, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { agentsCard, FINISHED_TTL_MS, formatElapsed, visibleRuns, type AgentRun } from "../lib/agents-card.ts";
import { threadRows } from "../lib/agent-thread.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { listWidth, maxScroll, renderTwoPane, type Row } from "../lib/two-pane.ts";
import type { AgentDefinition } from "../lib/agents.ts";
import { addUsage, emptyTally, formatCost, formatTokens, priceBridgeMessage, type CostCalculator, type Tally } from "../lib/cost.ts";
import { admitLaunch, buildChildTask, writerConflicts, type ActiveWriter, type LaunchRequest, type SkillRef } from "../lib/delegation.ts";
import { resolveAgentRoute, resolveModelRef, type ResolvedRoute } from "../lib/model-routing.ts";
import { costCalculator, currentModelRef, loadAgents, modelCatalog } from "../lib/pi-adapters.ts";
import { effectiveProfile, readProfiles } from "../lib/profiles-store.ts";
import { canonicalPath } from "../lib/paths.ts";
import { CHILD_ENV, GUARD_EXTENSION_PATH, isChildSession } from "../lib/runtime.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const COLLAPSED_ITEMS = 6;
const STATUS_KEY = "brigadev-agents";
const CARD_KEY = "brigadev-agents-card";
const CARD_COLLAPSE_KEY = "ctrl+shift+a";
const VIEWER_KEY = "alt+a";

interface RunResult {
	agent: string;
	task: string;
	exitCode: number; // -1 while running
	messages: Message[];
	stderr: string;
	usage: Tally;
	model?: string;
	thinking?: string;
	/** Where the model came from: "profile:<name>/<key>", "definition", or "parent". */
	route?: string;
	stopReason?: string;
	errorMessage?: string;
}

interface Details {
	mode: "single" | "parallel";
	results: RunResult[];
}


function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) if (part.type === "text") return part.text;
	}
	return "";
}

const failed = (r: RunResult) => r.exitCode > 0 || r.stopReason === "error" || r.stopReason === "aborted";
const output = (r: RunResult) => (failed(r) ? r.errorMessage || r.stderr.trim() || finalText(r.messages) : finalText(r.messages)) || "(no output)";

function capOutput(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_TASK_OUTPUT_CAP) return text;
	let cut = text.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(cut, "utf8") > PER_TASK_OUTPUT_CAP) cut = cut.slice(0, -1);
	return `${cut}\n\n[Output truncated. Full output is in the tool details.]`;
}

function piInvocation(args: string[]): { command: string; args: string[] } {
	const script = process.argv[1];
	if (script && !script.startsWith("/$bunfs/root/") && fs.existsSync(script)) return { command: process.execPath, args: [script, ...args] };
	const exec = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(exec) ? { command: "pi", args } : { command: process.execPath, args };
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results: R[] = new Array(items.length);
	let next = 0;
	const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await fn(items[index], index);
		}
	});
	await Promise.all(workers);
	return results;
}

interface RunOptions {
	cwd: string;
	agent: AgentDefinition;
	request: LaunchRequest;
	taskText: string;
	route: ResolvedRoute;
	routeLabel: string;
	price: CostCalculator;
	signal?: AbortSignal;
	onUpdate: (result: RunResult) => void;
}

async function runAgent(options: RunOptions): Promise<RunResult> {
	const { agent, request } = options;
	const result: RunResult = { agent: agent.name, task: request.task, exitCode: -1, messages: [], stderr: "", usage: emptyTally() };

	const args = ["--mode", "json", "-p", "--no-session", "-e", GUARD_EXTENSION_PATH];
	const { model, thinking } = options.route;
	if (model) args.push("--model", model);
	if (thinking) args.push("--thinking", thinking);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));
	Object.assign(result, { model, thinking, route: options.routeLabel });

	const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "brigadev-agent-"));
	try {
		if (agent.systemPrompt.trim()) {
			const promptPath = path.join(tmpDir, "system.md");
			await fs.promises.writeFile(promptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
			args.push("--append-system-prompt", promptPath);
		}
		args.push(options.taskText);

		// One spelling of the working directory: an inherited PWD that differs
		// from the real cwd (macOS /tmp -> /private/tmp, a symlinked checkout)
		// shows the child two directories, and it then runs every lookup twice.
		const cwd = canonicalPath(options.cwd);
		const env: NodeJS.ProcessEnv = {
			...process.env,
			PWD: cwd,
			[CHILD_ENV.CHILD]: "1",
			[CHILD_ENV.AGENT]: agent.name,
			[CHILD_ENV.PROJECT_ROOT]: cwd,
			[CHILD_ENV.READ_ONLY]: agent.writer ? "0" : "1",
		};
		if (agent.writer && request.allowedEditSurfaces) env[CHILD_ENV.ALLOWED_SURFACES] = JSON.stringify(request.allowedEditSurfaces);
		else delete env[CHILD_ENV.ALLOWED_SURFACES];

		let aborted = false;
		result.exitCode = await new Promise<number>((resolveExit) => {
			const invocation = piInvocation(args);
			const proc = spawn(invocation.command, invocation.args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
			let buffer = "";

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: any;
				try {
					event = JSON.parse(line);
				} catch {
					return;
				}
				if (event.type === "message_end" && event.message) {
					// Bridge turns report $0; price them at list price (see lib/cost.ts).
					const msg = (priceBridgeMessage(event.message, options.price) ?? event.message) as Message;
					result.messages.push(msg);
					if (msg.role === "assistant") {
						addUsage(result.usage, msg.usage);
						if (msg.model) result.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
						if (msg.stopReason) result.stopReason = msg.stopReason;
						if (msg.errorMessage) result.errorMessage = msg.errorMessage;
					}
					options.onUpdate(result);
				}
			};

			proc.stdout.on("data", (data) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += data.toString();
			});
			proc.on("close", (code) => {
				if (buffer.trim()) processLine(buffer);
				resolveExit(code ?? 0);
			});
			proc.on("error", (error) => {
				result.stderr += String(error);
				resolveExit(1);
			});

			if (options.signal) {
				const kill = () => {
					aborted = true;
					proc.kill("SIGTERM");
					setTimeout(() => !proc.killed && proc.kill("SIGKILL"), 5000);
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});
		if (aborted) throw new Error("Subagent was aborted");
		return result;
	} finally {
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	}
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

function routeLabel(route: ResolvedRoute, profileName: string | undefined): string {
	if (route.profileKey && profileName) return `profile:${profileName}/${route.profileKey}`;
	return route.modelSource === "none" ? "pi default" : route.modelSource;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	let skills: SkillRef[] = [];
	const activeWriters: ActiveWriter[] = [];
	let running = 0;

	// Agents card: live rows above the editor while subagents run.
	let runs: AgentRun[] = [];
	// Live results by card run id, for the Agents viewer while a run is in flight.
	const liveResults = new Map<string, RunResult>();
	let cardCollapsed = false;
	let renderCard: (() => void) | undefined;
	let ticker: ReturnType<typeof setInterval> | undefined;
	let expiry: ReturnType<typeof setTimeout> | undefined;

	const stopTimers = () => {
		if (ticker) clearInterval(ticker);
		if (expiry) clearTimeout(expiry);
		ticker = expiry = undefined;
	};

	const showCard = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (visibleRuns(runs, Date.now()).length === 0) {
			stopTimers();
			renderCard = undefined;
			ctx.ui.setWidget(CARD_KEY, undefined);
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
		runs = [];
		showCard(ctx);
	});
	pi.on("session_shutdown", async () => stopTimers());

	pi.registerShortcut(CARD_COLLAPSE_KEY, {
		description: "Collapse or expand the brigadev agents card",
		handler: async (ctx) => {
			cardCollapsed = !cardCollapsed;
			showCard(ctx);
		},
	});

	const setRunning = (ctx: ExtensionContext, delta: number) => {
		running += delta;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, running > 0 ? `◐ ${running} agent${running === 1 ? "" : "s"}` : undefined);
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
			if (problems.length > 0) return reject(`Launch rejected by brigadev delegation rules:\n- ${problems.join("\n- ")}`);

			const results: RunResult[] = resolved.map(({ request }) => ({ agent: request.agent, task: request.task, exitCode: -1, messages: [], stderr: "", usage: emptyTally() }));
			const emit = () => {
				const done = results.filter((r) => r.exitCode !== -1).length;
				onUpdate?.({
					content: [{ type: "text", text: mode === "parallel" ? `${done}/${results.length} done` : finalText(results[0].messages) || "(running...)" }],
					details: { mode, results: [...results] },
				} as AgentToolResult<Details>);
			};

			const price = costCalculator(ctx);
			const warnings: string[] = [];

			await mapLimited(resolved, MAX_CONCURRENCY, async ({ request, agent }, index) => {
				const { text, missingSkills } = buildChildTask(request, agent!, skills);
				if (missingSkills.length) warnings.push(`${agent!.name}: unknown skills ${missingSkills.join(", ")}`);
				const writer: ActiveWriter | undefined = agent!.writer ? { id: randomUUID().slice(0, 8), agent: agent!.name, surfaces: request.allowedEditSurfaces ?? [] } : undefined;
				if (writer) activeWriters.push(writer);
				setRunning(ctx, 1);
				const cardRun: AgentRun = {
					id: randomUUID().slice(0, 8),
					agent: agent!.name,
					task: request.task.split("\n")[0],
					state: "running",
					model: routes[index]!.model,
					thinking: routes[index]!.thinking,
					tokens: 0,
					cost: 0,
					startedAt: Date.now(),
				};
				runs.push(cardRun);
				showCard(ctx);
				liveResults.set(cardRun.id, results[index]);
				const syncCard = (r: RunResult) => {
					cardRun.tokens = r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
					cardRun.cost = r.usage.cost;
					if (r.model) cardRun.model = r.model;
				};
				try {
					results[index] = await runAgent({
						cwd: ctx.cwd,
						agent: agent!,
						request,
						taskText: text,
						route: routes[index]!,
						routeLabel: routeLabel(routes[index]!, profile.name),
						price,
						signal,
						onUpdate: (partial) => {
							results[index] = partial;
							liveResults.set(cardRun.id, partial);
							syncCard(partial);
							emit();
						},
					});
				} finally {
					syncCard(results[index]);
					cardRun.state = failed(results[index]) || results[index].exitCode === -1 ? "failed" : "done";
					cardRun.endedAt = Date.now();
					liveResults.delete(cardRun.id);
					showCard(ctx);
					setRunning(ctx, -1);
					if (writer) activeWriters.splice(activeWriters.indexOf(writer), 1);
				}
				emit();
			});

			const details: Details = { mode, results };
			const warningText = warnings.length ? `\n\nWarnings: ${warnings.join("; ")}` : "";
			if (mode === "single") {
				const r = results[0];
				return { content: [{ type: "text", text: (failed(r) ? `Agent ${r.stopReason ?? "failed"}: ` : "") + output(r) + warningText }], details, isError: failed(r) };
			}
			const ok = results.filter((r) => !failed(r)).length;
			const sections = results.map((r) => `### [${r.agent}] ${failed(r) ? "failed" : "completed"}\n\n${capOutput(output(r))}`);
			return { content: [{ type: "text", text: `Parallel: ${ok}/${results.length} succeeded\n\n${sections.join("\n\n---\n\n")}${warningText}` }], details };
		},

		renderCall(args, theme) {
			const launches = args.tasks?.length ? args.tasks : [{ agent: args.agent ?? "...", task: args.task ?? "", reason: args.reason ?? "" }];
			let text = theme.fg("toolTitle", theme.bold("subagent ")) + theme.fg("accent", launches.length > 1 ? `parallel (${launches.length})` : launches[0].agent);
			for (const l of launches.slice(0, 4)) {
				const preview = l.task.length > 60 ? `${l.task.slice(0, 60)}…` : l.task;
				text += `\n  ${launches.length > 1 ? `${theme.fg("accent", l.agent)} ` : ""}${theme.fg("dim", preview)}`;
				if (l.reason) text += theme.fg("muted", ` — ${l.reason}`);
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Details | undefined;
			if (!details?.results.length) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "(no output)", 0, 0);
			}
			const container = new Container();
			for (const r of details.results) {
				const icon = r.exitCode === -1 ? theme.fg("warning", "⏳") : failed(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				container.addChild(new Text(`${icon} ${theme.fg("toolTitle", theme.bold(r.agent))} ${theme.fg("dim", formatUsage(r))}`, 0, 0));
				const calls = r.messages.flatMap((m) => (m.role === "assistant" ? m.content.filter((p) => p.type === "toolCall") : []));
				const shown = expanded ? calls : calls.slice(-COLLAPSED_ITEMS);
				for (const call of shown) {
					if (call.type !== "toolCall") continue;
					const preview = JSON.stringify(call.arguments);
					container.addChild(new Text(theme.fg("muted", "  → ") + theme.fg("accent", call.name) + theme.fg("dim", ` ${preview.length > 70 ? `${preview.slice(0, 70)}…` : preview}`), 0, 0));
				}
				if (failed(r) && r.errorMessage) container.addChild(new Text(theme.fg("error", `  ${r.errorMessage}`), 0, 0));
				if (expanded && r.exitCode !== -1) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(output(r).trim(), 0, 0, getMarkdownTheme()));
					container.addChild(new Spacer(1));
				}
			}
			if (!expanded) container.addChild(new Text(theme.fg("muted", "(Ctrl+O to expand)"), 0, 0));
			return container;
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
			if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== "subagent") continue;
			const details = entry.message.details as Details | undefined;
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
