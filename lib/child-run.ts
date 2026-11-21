// The run loop of one subagent child process: spawn it in Pi's JSON event stream mode (argv/env/stdio
// come from lib/child-launch.ts; the task is the argv message, no stdin), fold its JSON lines into a run
// snapshot, capture stderr, watch for stalls (the only timer that judges a run), terminate on abort or
// stall (SIGTERM, then SIGKILL after 5 s, which also reaches the descendants' own process groups), check
// structured output, and save the attempt's folder. No Pi runtime imports: the spawn function, timers, Pi
// invocation, and cost calculator are injected, so a test drives it with a fake child.
//
// Process lifetime: a child runs in its own process group (so a signal reaches its grandchildren too),
// the run settles on the child's `exit` even if `close` never comes (a grandchild can hold the pipes),
// and every live child is registered with a tracker so a shutdown can terminate them all within a bound.
// The caller hook `onUpdate` is isolated: a throwing hook is swallowed, because a UI bug is not the
// child's outcome and must never skip settlement or crash a stream handler.

import { execFileSync, spawn as nodeSpawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { Message } from "@earendil-works/pi-ai";
import type { AgentDefinition } from "./agents.ts";
import { foldChildEvent, parseChildLine } from "./child-events.ts";
import { childLaunch } from "./child-launch.ts";
import { emptyTally, priceBridgeMessage, type CostCalculator } from "./cost.ts";
import type { LaunchRequest } from "./delegation.ts";
import type { ResolvedRoute } from "./model-routing.ts";
import { canonicalPath } from "./paths.ts";
import { repoDocsDir } from "./repo-docs.ts";
import { newRunId, writeRunArtifacts } from "./run-artifacts.ts";
import { failed, finalText, output, USER_CANCEL, type RunResult } from "./run-status.ts";
import { createStallWatchdog, resolveStallTimeouts, stallMessage } from "./stall-watchdog.ts";
import { checkStructuredRun, type JsonSchema } from "./structured-output.ts";

/** Grace between SIGTERM and SIGKILL when a child ignores the terminate request. */
export const KILL_GRACE_MS = 5000;
/** After the child exits, how long the run waits for `close` (output fully drained) before settling without it. */
export const CLOSE_DRAIN_MS = 1000;

/** Streaming text updates reach `onUpdate` at most this often; the snapshot itself is always current. */
export const PARTIAL_UPDATE_MS = 100;

/** One row of the process table. */
export interface ProcessEntry {
	pid: number;
	ppid: number;
	pgid: number;
}

/** The longest the process listing may take, and the most descendants one forced kill follows. */
const PROCESS_LIST_TIMEOUT_MS = 2000;
const MAX_DESCENDANTS = 1000;

export function parseProcessList(text: string): ProcessEntry[] {
	const entries: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
		if (match) entries.push({ pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]) });
	}
	return entries;
}

