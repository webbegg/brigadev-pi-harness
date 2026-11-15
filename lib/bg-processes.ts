// Background processes: long-running shell commands the model starts without blocking its turn, then inspects
// (`bg_status`, `bg_list`) and stops (`bg_kill`). No Pi runtime imports: the spawn function, the shell, the
// environment, timers, and signalling are injected, so a test drives the manager with a fake child.
//
// A process gets no stdin, runs in its own process group (not on win32), and keeps its output (stdout and stderr
// merged, in arrival order) as a capped in-memory tail. It settles exactly once: `done` (exit 0), `failed` (non-zero
// exit, a signal nobody sent, or it could not start) or `killed` (we signalled it). Stopping follows lib/child-run.ts:
// SIGTERM to the group, SIGKILL after KILL_GRACE_MS (which also takes the descendants that left the group), and every
// live process is registered with a ChildTracker so the parent-exit guard can end them if the session dies.
//
// "Seen": the model has seen an exit when it asked `bg_status` of a settled process or waited for its own `bg_kill`.
// The settle hook reports it, so the exit notice (lib/bg-delivery.ts) is not sent for what the model already knows.

import { spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { CLOSE_DRAIN_MS, createChildTracker, descendantTargets, KILL_GRACE_MS, listProcessesWithPs, type ChildTracker, type DescendantTargets, type ProcessEntry } from "./child-run.ts";

/** The most processes that may run at once. */
export const MAX_RUNNING = 8;
/** Settled processes kept for `bg_status` / `bg_list` / the overlay; older ones are forgotten (never a running one). */
export const MAX_SETTLED_KEPT = 32;
/** Output kept per process: the newest bytes, stdout and stderr together. */
export const OUTPUT_TAIL_BYTES = 256 * 1024;
/** Subscribers hear of new output at most this often. */
export const OUTPUT_NOTIFY_MS = 100;
/** Time between SIGTERM and SIGKILL for a process that does not stop (same bound as the subagent children). */
export const BG_KILL_GRACE_MS = KILL_GRACE_MS;
/** Extra time, after SIGKILL and the pipe drain, before a process that never reported its exit is settled by force. */
const FORCE_SETTLE_SLACK_MS = 1000;
const NAME_MAX = 60;

export type BgState = "running" | "done" | "failed" | "killed";

export interface BgSnapshot {
	id: string;
	/** The model's label, or the start of the command. */
	name: string;
	command: string;
	/** Absolute directory the process runs in. */
	cwd: string;
	pid?: number;
	state: BgState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	/** Why it could not start, or a note about a forced end. */
	error?: string;
	/** The output tail (a copy: later output does not change it). */
	output: string;
	/** Bytes the process wrote in all, and how many of them the tail no longer holds. */
	totalBytes: number;
	truncatedBytes: number;
}

/** A failure the model can act on: too many processes, a command that cannot start. */
export class BgError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "BgError";
	}
}

/**
 * The newest `maxBytes` of a stream, as text. Whole chunks leave from the head; one chunk larger than the cap is cut
 * to its tail on a character boundary, so retention is bounded even for a single huge write.
 */
export class TailBuffer {
	totalBytes = 0;
	truncatedBytes = 0;
	private chunks: string[] = [];
	private retained = 0;
	private cached: string | undefined = "";

	private readonly maxBytes: number;

	constructor(maxBytes: number) {
		this.maxBytes = maxBytes;
	}

	push(chunk: string): void {
		if (chunk.length === 0) return;
		let bytes = Buffer.byteLength(chunk, "utf8");
		this.totalBytes += bytes;
		if (bytes > this.maxBytes) {
			// Everything kept so far precedes this chunk: it goes, and only the chunk's tail stays.
			this.truncatedBytes += this.retained;
			this.chunks = [];
			this.retained = 0;
			const raw = Buffer.from(chunk, "utf8");
			let start = raw.length - this.maxBytes;
			while (start < raw.length && (raw[start] & 0xc0) === 0x80) start++;
			this.truncatedBytes += start;
			chunk = raw.subarray(start).toString("utf8");
			bytes = raw.length - start;
		}
		this.chunks.push(chunk);
		this.retained += bytes;
		while (this.retained > this.maxBytes && this.chunks.length > 1) {
			const evicted = this.chunks.shift()!;
			const size = Buffer.byteLength(evicted, "utf8");
			this.retained -= size;
			this.truncatedBytes += size;
		}
		this.cached = undefined;
	}

	text(): string {
		this.cached ??= this.chunks.join("");
		return this.cached;
	}
}

