// The run loop of one subagent child process: spawn it in Pi's RPC mode (argv/env/stdio
// come from lib/child-launch.ts), send the task as the RPC `prompt`, fold its JSON lines
// into a run snapshot, answer its extension UI requests with a cancellation (S0: nothing
// waits for a person), close its stdin when the agent settles so it exits, expose a
// steering handle while it runs, capture stderr, watch for stalls, terminate on abort
// (SIGTERM, then SIGKILL after 5 s), check structured output, and save the attempt's
// folder. No Pi runtime imports: the spawn function, timers, Pi invocation, and cost calculator are injected, so a
// test drives it with a fake child.

import { spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "./agents.ts";
import { foldChildEvent, parseChildLine } from "./child-events.ts";
import { childLaunch } from "./child-launch.ts";
import { answerUiRequest, createChildControl, createCommandTracker, encodeCommand, type ChildControl, type RpcCommand, type UiResponse } from "./child-rpc.ts";
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
/** Time a child that finished its work (or will never start one) gets to exit on its own after stdin closes. */
export const EXIT_GRACE_MS = 5000;

/** Streaming text updates reach `onUpdate` at most this often; the snapshot itself is always current. */
export const PARTIAL_UPDATE_MS = 100;

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
	/** Live text of the assistant message in progress (see lib/child-events.ts); never set on a settled run. */
	partial?: string;
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
	/** The child's stdin (piped): RPC commands go in, one JSON record per line. */
	stdin: { write(chunk: string): unknown; end(): unknown; on(event: "error", listener: (error: unknown) => void): unknown };
	stdout: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	stderr: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	on(event: string, listener: (...args: any[]) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; stdio: ["pipe", "pipe", "pipe"] }) => ChildProcessLike;

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
	/**
	 * Called with the steering handle once the child is spawned, and with `undefined` when the run has finished
	 * (the agent settled, the child exited, or it never started). A finished run has no handle.
	 */
	onControl?: (control: ChildControl | undefined) => void;
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
			systemPromptPath,
			parentEnv: env,
		});

		const now = deps.now ?? Date.now;
		let lastPartialUpdate = Number.NEGATIVE_INFINITY;
		let aborted = false;
		let stalled = false;
		// The user aborted this child from the viewer (the RPC `abort`); the run settles as aborted instead of throwing.
		let userAborted = false;
		let controlGiven = false;
		const withdraw = () => {
			if (!controlGiven) return;
			controlGiven = false;
			options.onControl?.(undefined);
		};
		result.exitCode = await new Promise<number>((resolveExit) => {
			const invocation = deps.piInvocation(launch.args);
			const proc = spawn(invocation.command, invocation.args, { cwd, env: launch.env, shell: false, stdio: launch.stdio });
			let buffer = "";
			let exited = false;
			let stallError = "";
			let killTimer: unknown;
			let abortTimer: unknown;
			let exitTimer: unknown;
			// The run's outcome when its input ended; a forced shutdown after that never rewrites it.
			let finished: { stopReason?: string; errorMessage?: string; messages: number } | undefined;
			let forcedExit = false;
			let streaming = false;
			let inputOpen = true;
			// steer/follow_up commands wait here for Pi's response (matched by id); nothing is left waiting once input ends.
			const commands = createCommandTracker();

			// Commands and UI answers go to the child as one JSON record per line (rpc.md:50-56); false once the pipe is closed.
			const send = (record: RpcCommand | UiResponse): boolean => {
				if (!inputOpen) return false;
				try {
					proc.stdin.write(encodeCommand(record));
					return true;
				} catch {
					return false;
				}
			};
			// Closing stdin asks the child to shut down in order (rpc.md:91-93); a finished run takes no more input, so it has no handle.
			const endInput = () => {
				if (!inputOpen) return;
				inputOpen = false;
				withdraw();
				commands.settleAll();
				try {
					proc.stdin.end();
				} catch {
					// The child is already gone.
				}
			};
			// A child that exited early breaks the pipe; the close event settles the run.
			proc.stdin.on("error", () => {
				inputOpen = false;
				withdraw();
				commands.settleAll();
			});

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

			// The run is over (settled, or a prompt that will never start one): the stall budget no longer applies.
			// Closing stdin asks the child to exit; one that has not exited after the grace is terminated, keeping its result.
			const finishInput = () => {
				if (finished) return;
				finished = { stopReason: result.stopReason, errorMessage: result.errorMessage, messages: result.messages.length };
				endInput();
				watchdog.stop();
				exitTimer = setTimer(() => {
					if (exited) return;
					forcedExit = true;
					terminate();
				}, EXIT_GRACE_MS);
			};

			const control = createChildControl({
				send,
				streaming: () => streaming,
				onAbort: () => {
					userAborted = true;
					// A child that does not stop on its own is terminated like any other.
					abortTimer ??= setTimer(() => !exited && terminate(), KILL_GRACE_MS);
				},
				commands,
			});
			// The task is the first command (rpc.md:20; the child has no positional prompt).
			send({ type: "prompt", message: options.taskText });
			controlGiven = true;
			options.onControl?.(control);

			const processLine = (line: string) => {
				for (const event of parseChildLine(line)) {
					if (event.type === "tool_start") watchdog.toolStarted(event.id, `tool ${event.name}`);
					else if (event.type === "tool_end") watchdog.toolFinished(event.id, `result of ${event.name}`);
					else if (event.type === "activity") watchdog.activity(event.label);
					else if (event.type === "run") {
						streaming = event.phase === "start";
						// `agent_end` can be followed by retries, compaction, or queued messages; `agent_settled` is the end (rpc.md:69).
						if (event.phase === "settled") finishInput();
					} else if (event.type === "response") {
						// The answer to a steer/follow_up settles that command's outcome (rpc.md:35-44).
						commands.respond(event);
						// A rejected prompt starts no run, and a handled one starts none either (rpc.md:67): neither will ever settle.
						if (event.command === "prompt" && !event.success) {
							Object.assign(result, { stopReason: "error", errorMessage: `Pi rejected the task: ${event.error ?? "unknown error"}` });
							finishInput();
						} else if (event.command === "prompt" && event.disposition === "handled") finishInput();
					} else if (event.type === "ui_request") {
						// S0: a child's dialog is cancelled on the spot, never shown to the user and never left pending.
						const answer = answerUiRequest(event.request);
						if (answer) send(answer);
					}
					// Bridge turns report $0; price them at list price (see lib/cost.ts).
					else if (event.type === "message") event.message = (priceBridgeMessage(event.message, options.price) ?? event.message) as Message;
					if (!foldChildEvent(result, event)) continue;
					// Streaming text can arrive for every token: the snapshot is current, but listeners hear of it at a bounded rate.
					if (event.type === "partial") {
						const at = now();
						if (at - lastPartialUpdate < PARTIAL_UPDATE_MS) continue;
						lastPartialUpdate = at;
					}
					options.onUpdate(result);
				}
			};

			// A multi-byte UTF-8 character can be split across chunks: a decoder holds the partial bytes until the rest arrives.
			// (Not `setEncoding`: the injected child of a test has no such method.)
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			proc.stdout.on("data", (data) => {
				buffer += typeof data === "string" ? data : stdoutDecoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				result.stderr += typeof data === "string" ? data : stderrDecoder.write(data);
			});
			const cleanup = () => {
				exited = true;
				inputOpen = false;
				commands.settleAll();
				watchdog.stop();
				if (killTimer !== undefined) clearTimer(killTimer);
				if (abortTimer !== undefined) clearTimer(abortTimer);
				if (exitTimer !== undefined) clearTimer(exitTimer);
				withdraw();
			};
			proc.on("close", (code: number | null) => {
				cleanup();
				// Flush what the decoders still hold (a character cut off by the end of the stream).
				buffer += stdoutDecoder.end();
				result.stderr += stderrDecoder.end();
				if (buffer.trim()) processLine(buffer);
				// The user's abort is the cause, whatever the child reported on its way out.
				if (userAborted) Object.assign(result, { stopReason: "aborted", errorMessage: "Aborted by the user" });
				// The child may report its own "aborted" on SIGTERM; the stall is the real cause.
				if (stalled) Object.assign(result, { stopReason: "error", errorMessage: stallError });
				// Our own shutdown of a finished child is not its outcome: drop what it said on the way out and its exit code.
				if (forcedExit && finished) {
					result.messages.length = finished.messages;
					Object.assign(result, { stopReason: finished.stopReason, errorMessage: finished.errorMessage });
				}
				resolveExit(stalled ? 1 : forcedExit ? 0 : (code ?? 0));
			});
			proc.on("error", (error: unknown) => {
				cleanup();
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
		// A child that ended mid-message leaves no live text behind.
		delete result.partial;
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
