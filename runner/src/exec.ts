// The `ExecFn` the lib/ rules take (they were written for Pi's `pi.exec`), over node:child_process.
import { execFile } from "node:child_process";
import type { PrExec } from "../../lib/pr-info.ts";
import type { ExecFn } from "../../lib/worktree-snapshot.ts";

export const nodeExec: ExecFn = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options.cwd, timeout: options.timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = (error as { code?: unknown } | null)?.code;
			resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? (typeof code === "number" ? code : 1) : 0 });
		});
	});

/** The lib rules take the narrower `ExecFn`; a missing exit code (a killed process) reads as a failure. */
export const asExec = (exec: PrExec): ExecFn => async (command, args, options) => {
	const result = await exec(command, args, options);
	return { stdout: result.stdout, stderr: result.stderr, code: result.code ?? 1 };
};