/** The part of a child process the manager touches (node's ChildProcess fits). */
export interface BgChild {
	/** Absent when the process failed to start; with `detached` it is also the id of the process group. */
	pid?: number;
	stdout: { on(event: string, listener: (data: Buffer | string) => void): unknown } | null;
	stderr: { on(event: string, listener: (data: Buffer | string) => void): unknown } | null;
	on(event: string, listener: (...args: any[]) => void): unknown;
	kill(signal?: NodeJS.Signals): unknown;
}

export type BgSpawn = (file: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; stdio: ["ignore", "pipe", "pipe"]; detached: boolean; windowsHide: boolean }) => BgChild;

/** How a command string is run: the shell and its leading arguments (Pi's `getShellConfig()` has this shape). */
export interface ShellInvocation {
	shell: string;
	args: string[];
	/** "stdin": the shell reads the command from stdin (legacy WSL bash). Background processes have no stdin, so this is refused. */
	commandTransport?: "stdin";
}

export interface BgProcessDeps {
	spawn?: BgSpawn;
	/** Defaults to /bin/bash (else `sh`) with `-c`, like Pi's bash tool. */
	shell?: () => ShellInvocation;
	/** The environment of a process; defaults to process.env. A start request may carry its own. */
	env?: () => NodeJS.ProcessEnv;
	/** Where live processes are registered for the parent-exit guard; defaults to a tracker of its own (`manager.tracker`). */
	tracker?: ChildTracker;
	now?: () => number;
	setTimer?: (fn: () => void, ms: number) => unknown;
	clearTimer?: (handle: unknown) => void;
	/** Defaults to process.platform; process groups do not apply on win32. */
	platform?: NodeJS.Platform;
	/** Signals a whole process group; defaults to `process.kill(-pid, signal)`. */
	killGroup?: (pid: number, signal: NodeJS.Signals) => void;
	/** Signals one process; defaults to process.kill. Used when a descendant's group cannot be signalled. */
	killPid?: (pid: number, signal: NodeJS.Signals) => void;
	/** The process table, read when a process is force-killed (a tracker pass lists once for all); defaults to `ps`. */
	listProcesses?: () => ProcessEntry[];
	/** The parent's own pid, never signalled; defaults to process.pid. */
	selfPid?: number;
	/** Grace between SIGTERM and SIGKILL; defaults to BG_KILL_GRACE_MS. Tests shorten it. */
	graceMs?: number;
	maxRunning?: number;
	tailBytes?: number;
}

export interface StartRequest {
	command: string;
	/** Absolute directory; the caller checks it exists. */
	cwd: string;
	name?: string;
	/** Replaces `deps.env()` for this process. */
	env?: NodeJS.ProcessEnv;
}

export type BgEvent = "state" | "output";

export interface BgProcesses {
	/** Every live process is registered here; hand it to `installParentExitGuard`. */
	readonly tracker: ChildTracker;
	/** Starts a process; throws BgError when 8 are running, the command is empty, or it cannot be spawned. */
	start(request: StartRequest): BgSnapshot;
	/** A copy of the process as it is now; marks nothing as seen. */
	get(id: string): BgSnapshot | undefined;
	/** Like `get`, and a settled process counts as seen by the model. */
	status(id: string): BgSnapshot | undefined;
	/** Every tracked process, in start order. */
	list(): BgSnapshot[];
	runningCount(): number;
	/**
	 * SIGTERM, then SIGKILL after the grace; resolves with the final snapshot once it settled (bounded).
	 * `seen` (default true): the caller is the model, which now knows the outcome; false for the user's own kill, whose
	 * exit the model still has to hear of. Undefined for an unknown id.
	 */
	kill(id: string, options?: { seen?: boolean }): Promise<BgSnapshot | undefined>;
	/** True when the model has seen this process's exit. */
	isConsumed(id: string): boolean;
	markConsumed(id: string): void;
	/** `state`: a process started or settled. `output`: new output (throttled). */
	subscribe(listener: (event: BgEvent) => void): () => void;
	/** The one settle hook: the final snapshot, and whether the model already saw the exit (a kill it waited for). */
	onSettled(hook: ((snapshot: BgSnapshot, consumed: boolean) => void) | undefined): void;
	/** Stops everything (SIGTERM, SIGKILL after the grace); resolves when all settled, at most about grace + 2 s later. */
	shutdown(): Promise<void>;
	/** Forgets settled processes (a new session); running ones stay. */
	reset(): void;
}

