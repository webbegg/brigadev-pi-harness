// The run loop of one subagent child process: spawn it (argv/env/stdio come from
// lib/child-launch.ts), fold its JSON lines into a run snapshot, capture stderr,
// watch for stalls, terminate on abort (SIGTERM, then SIGKILL after 5 s), check
// structured output, and save the attempt's folder. No Pi runtime imports: the
// spawn function, timers, Pi invocation, and cost calculator are injected, so a
// test drives it with a fake child.

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "./agents.ts";
import { foldChildEvent, parseChildLine } from "./child-events.ts";
import { childLaunch } from "./child-launch.ts";
import { emptyTally, priceBridgeMessage, type CostCalculator, type Tally } from "./cost.ts";
import type { LaunchRequest } from "./delegation.ts";
import type { ResolvedRoute } from "./model-routing.ts";
import { canonicalPath } from "./paths.ts";
import { repoDocsDir } from "./repo-docs.ts";
import { newRunId, writeRunArtifacts } from "./run-artifacts.ts";
import { createStallWatchdog, resolveStallTimeouts, stallMessage } from "./stall-watchdog.ts";
import { checkStructuredRun, formatStructured, type JsonSchema } from "./structured-output.ts";

/** Grace between SIGTERM and SIGKILL when a child ignores the terminate request. */
export const KILL_GRACE_MS = 5000;

export interface RunResult {
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
	/** True when the model came from the parent session (resolved route source), for the row's `↑`. */
	inherited?: boolean;
	/** Placeholder of a task that is waiting for a concurrency slot. */
	queued?: boolean;
	/** Settled without ever starting (aborted while queued). */
	cancelled?: boolean;
	/** Models that failed before this one, with the failure category. */
	fallbacks?: string[];
	/** Epoch ms when the run was launched (first attempt); drives the row's elapsed time. */
	startedAt?: number;
	/** Epoch ms when the run settled; set for aborted placeholders too. */
	endedAt?: number;
	stopReason?: string;
	errorMessage?: string;
	/** Validated structured_output payload, for agents that declare an output schema. */
	structured?: unknown;
	/** Id of this child attempt; names its saved folder (lib/run-artifacts.ts). */
	runId?: string;
	/** Folder holding task.md, transcript.json, and result.json for this attempt. */
	artifactsDir?: string;
}

export function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) if (part.type === "text") return part.text;
	}
	return "";
}

export const failed = (r: RunResult) => r.exitCode > 0 || r.stopReason === "error" || r.stopReason === "aborted";

/** What the parent is told for one run: the error, the structured payload, or the final text. */
export const output = (r: RunResult) =>
	(failed(r) ? r.errorMessage || r.stderr.trim() || finalText(r.messages) : r.structured !== undefined ? formatStructured(r.structured) : finalText(r.messages)) || "(no output)";

/** The part of a child process the run loop touches (node's ChildProcess fits). */
export interface ChildProcessLike {
	stdout: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	stderr: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	on(event: string, listener: (...args: any[]) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; stdio: ["ignore", "pipe", "pipe"] }) => ChildProcessLike;

export interface ChildRunDeps {
	/** Defaults to node:child_process spawn. */
	spawn?: SpawnFn;
	/** How to start `pi` (depends on how the parent was started). */
	piInvocation: (args: string[]) => { command: string; args: string[] };
	/** Parent environment for the child and the stall budgets; defaults to process.env. */
	env?: NodeJS.ProcessEnv;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	now?: () => number;
	/** Where the per-run temp folder is created; defaults to os.tmpdir(). */
	tmpRoot?: string;
	/** Repo docs folder for the saved run folder; defaults to repoDocsDir. */
	docsDir?: (cwd: string) => string;
}

export interface RunOptions {
	cwd: string;
	agent: AgentDefinition;
	request: LaunchRequest;
	taskText: string;
	route: ResolvedRoute;
	routeLabel: string;
	/** The agent's output schema, loaded and checked before launch. */
	schema?: JsonSchema;
	price: CostCalculator;
	signal?: AbortSignal;
	onUpdate: (result: RunResult) => void;
}

