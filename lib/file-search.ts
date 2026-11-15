// `fd` and `rg` as tools. Pure argument building, output filtering, and path
// rules, plus a bounded process runner. Binaries are only ever taken from the
// system PATH; nothing is downloaded. Arguments go as argv (no shell), the
// process runs in the project cwd with a time and output cap, and sensitive
// files (lib/permission-policy.ts) are kept out of the results.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { decideFileAccess } from "./guard-rules.ts";
import { canonicalPath, expandHome } from "./paths.ts";
import { isSensitivePath } from "./permission-policy.ts";

export const FD_DEFAULT_LIMIT = 1000;
export const FD_MAX_LIMIT = 10_000;
export const FD_MAX_DEPTH = 64;
export const RG_DEFAULT_COUNT = 100;
export const RG_MAX_COUNT = 1000;
export const RG_MAX_CONTEXT = 20;

/** A search never runs longer than this. */
export const SEARCH_TIMEOUT_MS = 30_000;
/** Raw output the runner keeps before it stops the process. */
export const SEARCH_CAPTURE_BYTES = 4 * 1024 * 1024;
/** Output returned to the model. */
export const OUTPUT_MAX_LINES = 2000;
export const OUTPUT_MAX_BYTES = 50 * 1024;
const STDERR_MAX_BYTES = 16 * 1024;
const ERROR_NOTE_CHARS = 300;

/**
 * Globs for the files `isSensitivePath` (lib/permission-policy.ts) treats as
 * secret-bearing: passed to rg as `--glob '!…'` and to fd as `--exclude …`.
 * The result lines are filtered with `isSensitivePath` itself as well, so a
 * drift here cannot leak a file; it can only cost a wasted search.
 */
export const SENSITIVE_GLOBS: readonly string[] = [
	"**/.env*",
	"**/.ssh",
	"**/.aws/credentials",
	"**/.npmrc",
	"**/.netrc",
	"**/id_rsa*",
	"**/id_ed25519*",
	"**/id_ecdsa*",
	"**/id_dsa*",
	"**/*.pem",
	"**/*.key",
	"**/*.p12",
	"**/*.pfx",
	"**/credentials.json",
	"**/.pi/agent/auth.json",
];

// ---------------------------------------------------------------- binaries

export interface PathEnv {
	PATH?: string;
	PATHEXT?: string;
}

function isExecutableFile(file: string, platform: NodeJS.Platform): boolean {
	try {
		if (!statSync(file).isFile()) return false;
		if (platform !== "win32") accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

/** Absolute path of the first of `names` found as an executable file in an absolute PATH entry; undefined when none. */
export function resolveOnPath(names: readonly string[], env: PathEnv = process.env, platform: NodeJS.Platform = process.platform): string | undefined {
	const dirs = (env.PATH ?? "").split(delimiter).filter((dir) => dir && isAbsolute(dir));
	const extensions = platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)] : [""];
	for (const name of names) {
		for (const dir of dirs) {
			for (const extension of extensions) {
				const candidate = join(dir, name + extension);
				if (isExecutableFile(candidate, platform)) return candidate;
			}
		}
	}
	return undefined;
}

// --------------------------------------------------------------- arguments

export interface FdParams {
	pattern?: string;
	path?: string;
	type?: "file" | "directory" | "symlink";
	extension?: string;
	glob?: boolean;
	hidden?: boolean;
	max_depth?: number;
	limit?: number;
}

export interface RgParams {
	pattern: string;
	path?: string;
	glob?: string;
	file_type?: string;
	case_sensitive?: boolean;
	fixed_strings?: boolean;
	hidden?: boolean;
	context?: number;
	limit?: number;
}

export interface BuildOptions {
	/** Pass the sensitive-file excludes (default true). */
	excludeSensitive?: boolean;
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.floor(value)));

/** Models sometimes prefix paths with `@`; the built-in tools strip it, so do we. */
export function normalizeSearchPath(raw: string): string {
	let path = raw.trim();
	if (path.startsWith("@")) path = path.slice(1);
	if (path === "~") return homedir();
	if (path.startsWith("~/")) return join(homedir(), path.slice(2));
	return path;
}

const optionalPath = (raw: string | undefined): string | undefined => {
	const path = raw === undefined ? "" : normalizeSearchPath(raw);
	return path === "" ? undefined : path;
};