/** The process table, synchronously (a process 'exit' handler may use it); throws when `ps` fails or takes too long. */
export function listProcessesWithPs(): ProcessEntry[] {
	const text = execFileSync("ps", ["-axo", "pid=,ppid=,pgid="], { encoding: "utf8", timeout: PROCESS_LIST_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
	return parseProcessList(text);
}

/** What a forced kill adds to the child's own group kill: descendants grouped by process group, and single pids. */
export interface DescendantTargets {
	groups: Array<{ pgid: number; pids: number[] }>;
	/** Descendants that sit in the parent's own group (or an unknown one): signalled alone, never through the group. */
	pids: number[];
}

/**
 * The processes below `rootPid` (found by parent links, bounded, cycle-safe) grouped by process group. Never lists pid 0/1,
 * the parent itself (`selfPid`), a group 0/1, or the parent's own group as a group target: a descendant that shares the
 * parent's group is listed by pid only, and when the parent's group is unknown no group is trusted.
 */
export function descendantTargets(rootPid: number, table: readonly ProcessEntry[], selfPid: number): DescendantTargets {
	const targets: DescendantTargets = { groups: [], pids: [] };
	if (!(rootPid > 1) || rootPid === selfPid) return targets;
	const childrenOf = new Map<number, ProcessEntry[]>();
	for (const entry of table) {
		const siblings = childrenOf.get(entry.ppid);
		if (siblings) siblings.push(entry);
		else childrenOf.set(entry.ppid, [entry]);
	}
	const selfGroup = table.find((entry) => entry.pid === selfPid)?.pgid;
	const groups = new Map<number, number[]>();
	const seen = new Set<number>([rootPid]);
	const queue = [rootPid];
	while (queue.length > 0 && seen.size <= MAX_DESCENDANTS) {
		for (const entry of childrenOf.get(queue.shift()!) ?? []) {
			if (seen.size > MAX_DESCENDANTS) break;
			if (seen.has(entry.pid) || entry.pid <= 1 || entry.pid === selfPid) continue;
			seen.add(entry.pid);
			queue.push(entry.pid);
			if (!(entry.pgid > 1)) continue;
			if (selfGroup === undefined || entry.pgid === selfGroup) targets.pids.push(entry.pid);
			else groups.set(entry.pgid, [...(groups.get(entry.pgid) ?? []), entry.pid]);
		}
	}
	targets.groups = [...groups].map(([pgid, pids]) => ({ pgid, pids }));
	return targets;
}

/** Two listings as one (a group once, a pid once); undefined when both are. */
export function mergeDescendantTargets(first: DescendantTargets | undefined, second: DescendantTargets | undefined): DescendantTargets | undefined {
	if (!first || !second) return first ?? second;
	const groups = new Map<number, Set<number>>();
	for (const { pgid, pids } of [...first.groups, ...second.groups]) groups.set(pgid, new Set([...(groups.get(pgid) ?? []), ...pids]));
	return { groups: [...groups].map(([pgid, pids]) => ({ pgid, pids: [...pids] })), pids: [...new Set([...first.pids, ...second.pids])] };
}

export interface ProcessSignallerOptions {
	/** The process's pid, read at each use; started detached it is also its group's id. Undefined when it failed to start. */
	pid: () => number | undefined;
	/** Signals the process alone (`child.kill`): the fallback when there is no group to signal. */
	killSelf: (signal: NodeJS.Signals) => void;
	killGroup: (pid: number, signal: NodeJS.Signals) => void;
	killPid: (pid: number, signal: NodeJS.Signals) => void;
	/** The process table, read when descendants are listed and no shared listing was given. */
	listProcesses: () => ProcessEntry[];
	/** The parent's own pid, never signalled. */
	selfPid: number;
	platform: NodeJS.Platform;
}

/**
 * The one way a child (a subagent run, a background process) is signalled, so both stop alike: its own process group,
 * then the descendants that left that group (a command that took a process group of its own), whose listing the caller
 * takes while the child is alive, because once it dies the parent links are gone. Never signals pid/pgid 0/1, the
 * parent, or the parent's group (`descendantTargets`). No method throws.
 */
export interface ProcessSignaller {
	/** The process has a group of its own to signal. */
	hasGroup(): boolean;
	/** The descendants now, from `shared` (a listing a tracker pass already took) or a fresh one; undefined without a group or when listing fails. */
	descendants(shared?: readonly ProcessEntry[]): DescendantTargets | undefined;
	/** `signal` to the group (to the process alone when there is no group or the group signal throws), then SIGKILL to `descendants`. */
	signal(signal: NodeJS.Signals, descendants?: DescendantTargets): void;
	/** SIGKILL to each descendant group (the process's own group too unless `ownGroupDone`); a group that cannot be signalled falls back to its pids. */
	killDescendants(targets: DescendantTargets | undefined, ownGroupDone: boolean): void;
}

export function createProcessSignaller(options: ProcessSignallerOptions): ProcessSignaller {
	const { killSelf, killGroup, killPid, listProcesses, selfPid, platform } = options;
	const hasGroup = () => options.pid() !== undefined && platform !== "win32";
	const one = (target: number) => {
		try {
			killPid(target, "SIGKILL");
		} catch {
			// Already gone.
		}
	};
	const killDescendants = (targets: DescendantTargets | undefined, ownGroupDone: boolean) => {
		if (!targets) return;
		for (const { pgid, pids } of targets.groups) {
			if (ownGroupDone && pgid === options.pid()) continue;
			try {
				killGroup(pgid, "SIGKILL");
			} catch {
				pids.forEach(one);
			}
		}
		targets.pids.forEach(one);
	};
	return {
		hasGroup,
		descendants(shared) {
			if (!hasGroup()) return undefined;
			try {
				return descendantTargets(options.pid()!, shared ?? listProcesses(), selfPid);
			} catch {
				return undefined;
			}
		},
		signal(signal, descendants) {
			let groupDone = false;
			try {
				if (hasGroup()) {
					try {
						killGroup(options.pid()!, signal);
						groupDone = true;
					} catch {
						// No such group (or not ours): signal the process itself.
					}
				}
				if (!groupDone) killSelf(signal);
			} finally {
				killDescendants(descendants, groupDone);
			}
		},
		killDescendants,
	};
}

// The run snapshot type and the run-state rule live in lib/run-status.ts (dependency-free, read by the view
// modules); re-exported here so existing imports keep working.
export { failed, finalText, isUnfinished, output, runStatus, toRunState, type RunResult, type RunStatus } from "./run-status.ts";

/** The part of a child process the run loop touches (node's ChildProcess fits). */
export interface ChildProcessLike {
	stdout: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	stderr: { on(event: "data", listener: (data: Buffer | string) => void): unknown };
	on(event: string, listener: (...args: any[]) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
	/** Absent when the process failed to start; with `detached` it is also the id of the child's process group. */
	pid?: number;
}

export type SpawnFn = (command: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; shell: false; stdio: ["ignore", "pipe", "pipe"]; detached: boolean }) => ChildProcessLike;

/**
 * Every live child process in one place (subagent runs; background processes share it): registered at spawn, released when its
 * run settles. `shutdown` is the bounded stop for session end: terminate all, wait up to the grace, kill survivors.
 */
export interface ChildTracker {
	/**
	 * Registers a live child by the function that signals it (and its group); returns the release function.
	 * On a forced (SIGKILL) pass the tracker passes the pass's one process listing as the second argument.
	 */
	add(kill: (signal: NodeJS.Signals, processes?: readonly ProcessEntry[]) => void): () => void;
	size(): number;
	/** Signals every tracked child now; one that throws does not stop the rest. */
	killAll(signal: NodeJS.Signals): void;
	/** SIGKILL every tracked child's group now, synchronously (for a process 'exit' handler); never throws, never waits. */
	killAllNow(): void;
	/** SIGTERM everything, resolve when none is left or after `graceMs` (then SIGKILL the survivors); never waits longer. */
	shutdown(options: { graceMs: number; setTimer: (fn: () => void, ms: number) => unknown; clearTimer: (handle: unknown) => void }): Promise<void>;
}

/**
 * `listProcesses` (default `ps`) is read once per forced pass and shared by every child of the pass, so N children cost
 * one listing (at most its 2 s bound), not N. A failed listing is an empty one: each child's own group is still killed.
 */
export function createChildTracker(options: { listProcesses?: () => ProcessEntry[] } = {}): ChildTracker {
	const listProcesses = options.listProcesses ?? listProcessesWithPs;
	const live = new Set<(signal: NodeJS.Signals, processes?: readonly ProcessEntry[]) => void>();
	const waiters = new Set<() => void>();
	const listOnce = (): ProcessEntry[] => {
		try {
			return listProcesses();
		} catch {
			return [];
		}
	};
	const killAll = (signal: NodeJS.Signals) => {
		const processes = signal === "SIGKILL" && live.size > 0 ? listOnce() : undefined;
		for (const kill of [...live]) {
			try {
				kill(signal, processes);
			} catch {
				// One child that cannot be signalled must not spare the others.
			}
		}
	};
	return {
		add(kill) {
			live.add(kill);
			return () => {
				live.delete(kill);
				if (live.size === 0) for (const waiter of [...waiters]) waiter();
			};
		},
		size: () => live.size,
		killAll,
		killAllNow() {
			// Each registered kill is the run's group-kill-with-fallback (the one terminate uses).
			try {
				killAll("SIGKILL");
			} catch {
				// An exit handler must not throw.
			}
		},
		shutdown({ graceMs, setTimer, clearTimer }) {
			if (live.size === 0) return Promise.resolve();
			killAll("SIGTERM");
			return new Promise<void>((resolve) => {
				let timer: unknown;
				const finish = () => {
					waiters.delete(check);
					clearTimer(timer);
					resolve();
				};
				const check = () => {
					if (live.size === 0) finish();
				};
				waiters.add(check);
				timer = setTimer(() => {
					killAll("SIGKILL");
					finish();
				}, graceMs);
			});
		},
	};
}

/** The process-wide tracker the extension shuts down; tests inject their own through `ChildRunDeps.tracker`. */
export const liveChildren: ChildTracker = createChildTracker();

/** The part of `process` the exit guard uses; tests pass a fake. */
export interface ParentProcessLike {
	on(event: string, listener: () => void): unknown;
	listenerCount(event: string): number;
	exit(code?: number): unknown;
}

// Children run in their own process group (`detached`), so a signal sent to the parent's group (terminal hangup, a
// group kill) no longer reaches them, so nothing would stop one if the parent died without `session_shutdown`.
// The guard SIGKILLs every tracked child group when the parent process exits and, when asked,
// on the listed signals. It cannot help when the parent itself is SIGKILLed or the machine dies: no handler runs then.
const GUARD_KEY = Symbol.for("brigadev.parentExitGuard");
interface GuardState {
	trackers: Set<ChildTracker>;
	signals: Set<string>;
}

/**
 * Installs, once per process, a `process.on("exit")` handler that calls `killAllNow` on every tracker given so far.
 * The extension may be loaded again (`/reload`, possibly as a fresh module with a fresh tracker), so the once-only state
 * lives on the process object under a global symbol: a later call adds its tracker and no second listener.
 *
 * `signals` (none by default) adds a listener per signal that kills the children, then keeps Node's default: adding a
 * listener disables the default exit, so when no other listener exists it exits with 128+signo (SIGHUP 129, SIGTERM 143);
 * when another one exists it leaves the decision to that one. Pi 1.5 handles SIGTERM and SIGHUP itself in interactive,
 * print and rpc mode (graceful shutdown, `session_shutdown`, then `process.exit`, which fires the exit handler), so the
 * extension passes none. No SIGINT: the TUI uses Ctrl+C.
 */
export function installParentExitGuard(tracker: ChildTracker, options: { processLike?: ParentProcessLike; signals?: readonly NodeJS.Signals[] } = {}): void {
	const proc = options.processLike ?? (process as unknown as ParentProcessLike);
	const holder = proc as unknown as { [GUARD_KEY]?: GuardState };
	let state = holder[GUARD_KEY];
	if (!state) {
		const fresh: GuardState = { trackers: new Set(), signals: new Set() };
		state = fresh;
		holder[GUARD_KEY] = fresh;
		proc.on("exit", () => killEvery(fresh));
	}
	const guard = state;
	guard.trackers.add(tracker);
	for (const signal of options.signals ?? []) {
		if (guard.signals.has(signal)) continue;
		guard.signals.add(signal);
		proc.on(signal, () => {
			killEvery(guard);
			// Ours is one of the listeners; any more means someone else handles the signal.
			if (proc.listenerCount(signal) > 1) return;
			proc.exit(128 + (os.constants.signals[signal] ?? 0));
		});
	}
}

function killEvery(state: GuardState): void {
	for (const tracker of state.trackers) {
		try {
			tracker.killAllNow();
		} catch {
			// Nothing to do at exit.
		}
	}
}

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
	/** Where live children are registered; defaults to the process-wide `liveChildren`. */
	tracker?: ChildTracker;
	/** Signals a whole process group; defaults to `process.kill(-pid, signal)`. */
	killGroup?: (pid: number, signal: NodeJS.Signals) => void;
	/** Defaults to process.platform; process groups do not apply on win32. */
	platform?: NodeJS.Platform;
	/** The process table, read synchronously when this child alone is force-killed (a tracker pass lists once for all children); defaults to `ps`. */
	listProcesses?: () => ProcessEntry[];
	/** Signals one process; defaults to process.kill. Used when a descendant's group cannot be signalled. */
	killPid?: (pid: number, signal: NodeJS.Signals) => void;
	/** The parent's own pid, never signalled; defaults to process.pid. */
	selfPid?: number;
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
	const platform = deps.platform ?? process.platform;
	const killGroup = deps.killGroup ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(-pid, signal));
	const tracker = deps.tracker ?? liveChildren;
	const listProcesses = deps.listProcesses ?? listProcessesWithPs;
	const killPid = deps.killPid ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
	const selfPid = deps.selfPid ?? process.pid;
	// Caller hooks never break the run: a throw is swallowed (not recorded on the result, which is the child's outcome).
	const hook = (fn: () => void) => {
		try {
			fn();
		} catch {
			// A UI or caller bug.
		}
	};
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
			taskText: options.taskText,
			parentEnv: env,
		});

		const now = deps.now ?? Date.now;
		let lastPartialUpdate = Number.NEGATIVE_INFINITY;
		let aborted = false;
		let stalled = false;
		result.exitCode = await new Promise<number>((resolveExit) => {
			const invocation = deps.piInvocation(launch.args);
			// Own process group (not on win32, where groups do not apply): a signal to the group reaches grandchildren too.
			const proc = spawn(invocation.command, invocation.args, { cwd, env: launch.env, shell: false, stdio: launch.stdio, detached: platform !== "win32" });
			const signaller = createProcessSignaller({ pid: () => proc.pid, killSelf: (signal) => void proc.kill(signal), killGroup, killPid, listProcesses, selfPid, platform });
			// A command the child's bash tool runs has a process group of its own, so the child's group kill misses it.
			// SIGKILL is the forced path (grace over, shutdown survivors, exit guard): it takes the descendants' groups too,
			// listed while the child is alive (`processes` is the listing a tracker pass already took for every child).
			// SIGTERM stays graceful so the child can clean up its own tool processes.
			const signalChild = (signal: NodeJS.Signals, processes?: readonly ProcessEntry[]) => signaller.signal(signal, signal === "SIGKILL" ? signaller.descendants(processes) : undefined);
			const release = tracker.add(signalChild);
			let buffer = "";
			let exited = false;
			// Set once the run settled: later output or events change nothing.
			let done = false;
			let closeTimer: unknown;
			let stallError = "";
			let killTimer: unknown;
			// Pi's `agent_settled` arrived: the run is finished and the child is only on its way out.
			let agentSettled = false;
			// We stopped a child whose run had already finished: its exit code and last words are not the outcome.
			let stoppedAfterSettle = false;

			// SIGTERM now, SIGKILL after the grace period if the child has not exited by then.
			const terminate = () => {
				signalChild("SIGTERM");
				killTimer ??= setTimer(() => !exited && signalChild("SIGKILL"), KILL_GRACE_MS);
			};

			const watchdog = createStallWatchdog({
				...resolveStallTimeouts(env),
				setTimer,
				clearTimer,
				onStall: (info) => {
					// A child that finished its run but does not exit is stopped, and its result stands.
					if (agentSettled) {
						stoppedAfterSettle = true;
						terminate();
						return;
					}
					stalled = true;
					result.stopReason = "error";
					stallError = stallMessage(info);
					result.errorMessage = stallError;
					terminate();
				},
			});
			watchdog.start();

			// Pi's outcome when its run settled: what a child that is then stopped on our side must not rewrite.
			let finished: { stopReason?: string; errorMessage?: string; messages: number } | undefined;

			const processLine = (line: string) => {
				for (const event of parseChildLine(line)) {
					if (event.type === "tool_start") watchdog.toolStarted(event.id, `tool ${event.name}`);
					else if (event.type === "tool_end") watchdog.toolFinished(event.id, `result of ${event.name}`);
					else if (event.type === "activity") watchdog.activity(event.label);
					else if (event.type === "run") {
						// `agent_end` can be followed by retries, compaction, or queued messages; `agent_settled` is the end (json.md, "Event sequence").
						if (event.phase === "settled" && !agentSettled) {
							agentSettled = true;
							finished = { stopReason: result.stopReason, errorMessage: result.errorMessage, messages: result.messages.length };
						}
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
					hook(() => options.onUpdate(result));
				}
			};

			// A multi-byte UTF-8 character can be split across chunks: a decoder holds the partial bytes until the rest arrives.
			// (Not `setEncoding`: the injected child of a test has no such method.)
			const stdoutDecoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			proc.stdout.on("data", (data) => {
				if (done) return;
				buffer += typeof data === "string" ? data : stdoutDecoder.write(data);
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			proc.stderr.on("data", (data) => {
				if (done) return;
				result.stderr += typeof data === "string" ? data : stderrDecoder.write(data);
			});
			const cleanup = () => {
				exited = true;
				watchdog.stop();
				if (killTimer !== undefined) clearTimer(killTimer);
			};
			// The run's one settlement, reached from `close` (all output read) or, if `close` never comes, from the drain timeout.
			const settle = (code: number | null) => {
				if (done) return;
				done = true;
				if (closeTimer !== undefined) clearTimer(closeTimer);
				cleanup();
				try {
					// Flush what the decoders still hold (a character cut off by the end of the stream).
					buffer += stdoutDecoder.end();
					result.stderr += stderrDecoder.end();
					if (buffer.trim()) processLine(buffer);
				} catch {
					// Whatever the last line did, the run still settles below.
				}
				// The child may report its own "aborted" on SIGTERM; the stall is the real cause.
				if (stalled) Object.assign(result, { stopReason: "error", errorMessage: stallError });
				// Our own stop of a child that had finished is not its outcome: drop what it said on the way out and its exit code.
				const ours = stoppedAfterSettle && finished !== undefined;
				if (ours && finished) {
					result.messages.length = finished.messages;
					Object.assign(result, { stopReason: finished.stopReason, errorMessage: finished.errorMessage });
				}
				release();
				resolveExit(stalled ? 1 : ours ? 0 : (code ?? 0));
			};
			proc.on("close", settle);
			// The child exited: it needs no more signals. Its output normally follows in `close`, but a grandchild that
			// holds the pipes keeps `close` from ever firing, so the wait for it is bounded.
			proc.on("exit", (code: number | null) => {
				if (done) return;
				exited = true;
				closeTimer ??= setTimer(() => {
					// Whatever still holds the pipes belongs to this child's group: end it, then settle without `close`. The child is
					// gone, so its descendants were reparented (a walk would find none) and its pid may already belong to someone else:
					// no process listing here.
					if (signaller.hasGroup()) {
						try {
							killGroup(proc.pid!, "SIGKILL");
						} catch {
							// The group is already gone.
						}
					}
					settle(code);
				}, CLOSE_DRAIN_MS);
			});
			proc.on("error", (error: unknown) => {
				if (done) return;
				done = true;
				if (closeTimer !== undefined) clearTimer(closeTimer);
				cleanup();
				result.stderr += String(error);
				release();
				resolveExit(1);
			});

			if (options.signal) {
				const kill = () => {
					// A user cancel that lands once the child has exited (its output still draining) reaches nothing: the run finished.
					if (exited && options.signal?.reason === USER_CANCEL) return;
					aborted = true;
					terminate();
				};
				if (options.signal.aborted) kill();
				else options.signal.addEventListener("abort", kill, { once: true });
			}
		});
		// A child that ended mid-message leaves no live text behind.
		delete result.partial;
		if (aborted && options.signal?.reason === USER_CANCEL) {
			// The user cancelled this task alone (the launch goes on): it ends with what it had, flagged cancelled, and its folder is saved below.
			result.stopReason ??= "aborted";
			Object.assign(result, { cancelled: true, cancelledBy: "user" });
			return result;
		}
		if (aborted) {
			// The folder is written before the error leaves, so the parent can be told where the partial run is.
			saveArtifacts(options, result, deps);
			throw new Error(result.artifactsDir ? `Subagent was aborted (partial run saved in ${result.artifactsDir})` : "Subagent was aborted");
		}
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
	if (!result.runId || result.artifactsDir) return;
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
			structured: result.structured,
			finalText: finalText(result.messages),
			messages: result.messages,
		});
	} catch {
		// Artifacts are a record for the user, not part of the run's outcome.
	}
}
