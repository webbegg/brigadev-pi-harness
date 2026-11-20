// The `ExecFn` the lib/ rules take (they were written for Pi's `pi.exec`), over node:child_process.
import { execFile } from "node:child_process";
import type { ExecFn } from "../../lib/worktree-snapshot.ts";

export const nodeExec: ExecFn = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options.cwd, timeout: options.timeout, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
			const code = (error as { code?: unknown } | null)?.code;
			resolve({ stdout: String(stdout), stderr: String(stderr), code: error ? (typeof code === "number" ? code : 1) : 0 });
		});
	});