const FD_TYPE_FLAGS = { file: "f", directory: "d", symlink: "l" } as const;

export function buildFdArgs(params: FdParams, options: BuildOptions = {}): string[] {
	const args = ["--color=never"];
	if (params.hidden) args.push("--hidden");
	if (params.glob) args.push("--glob");
	if (params.type && params.type in FD_TYPE_FLAGS) args.push("--type", FD_TYPE_FLAGS[params.type]);
	if (params.extension) args.push("--extension", params.extension.replace(/^\.+/, ""));
	if (params.max_depth !== undefined) args.push("--max-depth", String(clamp(params.max_depth, 1, FD_MAX_DEPTH)));
	args.push("--max-results", String(clamp(params.limit ?? FD_DEFAULT_LIMIT, 1, FD_MAX_LIMIT)));
	if (options.excludeSensitive !== false) for (const glob of SENSITIVE_GLOBS) args.push("--exclude", glob);
	// An empty pattern matches everything, which keeps `path` usable without one.
	args.push("--", params.pattern ?? "");
	const path = optionalPath(params.path);
	if (path) args.push(path);
	return args;
}

export function buildRgArgs(params: RgParams, options: BuildOptions = {}): string[] {
	// --null ends the file name with a NUL byte, so result lines split on the path unambiguously.
	const args = ["--line-number", "--color=never", "--no-heading", "--with-filename", "--null", "--max-columns", "500", "--max-columns-preview"];
	if (params.case_sensitive === true) args.push("--case-sensitive");
	else if (params.case_sensitive === false) args.push("--ignore-case");
	else args.push("--smart-case");
	if (params.fixed_strings) args.push("--fixed-strings");
	if (params.hidden) args.push("--hidden");
	if (params.context !== undefined) args.push("--context", String(clamp(params.context, 0, RG_MAX_CONTEXT)));
	if (params.glob) args.push("--glob", params.glob);
	// After the model's glob: a later glob wins, so the model cannot re-include a sensitive file.
	if (options.excludeSensitive !== false) for (const glob of SENSITIVE_GLOBS) args.push("--glob", `!${glob}`);
	if (params.file_type) args.push("--type", params.file_type);
	args.push("--max-count", String(clamp(params.limit ?? RG_DEFAULT_COUNT, 1, RG_MAX_COUNT)));
	args.push("--", params.pattern);
	const path = optionalPath(params.path);
	if (path) args.push(path);
	return args;
}

// --------------------------------------------------------------- filtering

export interface Filtered {
	lines: string[];
	/** Result lines dropped because they name a sensitive file. */
	omitted: number;
}

/** fd prints one path per line. */
export function filterFdLines(lines: readonly string[], allowSensitive: boolean): Filtered {
	if (allowSensitive) return { lines: [...lines], omitted: 0 };
	const kept = lines.filter((line) => !isSensitivePath(line));
	return { lines: kept, omitted: lines.length - kept.length };
}

/** rg `--null` output (`path\0LINE:text`, context `path\0LINE-text`) back to `path:LINE:text`, minus sensitive files. */
export function filterRgLines(stdout: string, allowSensitive: boolean): Filtered {
	const raw = stdout.split("\n");
	if (raw.at(-1) === "") raw.pop();
	const lines: string[] = [];
	let omitted = 0;
	for (const line of raw) {
		const nul = line.indexOf("\0");
		const path = nul === -1 ? line : line.slice(0, nul);
		// A line without a NUL has no file name field; check it whole, in case it is a bare path.
		if (!allowSensitive && isSensitivePath(path)) {
			omitted += 1;
			continue;
		}
		if (nul === -1) {
			lines.push(line);
			continue;
		}
		const rest = line.slice(nul + 1);
		const match = /^(\d+)([:-])([\s\S]*)$/.exec(rest);
		lines.push(match ? `${path}${match[2]}${match[1]}${match[2]}${match[3]}` : `${path}:${rest}`);
	}
	return { lines, omitted };
}

// ------------------------------------------------------------------ runner

export interface RunOptions {
	cwd: string;
	timeoutMs: number;
	/** Raw stdout bytes kept; the process is killed past it. */
	maxBytes: number;
	signal?: AbortSignal;
}

export interface RunResult {
	stdout: string;
	stderr: string;
	/** null when the process was killed or could not start. */
	code: number | null;
	timedOut: boolean;
	/** stdout exceeded `maxBytes`. */
	capped: boolean;
}