export async function runChild(options: RunOptions, deps: ChildRunDeps): Promise<RunResult> {
	const { agent, request } = options;
	const spawn = deps.spawn ?? (nodeSpawn as unknown as SpawnFn);
	const env = deps.env ?? process.env;
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
	const result: RunResult = { agent: agent.name, task: request.task, exitCode: -1, messages: [], stderr: "", usage: emptyTally(), runId: newRunId(agent.name) };

	const structured = Boolean(options.schema && agent.outputSchema);
	const { model, thinking } = options.route;
	Object.assign(result, { model, thinking, route: options.routeLabel, inherited: options.route.modelSource === "parent" });

	const tmpDir = await fs.promises.mkdtemp(path.join(deps.tmpRoot ?? os.tmpdir(), "brigadev-agent-"));
	try {
		let systemPromptPath: string | undefined;
		if (agent.systemPrompt.trim()) {
			systemPromptPath = path.join(tmpDir, "system.md");
			await fs.promises.writeFile(systemPromptPath, agent.systemPrompt, { encoding: "utf8", mode: 0o600 });
		}

		// One spelling of the working directory: an inherited PWD that differs
		// from the real cwd (macOS /tmp -> /private/tmp, a symlinked checkout)
		// shows the child two directories, and it then runs every lookup twice.
		const cwd = canonicalPath(options.cwd);
		// Argv, env and stdio for every child come from one pure function (lib/child-launch.ts).
		const launch = childLaunch({
			agent,
			allowedEditSurfaces: request.allowedEditSurfaces,
			route: options.route,
			structured,
			cwd,
			taskText: options.taskText,
			systemPromptPath,
			parentEnv: env,
		});

		let aborted = false;
		let stalled = false;
		result.exitCode = await new Promise<number>((resolveExit) => {
			const invocation = deps.piInvocation(launch.args);
			const proc = spawn(invocation.command, invocation.args, { cwd, env: launch.env, shell: false, stdio: launch.stdio });
			let buffer = "";
			let exited = false;
			let stallError = "";
			let killTimer: unknown;

			// SIGTERM now, SIGKILL after the grace period if the child has not exited by then.
			const terminate = () => {
				proc.kill("SIGTERM");
				killTimer ??= setTimer(() => !exited && proc.kill("SIGKILL"), KILL_GRACE_MS);
			};

			const watchdog = createStallWatchdog({
				...resolveStallTimeouts(env),
				setTimer,
				clearTimer,
				onStall: (info) => {
					stalled = true;
					result.stopReason = "error";
					stallError = stallMessage(info);
					result.errorMessage = stallError;
					terminate();
				},
			});
			watchdog.start();

			const processLine = (line: string) => {
				for (const event of parseChildLine(line)) {
					if (event.type === "tool_start") watchdog.toolStarted(event.id, `tool ${event.name}`);
					else if (event.type === "tool_end") watchdog.toolFinished(event.id, `result of ${event.name}`);
					else if (event.type === "activity") watchdog.activity(event.label);
					// Bridge turns report $0; price them at list price (see lib/cost.ts).
					else event.message = (priceBridgeMessage(event.message, options.price) ?? event.message) as Message;
					if (foldChildEvent(result, event)) options.onUpdate(result);
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
			proc.on("close", (code: number | null) => {
				exited = true;
				watchdog.stop();
				if (killTimer !== undefined) clearTimer(killTimer);
				if (buffer.trim()) processLine(buffer);
				// The child may report its own "aborted" on SIGTERM; the stall is the real cause.
				if (stalled) Object.assign(result, { stopReason: "error", errorMessage: stallError });
				resolveExit(stalled ? 1 : (code ?? 0));
			});
			proc.on("error", (error: unknown) => {
				exited = true;
				watchdog.stop();
				if (killTimer !== undefined) clearTimer(killTimer);
				result.stderr += String(error);
				resolveExit(1);
			});

			if (options.signal) {
				const kill = () => {
					aborted = true;
					terminate();
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});
		if (aborted) throw new Error("Subagent was aborted");
		if (structured && !failed(result)) {
			const check = checkStructuredRun(result.messages, options.schema!);
			if (check.ok) result.structured = check.value;
			else Object.assign(result, { stopReason: "error", errorMessage: check.error });
		}
		return result;
	} finally {
		saveArtifacts(options, result, deps);
		await fs.promises.rm(tmpDir, { recursive: true, force: true });
	}
}

/** Saves the attempt's folder under the repo docs; a failed write never fails the run. */
function saveArtifacts(options: RunOptions, result: RunResult, deps: ChildRunDeps): void {
	if (!result.runId) return;
	try {
		result.artifactsDir = writeRunArtifacts((deps.docsDir ?? repoDocsDir)(options.cwd), {
			runId: result.runId,
			agent: result.agent,
			task: result.task,
			reason: options.request.reason,
			taskText: options.taskText,
			model: result.model,
			thinking: result.thinking,
			route: result.route,
			exitCode: result.exitCode,
			stopReason: result.stopReason,
			errorMessage: result.errorMessage,
			startedAt: result.startedAt,
			endedAt: result.endedAt ?? (deps.now ?? Date.now)(),
			usage: result.usage,
			output: output(result),
			messages: result.messages,
		});
	} catch {
		// Artifacts are a record for the user, not part of the run's outcome.
	}
}
