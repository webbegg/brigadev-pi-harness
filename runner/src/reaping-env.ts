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
// What this cannot stop: a process that makes its own new session (`setsid sh x.sh &`, `python -c 'os.setsid()'`) is no longer in the call's group and survives. See
// README, Containment.
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

/** SIGTERM the process group `pgid`, then SIGKILL it after `graceMs` if any member is still there. Never throws; the timer never keeps the process alive. */
export function reapGroup(pgid: number, graceMs: number = REAP_GRACE_MS): void {
	if (process.platform === "win32" || !Number.isInteger(pgid) || pgid <= 1) return;
	try {
		process.kill(-pgid, "SIGTERM");
	} catch {
		return; // no such group: the command left nothing behind
	}
	const timer = setTimeout(() => {
		// A group id is not reused while any member lives, so a group that is gone is not signalled again (it could be someone else's by now).
		if (!exists(pgid)) return;
		try {
			process.kill(-pgid, "SIGKILL");
		} catch {
			// Gone in between.
		}
	}, graceMs);
	timer.unref();
}

/** A set of pids in which each `delete` (the call settled) also ends that pid's process group. */
class ReapingPids extends Set<number> {
	graceMs: number;

	constructor(graceMs: number) {
		super();
		this.graceMs = graceMs;
	}

	override delete(pid: number): boolean {
		const had = super.delete(pid);
		if (had) reapGroup(pid, this.graceMs);
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
		if (!(self.activeChildPids instanceof Set)) {
			throw new Error("pi-durable's NodeExecutionEnv no longer tracks its commands in `activeChildPids`: the runner cannot end a bash call's background processes, so it refuses to run");
		}
		// `cleanup()` kills what is still tracked and then clears the set: the same set, now with the reaping `delete`.
		const pids = new ReapingPids(options.graceMs ?? REAP_GRACE_MS);
		for (const pid of self.activeChildPids as Set<number>) pids.add(pid);
		self.activeChildPids = pids;
	}
}
