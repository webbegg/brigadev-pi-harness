// A shell command the runner runs for the agent's work (the ticket's `done` check): in its own process group, with the contained environment, a timeout,
// and bounded output. A timeout or an abort kills the whole group (a test runner's children included), never just the shell.
import { spawn } from "node:child_process";

/** How long a `done` command or a suite may run before it is killed (settings `runner.doneTimeoutMinutes` overrides). */
export const DEFAULT_DONE_TIMEOUT_MINUTES = 30;
/** Output kept: its tail. */
export const MAX_TAIL_BYTES = 1024 * 1024;

export interface ShellResult {
	exitCode: number | null;
	/** Combined stdout and stderr: the last `MAX_TAIL_BYTES` characters. */
	output: string;
	timedOut: boolean;
}

export interface ShellOptions {
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	timeoutMs?: number;
	maxTail?: number;
	/** The shell: `sh` (the ticket's `done` command). */
	shell?: string;
}

/** The timeout in ms from the brigadev settings (`runner.doneTimeoutMinutes`, a positive number), else the default. */
export function doneTimeoutMs(settings: unknown): number {
	const minutes = (settings as { runner?: { doneTimeoutMinutes?: unknown } } | undefined)?.runner?.doneTimeoutMinutes;
	return (typeof minutes === "number" && Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_DONE_TIMEOUT_MINUTES) * 60_000;
}

/** Kill a process group; falls back to the child alone when the group is gone or never existed. */
export function killGroup(pid: number | undefined, fallback?: () => void): void {
	try {
		if (pid !== undefined) process.kill(-pid, "SIGKILL");
	} catch {
		try {
			fallback?.();
		} catch {
			// Already gone.
		}
	}
}

/** Rejects with an AbortError when `signal` aborts (after killing the group), like the `signal` option of `spawn`. */
export function runShell(command: string, cwd: string, options: ShellOptions = {}): Promise<ShellResult> {
	const maxTail = options.maxTail ?? MAX_TAIL_BYTES;
	return new Promise((resolve, reject) => {
		if (options.signal?.aborted) return reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
		let output = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		const child = spawn(options.shell ?? "sh", ["-c", command], { cwd, env: options.env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
		const kill = () => killGroup(child.pid, () => child.kill("SIGKILL"));
		const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const finish = (settle: () => void) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			settle();
		};
		const take = (chunk: Buffer) => {
			output += chunk.toString("utf8");
			if (output.length > maxTail * 2) output = output.slice(-maxTail);
		};
		child.stdout.on("data", take);
		child.stderr.on("data", take);
		child.on("error", (error) => finish(() => reject(error)));
		child.on("close", (exitCode) =>
			finish(() => {
				if (aborted) return reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));
				const tail = output.length > maxTail ? output.slice(-maxTail) : output;
				resolve({ exitCode, output: timedOut ? `${tail}\n(killed: no result within ${Math.round((options.timeoutMs ?? 0) / 1000)} s)` : tail, timedOut });
			}),
		);
	});
}