/**
 * The environment Pi's bash tool gives a command: the process environment with Pi's bin dir first on PATH, and the
 * session variables set from `session` (a stale PI_* value in the environment is dropped, as Pi does).
 */
export function shellEnvironment(base: NodeJS.ProcessEnv, options: { binDir: string; delimiter?: string; session?: Record<string, string | undefined> }): NodeJS.ProcessEnv {
	const delimiter = options.delimiter ?? path.delimiter;
	const env: NodeJS.ProcessEnv = { ...base };
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const current = env[pathKey] ?? "";
	if (!current.split(delimiter).filter(Boolean).includes(options.binDir)) env[pathKey] = [options.binDir, current].filter(Boolean).join(delimiter);
	for (const key of ["PI_SESSION_ID", "PI_SESSION_FILE", "PI_PROVIDER", "PI_MODEL", "PI_REASONING_LEVEL"]) delete env[key];
	for (const [key, value] of Object.entries(options.session ?? {})) if (value !== undefined) env[key] = value;
	return env;
}

function defaultShell(): ShellInvocation {
	if (process.platform === "win32") return { shell: process.env.ComSpec ?? "cmd.exe", args: ["/d", "/s", "/c"] };
	return { shell: existsSync("/bin/bash") ? "/bin/bash" : "sh", args: ["-c"] };
}

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

interface Entry {
	id: string;
	name: string;
	command: string;
	cwd: string;
	child: BgChild;
	pid?: number;
	state: BgState;
	startedAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	error?: string;
	tail: TailBuffer;
	decoders: StringDecoder[];
	release: () => void;
	/** The process reported its exit (not necessarily its output closing). */
	exited: boolean;
	/** What its `exit` event said, for a settle that happens without `close`. */
	exitInfo?: { code: number | null; signal: string | null };
	/** We signalled it while it was alive: its end is "killed". */
	killRequested: boolean;
	/** A kill the model waits for is in flight: the model will see the outcome. */
	seenByKill: boolean;
	terminating: boolean;
	waiters: Array<() => void>;
	closeTimer?: unknown;
	killTimer?: unknown;
	forceTimer?: unknown;
}

