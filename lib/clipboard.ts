// Copy text to the system clipboard with the platform's own tool. The command is picked by platform and by what is
// installed; it is spawned without a shell, the text goes in on stdin (never in argv), and the wait is bounded.
// The runner and the availability check are injected, so tests never touch a real clipboard.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Upper bound on one copy: a clipboard tool that has not exited by then is killed. */
export const CLIPBOARD_TIMEOUT_MS = 5000;

export interface ClipboardCommand {
	command: string;
	args: string[];
}

export interface RunnerResult {
	/** Exit code, or null when the process did not exit normally (spawn error, timeout). */
	code: number | null;
	error?: string;
	timedOut?: boolean;
}

/** Runs `command` with `args` (no shell), writes `input` to its stdin, and settles when it exits or `timeoutMs` passes. Never rejects. */
export type ClipboardRunner = (command: string, args: string[], input: string, timeoutMs: number) => Promise<RunnerResult>;

export interface ClipboardDeps {
	platform?: NodeJS.Platform;
	env?: Record<string, string | undefined>;
	/** Whether `command` is installed (on PATH). */
	isAvailable?: (command: string) => boolean;
	run?: ClipboardRunner;
	timeoutMs?: number;
}

export type CopyResult = { ok: true; tool: string } | { ok: false; error: string };

/** The candidates for a platform, best first. Linux prefers `wl-copy` under Wayland, then `xclip`, then `xsel`. */
export function clipboardCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): ClipboardCommand[] {
	if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
	if (platform === "win32") return [{ command: "clip", args: [] }];
	if (platform !== "linux") return [];
	const x11: ClipboardCommand[] = [
		{ command: "xclip", args: ["-selection", "clipboard"] },
		{ command: "xsel", args: ["--clipboard", "--input"] },
	];
	return env.WAYLAND_DISPLAY ? [{ command: "wl-copy", args: [] }, ...x11] : x11;
}

/** The first candidate that is installed, or undefined. */
export function pickClipboardCommand(options: { platform: NodeJS.Platform; env: Record<string, string | undefined>; isAvailable: (command: string) => boolean }): ClipboardCommand | undefined {
	return clipboardCandidates(options.platform, options.env).find((candidate) => options.isAvailable(candidate.command));
}

/** What the user is told when no clipboard tool is installed. */
export function missingToolMessage(platform: NodeJS.Platform): string {
	if (platform === "linux") return "No clipboard tool found: install wl-copy, xclip or xsel";
	if (platform === "darwin") return "No clipboard tool found: pbcopy is missing";
	if (platform === "win32") return "No clipboard tool found: clip is missing";
	return `No clipboard tool found: ${platform} is not supported`;
}

/** True when `command` is an executable file in a PATH directory. `clip` is a Windows system binary, so it is taken as present there. */
export function onPath(command: string, env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): boolean {
	if (platform === "win32") return command === "clip" || (env.PATH ?? "").split(path.delimiter).some((dir) => dir && fs.existsSync(path.join(dir, `${command}.exe`)));
	return (env.PATH ?? "").split(path.delimiter).some((dir) => {
		if (!dir) return false;
		try {
			fs.accessSync(path.join(dir, command), fs.constants.X_OK);
			return fs.statSync(path.join(dir, command)).isFile();
		} catch {
			return false;
		}
	});
}

/** The real runner: spawns without a shell, closes stdin after the text, and kills the process at the timeout. */
export const defaultRunner: ClipboardRunner = (command, args, input, timeoutMs) =>
	new Promise((resolve) => {
		let done = false;
		const finish = (result: RunnerResult) => {
			if (done) return;
			done = true;
			clearTimeout(timer);
			resolve(result);
		};
		// stdout and stderr are ignored: xclip and xsel fork and keep inherited pipes open, which would hold a 'close' event forever.
		const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"], shell: false });
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ code: null, timedOut: true });
		}, timeoutMs);
		child.on("error", (error) => finish({ code: null, error: error.message }));
		child.on("exit", (code) => finish({ code }));
		// A tool that exits before reading all of stdin closes the pipe: that is its exit code's business, not an error here.
		child.stdin.on("error", () => {});
		child.stdin.end(input);
	});

/** Copies `text`. Never rejects: every failure is a `{ ok: false, error }` with a message the user can read. */
export async function copyToClipboard(text: string, deps: ClipboardDeps = {}): Promise<CopyResult> {
	const platform = deps.platform ?? process.platform;
	const env = deps.env ?? process.env;
	const picked = pickClipboardCommand({ platform, env, isAvailable: deps.isAvailable ?? ((command) => onPath(command, env, platform)) });
	if (!picked) return { ok: false, error: missingToolMessage(platform) };
	try {
		const result = await (deps.run ?? defaultRunner)(picked.command, picked.args, text, deps.timeoutMs ?? CLIPBOARD_TIMEOUT_MS);
		if (result.timedOut) return { ok: false, error: `${picked.command} timed out after ${(deps.timeoutMs ?? CLIPBOARD_TIMEOUT_MS) / 1000}s` };
		if (result.error !== undefined) return { ok: false, error: `${picked.command} failed: ${result.error}` };
		if (result.code !== 0) return { ok: false, error: `${picked.command} exited with code ${result.code}` };
		return { ok: true, tool: picked.command };
	} catch (error) {
		return { ok: false, error: `${picked.command} failed: ${error instanceof Error ? error.message : String(error)}` };
	}
}
