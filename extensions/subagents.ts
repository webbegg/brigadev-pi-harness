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
import { Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentDefinition } from "../lib/agents.ts";
import { addUsage, emptyTally, formatCost, formatTokens, priceBridgeMessage, type CostCalculator, type Tally } from "../lib/cost.ts";
import { admitLaunch, buildChildTask, writerConflicts, type ActiveWriter, type LaunchRequest, type SkillRef } from "../lib/delegation.ts";
import { resolveAgentRoute, resolveModelRef, type ResolvedRoute } from "../lib/model-routing.ts";
import { costCalculator, currentModelRef, loadAgents, modelCatalog } from "../lib/pi-adapters.ts";
import { effectiveProfile, readProfiles } from "../lib/profiles-store.ts";
import { CHILD_ENV, GUARD_EXTENSION_PATH, isChildSession } from "../lib/runtime.ts";

const MAX_PARALLEL_TASKS = 8;
const MAX_CONCURRENCY = 4;
const PER_TASK_OUTPUT_CAP = 50 * 1024;
const COLLAPSED_ITEMS = 6;
const STATUS_KEY = "brigadev-agents";

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

		const env: NodeJS.ProcessEnv = {
			...process.env,
			[CHILD_ENV.CHILD]: "1",
			[CHILD_ENV.AGENT]: agent.name,
			[CHILD_ENV.PROJECT_ROOT]: options.cwd,
			[CHILD_ENV.READ_ONLY]: agent.writer ? "0" : "1",
		};
		if (agent.writer && request.allowedEditSurfaces) env[CHILD_ENV.ALLOWED_SURFACES] = JSON.stringify(request.allowedEditSurfaces);
		else delete env[CHILD_ENV.ALLOWED_SURFACES];

		let aborted = false;
		result.exitCode = await new Promise<number>((resolveExit) => {
			const invocation = piInvocation(args);
			const proc = spawn(invocation.command, invocation.args, { cwd: options.cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
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

const LaunchSchema = {
	agent: Type.String({ description: "Agent name (see /brigadev:agents)" }),
	task: Type.String({ description: "What to do. Pass requirements by reference (featureDoc) or the user's request verbatim; never paraphrase specs." }),
	reason: Type.String({ description: 'Delegation trigger, e.g. "evidence budget", "independent units", "context backstop", or "Risk: item N (why)" for the verifier.' }),
	allowedEditSurfaces: Type.Optional(Type.Array(Type.String(), { description: "Writers only: narrow repository-relative paths/globs the agent may edit. Never '.' or absolute." })),
	featureDoc: Type.Optional(Type.String({ description: "Repository-relative ODD feature document the agent reads until ## Log." })),
	skills: Type.Optional(Type.Array(Type.String(), { description: "Skill names the agent must read before work; resolved to exact SKILL.md paths." })),
};

const Params = Type.Object({
	agent: Type.Optional(LaunchSchema.agent),
	task: Type.Optional(LaunchSchema.task),
	reason: Type.Optional(LaunchSchema.reason),
	allowedEditSurfaces: LaunchSchema.allowedEditSurfaces,
	featureDoc: LaunchSchema.featureDoc,
	skills: LaunchSchema.skills,
	tasks: Type.Optional(Type.Array(Type.Object(LaunchSchema), { description: `Parallel launches (max ${MAX_PARALLEL_TASKS}). Use only for independent units.` })),
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

	const setRunning = (ctx: ExtensionContext, delta: number) => {
		running += delta;
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, running > 0 ? `⚙ ${running} agent${running === 1 ? "" : "s"}` : undefined);
	};

	pi.on("before_agent_start", async (event) => {
		skills = (event.systemPromptOptions.skills ?? []).map((s) => ({ name: s.name, filePath: s.filePath }));
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description: [
			"Delegate bounded work to a focused brigadev agent with an isolated context. Delegate only for a named reason; otherwise work inline.",
			"Single: {agent, task, reason, ...}. Parallel: {tasks: [...]} for independent units only.",
			"Writers need allowedEditSurfaces; the verifier needs 'Risk: item N' in reason. Results return to you; you stay accountable.",
		].join(" "),
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
							emit();
						},
					});
				} finally {
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