export function createBgProcesses(deps: BgProcessDeps = {}): BgProcesses {
	const spawn = deps.spawn ?? (nodeSpawn as unknown as BgSpawn);
	const getShell = deps.shell ?? defaultShell;
	const getEnv = deps.env ?? (() => process.env);
	const tracker = deps.tracker ?? createChildTracker();
	const now = deps.now ?? Date.now;
	const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
	const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as NodeJS.Timeout));
	const platform = deps.platform ?? process.platform;
	const killGroup = deps.killGroup ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(-pid, signal));
	const killPid = deps.killPid ?? ((pid: number, signal: NodeJS.Signals) => void process.kill(pid, signal));
	const listProcesses = deps.listProcesses ?? listProcessesWithPs;
	const selfPid = deps.selfPid ?? process.pid;
	const graceMs = deps.graceMs ?? BG_KILL_GRACE_MS;
	const maxRunning = deps.maxRunning ?? MAX_RUNNING;
	const tailBytes = deps.tailBytes ?? OUTPUT_TAIL_BYTES;

	const entries = new Map<string, Entry>();
	/** Ids whose exit the model has seen. Kept past pruning, so a forgotten process is never announced as unseen twice. */
	const seen = new Set<string>();
	const listeners = new Set<(event: BgEvent) => void>();
	let settledHook: ((snapshot: BgSnapshot, consumed: boolean) => void) | undefined;
	let counter = 0;

	const emit = (event: BgEvent) => {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// A UI bug is not the process's outcome.
			}
		}
	};

	// Output notices are throttled: the first goes at once, the rest of a burst is one notice at the end of the window.
	let outputTimer: unknown;
	let outputPending = false;
	const openOutputWindow = () => {
		outputTimer = setTimer(() => {
			outputTimer = undefined;
			if (!outputPending) return;
			outputPending = false;
			emit("output");
			openOutputWindow();
		}, OUTPUT_NOTIFY_MS);
	};
	const notifyOutput = () => {
		if (outputTimer !== undefined) {
			outputPending = true;
			return;
		}
		emit("output");
		openOutputWindow();
	};

	const snapshot = (e: Entry): BgSnapshot => ({
		id: e.id,
		name: e.name,
		command: e.command,
		cwd: e.cwd,
		pid: e.pid,
		state: e.state,
		startedAt: e.startedAt,
		endedAt: e.endedAt,
		exitCode: e.exitCode,
		signal: e.signal,
		error: e.error,
		output: e.tail.text(),
		totalBytes: e.tail.totalBytes,
		truncatedBytes: e.tail.truncatedBytes,
	});

	const clearTimers = (e: Entry) => {
		for (const timer of [e.closeTimer, e.killTimer, e.forceTimer]) if (timer !== undefined) clearTimer(timer);
		e.closeTimer = e.killTimer = e.forceTimer = undefined;
	};

	const hasGroup = (e: Entry) => e.pid !== undefined && platform !== "win32";

	// The descendants a forced kill must also reach: a command the process ran may sit in a process group of its own,
	// which the group kill misses. Listed while the process is alive (afterwards the parent links are gone).
	const descendantsOf = (e: Entry, shared?: readonly ProcessEntry[]): DescendantTargets | undefined => {
		if (!hasGroup(e)) return undefined;
		try {
			return descendantTargets(e.pid!, shared ?? listProcesses(), selfPid);
		} catch {
			return undefined;
		}
	};

	const killDescendants = (e: Entry, targets: DescendantTargets | undefined, ownGroupDone: boolean) => {
		if (!targets) return;
		const one = (pid: number) => {
			try {
				killPid(pid, "SIGKILL");
			} catch {
				// Already gone.
			}
		};
		for (const { pgid, pids } of targets.groups) {
			if (ownGroupDone && pgid === e.pid) continue;
			try {
				killGroup(pgid, "SIGKILL");
			} catch {
				pids.forEach(one);
			}
		}
		targets.pids.forEach(one);
	};

	// To the whole group; to the process alone when it has no pid, on win32, or when the group signal throws.
	// SIGKILL is the forced path: it takes the descendants' own groups too. SIGTERM stays graceful.
	const signalEntry = (e: Entry, signal: NodeJS.Signals, processes?: readonly ProcessEntry[]) => {
		if (!e.exited) e.killRequested = true;
		const descendants = signal === "SIGKILL" ? descendantsOf(e, processes) : undefined;
		let groupDone = false;
		try {
			if (hasGroup(e)) {
				try {
					killGroup(e.pid!, signal);
					groupDone = true;
				} catch {
					// No such group (or not ours): signal the process itself.
				}
			}
			if (!groupDone) e.child.kill(signal);
		} finally {
			killDescendants(e, descendants, groupDone);
		}
	};

	const prune = () => {
		const settled = [...entries.values()].filter((e) => e.state !== "running");
		for (const e of settled.slice(0, Math.max(0, settled.length - MAX_SETTLED_KEPT))) entries.delete(e.id);
	};

	const settle = (e: Entry, outcome: { code?: number | null; signal?: string | null; error?: string; forced?: boolean }) => {
		if (e.state !== "running") return;
		clearTimers(e);
		e.release();
		// What the decoders still hold (a character cut off by the end of the stream).
		for (const decoder of e.decoders) {
			try {
				e.tail.push(decoder.end());
			} catch {
				// Nothing to flush.
			}
		}
		e.endedAt = now();
		if (outcome.code !== undefined && outcome.code !== null) e.exitCode = outcome.code;
		if (outcome.signal) e.signal = outcome.signal;
		if (outcome.error) e.error = outcome.error;
		e.state = outcome.forced || e.killRequested ? "killed" : outcome.error ? "failed" : outcome.code === 0 ? "done" : "failed";
		if (e.seenByKill) seen.add(e.id);
		const waiters = e.waiters.splice(0);
		prune();
		emit("state");
		try {
			settledHook?.(snapshot(e), seen.has(e.id));
		} catch {
			// A hook bug is not the process's outcome.
		}
		for (const waiter of waiters) waiter();
	};

	const terminate = (e: Entry) => {
		if (e.state !== "running" || e.terminating) return;
		e.terminating = true;
		signalEntry(e, "SIGTERM");
		e.killTimer = setTimer(() => {
			if (e.state === "running" && !e.exited) signalEntry(e, "SIGKILL");
		}, graceMs);
		// Bounded: a process that never reports its end is settled by force, so nothing waits forever.
		e.forceTimer = setTimer(() => settle(e, { forced: true, error: "The process did not exit after SIGKILL; it was given up on." }), graceMs + CLOSE_DRAIN_MS + FORCE_SETTLE_SLACK_MS);
	};

	const waitSettled = (e: Entry): Promise<void> => (e.state === "running" ? new Promise<void>((resolve) => e.waiters.push(resolve)) : Promise.resolve());

	return {
		tracker,

		start(request) {
			const command = request.command.trim();
			if (!command) throw new BgError("command must not be empty.");
			if ([...entries.values()].filter((e) => e.state === "running").length >= maxRunning) {
				throw new BgError(`Too many background processes: at most ${maxRunning} may run at once. Stop one with bg_kill first.`);
			}
			let shell: ShellInvocation;
			try {
				shell = getShell();
			} catch (error) {
				throw new BgError(`No shell to run the command: ${error instanceof Error ? error.message : String(error)}`);
			}
			if (shell.commandTransport === "stdin") throw new BgError("This shell takes its command from stdin, and background processes have no stdin.");
			let child: BgChild;
			try {
				child = spawn(shell.shell, [...shell.args, command], { cwd: request.cwd, env: request.env ?? getEnv(), stdio: ["ignore", "pipe", "pipe"], detached: platform !== "win32", windowsHide: true });
			} catch (error) {
				throw new BgError(`Could not start the process: ${error instanceof Error ? error.message : String(error)}`);
			}
			const id = `bg-${++counter}`;
			const e: Entry = {
				id,
				name: oneLine(request.name ?? "", NAME_MAX) || oneLine(command, NAME_MAX),
				command,
				cwd: request.cwd,
				child,
				pid: child.pid,
				state: "running",
				startedAt: now(),
				tail: new TailBuffer(tailBytes),
				decoders: [new StringDecoder("utf8"), new StringDecoder("utf8")],
				release: () => {},
				exited: false,
				killRequested: false,
				seenByKill: false,
				terminating: false,
				waiters: [],
			};
			entries.set(id, e);
			e.release = tracker.add((signal, processes) => signalEntry(e, signal, processes));

			// A multi-byte character can be split across chunks: a decoder holds the partial bytes until the rest arrives.
			const onData = (decoder: StringDecoder) => (data: Buffer | string) => {
				if (e.state !== "running") return;
				e.tail.push(typeof data === "string" ? data : decoder.write(data));
				notifyOutput();
			};
			child.stdout?.on("data", onData(e.decoders[0]));
			child.stderr?.on("data", onData(e.decoders[1]));
			// A broken pipe is not an outcome; the process's own exit is.
			child.stdout?.on("error", () => {});
			child.stderr?.on("error", () => {});
			child.on("exit", (code: number | null, signal: string | null) => {
				if (e.state !== "running") return;
				e.exited = true;
				e.exitInfo = { code, signal };
				// Output normally follows in `close`, but a descendant that holds the pipes keeps `close` from ever firing:
				// the wait is bounded, then the process's group is ended and it settles without `close`. The process is gone,
				// so its descendants were reparented (a walk would find none): no process listing here.
				e.closeTimer ??= setTimer(() => {
					if (hasGroup(e)) {
						try {
							killGroup(e.pid!, "SIGKILL");
						} catch {
							// The group is already gone.
						}
					}
					settle(e, e.exitInfo);
				}, CLOSE_DRAIN_MS);
			});
			child.on("close", (code: number | null, signal: string | null) => settle(e, { code, signal }));
			child.on("error", (error: unknown) => settle(e, { error: error instanceof Error ? error.message : String(error) }));
			emit("state");
			return snapshot(e);
		},

		get: (id) => {
			const e = entries.get(id);
			return e ? snapshot(e) : undefined;
		},

		status(id) {
			const e = entries.get(id);
			if (!e) return undefined;
			if (e.state !== "running") seen.add(id);
			return snapshot(e);
		},

		list: () => [...entries.values()].map(snapshot),

		runningCount: () => [...entries.values()].filter((e) => e.state === "running").length,

		async kill(id, options = {}) {
			const wantSeen = options.seen ?? true;
			const e = entries.get(id);
			if (!e) return undefined;
			if (e.state === "running") {
				if (wantSeen) e.seenByKill = true;
				const settled = waitSettled(e);
				terminate(e);
				await settled;
			}
			if (wantSeen) seen.add(id);
			return snapshot(e);
		},

		isConsumed: (id) => seen.has(id),
		markConsumed: (id) => void seen.add(id),

		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},

		onSettled(hook) {
			settledHook = hook;
		},

		async shutdown() {
			const running = [...entries.values()].filter((e) => e.state === "running");
			const settled = running.map(waitSettled);
			for (const e of running) terminate(e);
			await Promise.all(settled);
		},

		reset() {
			for (const e of [...entries.values()]) if (e.state !== "running") entries.delete(e.id);
		},
	};
}
