// H4: the execution environment of every conversation (the worker, the verifier, a FIX-n ticket), where the `bash` tool runs the agent's commands.
//
// pi-durable's `NodeExecutionEnv` already starts each command in its own session (`detached: true` is `setsid`: its own process group, no controlling
// terminal) with stdin on /dev/null, and kills the group on a timeout or an abort. What it does not do is end the group when the command *returns*: `nohup sh x.sh &`
// outlives the call and keeps running beside the runner, where it can wait for a link on the runner's terminal, signal the runner, or reach a pane. This environment
// ends the whole group once the call is over, however it ended (exit 0, a failure, a timeout, an abort): SIGTERM to the group, and SIGKILL after a short grace for what
// ignored it.
//
// The hook is the environment's own bookkeeping: `NodeExecutionEnv` adds the pid of each command's group leader to `activeChildPids` when it starts it and deletes it
// when the call settles, whatever the outcome. That set is a TypeScript `private`, not a public seam, so this replaces it with one that reaps on `delete`, and refuses
// to run (fails closed) if the base class no longer has it: pi-durable is pinned to an exact version, and `tests/reaping-env.test.ts` fails first if an upgrade moves it.
//
// The SIGKILL for what ignored the SIGTERM is a short timer, and a timer does not outlive the process: `main` exits right after the last call of the loop returns. So each
// pending SIGKILL is also kept in `pending`, and flushed (the groups that are still there are killed, synchronously, now) when the environment is cleaned up and when the
// process exits (one `exit` listener for the process, not one per environment).
//
// What this cannot stop: a process that makes its own new session or process group (`setsid sh x.sh &`, `python -c 'os.setsid()'`, `perl -e 'setpgrp(0,0)'`) is no longer in the
// call's group and survives; so does anything when the runner itself is killed by a signal (no `exit` event) or crashes. See README, Containment.
import type { Context } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";

/** How long the group has to exit on SIGTERM before it is killed (ms). */
export const REAP_GRACE_MS = 1_000;

const exists = (pgid: number): boolean => {
	try {
		process.kill(-pgid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
};

/** SIGKILL the group if any member is still there. A group id is not reused while any member lives, so a group that is gone is not signalled again (it could be someone else's by now). */
function killIfThere(pgid: number): void {
	if (!exists(pgid)) return;
	try {
		process.kill(-pgid, "SIGKILL");
	} catch {
		// Gone in between.
	}
}

/** The groups that were sent SIGTERM and wait for their SIGKILL, with the timer and the environment (any object; undefined for a bare `reapGroup`) that sent it. */
const pending = new Map<number, { timer: NodeJS.Timeout; owner: object | undefined }>();
let exitHooked = false;

/**
 * SIGKILL, now and synchronously, the groups still waiting out their grace: those of `owner`, or all of them. Returns how many were pending. Safe in an `exit` listener: nothing
 * but `process.kill`.
 */
export function flushReaps(owner?: object): number {
	let flushed = 0;
	for (const [pgid, entry] of [...pending]) {
		if (owner !== undefined && entry.owner !== owner) continue;
		clearTimeout(entry.timer);
		pending.delete(pgid);
		killIfThere(pgid);
		flushed += 1;
	}
	return flushed;
}

/** SIGTERM the process group `pgid`, then SIGKILL it after `graceMs` if any member is still there (earlier when flushed). Never throws; the timer never keeps the process alive. */
export function reapGroup(pgid: number, graceMs: number = REAP_GRACE_MS, owner?: object): void {
	if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 1) return;
	try {
		process.kill(-pgid, "SIGTERM");
	} catch {
		return; // no such group: the command left nothing behind
	}
	if (!exitHooked) {
		exitHooked = true;
		process.on("exit", () => void flushReaps());
	}
	clearTimeout(pending.get(pgid)?.timer);
	const timer = setTimeout(() => {
		pending.delete(pgid);
		killIfThere(pgid);
	}, graceMs);
	timer.unref();
	pending.set(pgid, { timer, owner });
}

const NOT_TRACKED = "pi-durable's NodeExecutionEnv no longer tracks its commands in `activeChildPids`: the runner cannot end a bash call's background processes, so it refuses to run";

/** A set of pids in which each `delete` (the call settled) also ends that pid's process group. It counts what passed through it, for `verifyReaping`. */
class ReapingPids extends Set<number> {
	graceMs: number;
	added = 0;
	settled = 0;

	constructor(graceMs: number) {
		super();
		this.graceMs = graceMs;
	}

	override add(pid: number): this {
		this.added += 1;
		return super.add(pid);
	}

	override delete(pid: number): boolean {
		const had = super.delete(pid);
		if (had) {
			this.settled += 1;
			reapGroup(pid, this.graceMs, this);
		}
		return had;
	}
}

export interface ReapingEnvOptions {
	cwd: string;
	shellEnv?: NodeJS.ProcessEnv;
	/** SIGTERM-to-SIGKILL grace in ms (default `REAP_GRACE_MS`). */
	graceMs?: number;
}

export class ReapingExecutionEnv extends NodeExecutionEnv {
	constructor(options: ReapingEnvOptions) {
		super({ cwd: options.cwd, ...(options.shellEnv ? { shellEnv: options.shellEnv } : {}) });
		const self = this as unknown as { activeChildPids?: unknown };
		if (!(self.activeChildPids instanceof Set)) throw new Error(NOT_TRACKED);
		// `cleanup()` kills what is still tracked and then clears the set: the same set, now with the reaping `delete`.
		const pids = new ReapingPids(options.graceMs ?? REAP_GRACE_MS);
		for (const pid of self.activeChildPids as Set<number>) pids.add(pid);
		pids.added = 0;
		self.activeChildPids = pids;
	}

	/** What the base class kills (the calls still running) and, after it, every group of this environment still waiting for its SIGKILL. */
	override async cleanup(context: Context): Promise<void> {
		try {
			await super.cleanup(context);
		} finally {
			flushReaps((this as unknown as { activeChildPids: object }).activeChildPids);
		}
	}
}

/**
 * Runs one trivial command through `env` and checks that its pid passed through `activeChildPids` (added when it started, deleted when it settled): the hook is a private field of a
 * pinned dependency, and a version that kept the field but tracked its commands elsewhere would pass the constructor's check and silently stop reaping. Throws when it did not.
 * `openRunner` calls it once at start-up, so an upgrade fails there and not in the middle of a loop; tests/reaping-env.test.ts calls it against the installed version.
 */
export async function verifyReaping(env: ReapingExecutionEnv, context: Context): Promise<void> {
	const pids = (env as unknown as { activeChildPids?: unknown }).activeChildPids;
	if (!(pids instanceof ReapingPids)) throw new Error(NOT_TRACKED);
	const [added, settled] = [pids.added, pids.settled];
	const result = await env.exec("true", undefined, context);
	if (!result.ok) throw new Error(`the reaping environment could not run a trivial command: ${result.error.message}`);
	if (pids.added === added || pids.settled === settled) throw new Error(NOT_TRACKED);
}