export type SearchRunner = (command: string, args: string[], options: RunOptions) => Promise<RunResult>;

/** Runs a program by argv (no shell, stdin closed), killing it at the time or output limit or on abort. */
export const runBounded: SearchRunner = (command, args, options) =>
	new Promise<RunResult>((resolveRun) => {
		const out: Buffer[] = [];
		const err: Buffer[] = [];
		let outBytes = 0;
		let errBytes = 0;
		let timedOut = false;
		let capped = false;
		let aborted = false;
		let settled = false;
		let child: ReturnType<typeof spawn> | undefined;

		const finish = (code: number | null, extraStderr = "") => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			let stdout = Buffer.concat(out).toString("utf8");
			// A run we cut short ends mid-line; the partial last line could be half a path, so it is dropped.
			if ((timedOut || capped || aborted) && !stdout.endsWith("\n")) stdout = stdout.slice(0, stdout.lastIndexOf("\n") + 1);
			resolveRun({ stdout, stderr: `${Buffer.concat(err).toString("utf8")}${extraStderr}`.trim(), code, timedOut, capped });
		};
		const stop = () => {
			try {
				child?.kill("SIGKILL");
			} catch {
				// already gone
			}
		};
		const onAbort = () => {
			aborted = true;
			stop();
		};
		const timer = setTimeout(() => {
			timedOut = true;
			stop();
		}, options.timeoutMs);

		if (options.signal?.aborted) {
			clearTimeout(timer);
			aborted = true;
			finish(null);
			return;
		}
		options.signal?.addEventListener("abort", onAbort, { once: true });

		try {
			child = spawn(command, args, { cwd: options.cwd, shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
		} catch (error) {
			finish(null, error instanceof Error ? error.message : String(error));
			return;
		}
		child.stdout?.on("data", (chunk: Buffer) => {
			if (capped) return;
			const room = options.maxBytes - outBytes;
			if (chunk.length > room) {
				out.push(chunk.subarray(0, Math.max(0, room)));
				outBytes = options.maxBytes;
				capped = true;
				stop();
				return;
			}
			out.push(chunk);
			outBytes += chunk.length;
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			if (errBytes >= STDERR_MAX_BYTES) return;
			err.push(chunk.subarray(0, STDERR_MAX_BYTES - errBytes));
			errBytes += chunk.length;
		});
		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
	});

// ------------------------------------------------------------- path policy

export interface SearchContext {
	/** The session's working directory; the process runs here. */
	cwd: string;
	projectRoot: string;
	isChild: boolean;
	/** Subagent name, for messages. */
	agent?: string;
	/** Asks the user; answers no without a UI. */
	confirm: (title: string, body: string) => Promise<boolean>;
	signal?: AbortSignal;
}

export type PathDecision = { action: "allow"; allowSensitive: boolean } | { action: "block"; reason: string };

/**
 * The same rule as `read`: lib/guard-rules.ts `decideFileAccess` with a read.
 * An explicit sensitive path asks the user (a subagent is blocked); once the
 * user allows it, the excludes and result filter are lifted for that run. A
 * path outside the project is allowed, as for `read`.
 */
export async function decideSearchPath(rawPath: string | undefined, context: SearchContext): Promise<PathDecision> {
	const normalized = rawPath === undefined ? "" : normalizeSearchPath(rawPath);
	const shown = normalized || ".";
	const target = canonicalPath(resolve(context.cwd, expandHome(normalized || ".")));
	// A directory is sensitive when its contents would be: `~/.ssh` has no trailing slash, the policy pattern does.
	const sensitive = isSensitivePath(target) || isSensitivePath(`${target}/`);
	const decision = decideFileAccess({
		isChild: context.isChild,
		isWrite: false,
		absolutePath: target,
		projectRoot: context.projectRoot,
		docsDir: context.cwd,
		sensitive,
		readOnly: false,
		surfaces: undefined,
		rawPath: shown,
		agent: context.agent,
	});
	if (decision.action === "block") return { action: "block", reason: decision.reason };
	if (decision.action === "allow") return { action: "allow", allowSensitive: false };
	if (decision.kind === "sensitive") {
		const ok = await context.confirm("brigadev: sensitive file", `search ${shown}\n\nThis path commonly holds secrets or credentials. Allow?`);
		if (!ok) return { action: "block", reason: `User declined access to sensitive file ${shown}` };
		if (decision.then.action === "block") return { action: "block", reason: decision.then.reason };
		return { action: "allow", allowSensitive: true };
	}
	const ok = await context.confirm("brigadev: path outside project", `search ${target}\n\nOutside the project root ${context.projectRoot}. Allow?`);
	return ok ? { action: "allow", allowSensitive: false } : { action: "block", reason: `User declined search outside the project root: ${target}` };
}

// ----------------------------------------------------------------- execute

export interface SearchOutput {
	text: string;
	/** Result lines shown. */
	matchCount: number;
	/** Output was cut by a cap, a timeout, or the capture limit. */
	truncated: boolean;
	omittedSensitive: number;
}

/** Longest prefix of `lines` within the line and byte caps. */
function capLines(lines: readonly string[]): string[] {
	const shown: string[] = [];
	let bytes = 0;
	for (const line of lines) {
		const size = Buffer.byteLength(line) + 1;
		if (shown.length >= OUTPUT_MAX_LINES) break;
		if (bytes + size > OUTPUT_MAX_BYTES) {
			if (shown.length === 0) shown.push(line.slice(0, OUTPUT_MAX_BYTES));
			break;
		}
		shown.push(line);
		bytes += size;
	}
	return shown;
}

/** Validates the path, runs fd or rg bounded, filters sensitive files, and shapes the output. Throws on a blocked path or a failed run. */
export async function executeSearch(tool: "fd" | "rg", binary: string, params: FdParams | RgParams, context: SearchContext, run: SearchRunner = runBounded): Promise<SearchOutput> {
	const decision = await decideSearchPath(params.path, context);
	if (decision.action === "block") throw new Error(decision.reason);
	const excludeSensitive = !decision.allowSensitive;
	const args = tool === "rg" ? buildRgArgs(params as RgParams, { excludeSensitive }) : buildFdArgs(params as FdParams, { excludeSensitive });

	const result = await run(binary, args, { cwd: context.cwd, timeoutMs: SEARCH_TIMEOUT_MS, maxBytes: SEARCH_CAPTURE_BYTES, signal: context.signal });
	const cut = result.timedOut || result.capped;
	const noMatchExit = tool === "rg" && result.code === 1;
	const partialRg = tool === "rg" && result.code === 2 && result.stdout.length > 0;
	if (result.code !== 0 && !noMatchExit && !partialRg && !cut) {
		if (context.signal?.aborted) throw new Error(`${tool} search was cancelled.`);
		throw new Error(`${tool} failed: ${result.stderr || (result.code === null ? "the process did not run to completion" : `exit code ${result.code}`)}`);
	}

	const { lines, omitted } =
		tool === "rg" ? filterRgLines(result.stdout, decision.allowSensitive) : filterFdLines(result.stdout.split("\n").filter((line) => line !== ""), decision.allowSensitive);
	const shown = capLines(lines);
	const notes: string[] = [];
	let truncated = false;
	if (shown.length < lines.length) {
		truncated = true;
		notes.push(`Output truncated: showing ${shown.length} of ${lines.length} lines (${OUTPUT_MAX_BYTES / 1024} KB / ${OUTPUT_MAX_LINES} line cap). Narrow the search with path, glob, or a more specific pattern.`);
	}
	if (result.timedOut) {
		truncated = true;
		notes.push(`Search timed out after ${SEARCH_TIMEOUT_MS / 1000}s; results are incomplete.`);
	}
	if (result.capped) {
		truncated = true;
		notes.push("Output exceeded the capture limit; results are incomplete. Narrow the search.");
	}
	if (partialRg && result.stderr) notes.push(`rg reported errors: ${result.stderr.slice(0, ERROR_NOTE_CHARS)}`);
	if (omitted > 0) notes.push(`${omitted} result${omitted === 1 ? "" : "s"} from sensitive files omitted.`);

	const parts: string[] = [];
	if (shown.length > 0) parts.push(shown.join("\n"));
	if (notes.length > 0) parts.push(notes.map((note) => `[${note}]`).join("\n"));
	const text = parts.length === 0 ? (tool === "rg" ? "No matches found" : "No files found") : parts.join("\n\n");
	return { text, matchCount: shown.length, truncated, omittedSensitive: omitted };
}
