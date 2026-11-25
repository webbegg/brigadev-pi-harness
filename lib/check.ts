/**
 * The `check` tool's engine: pick the project's test command (configured,
 * else detected), run it with its real exit code, shape a small result for
 * the model, and record the run in the evidence log exactly as the bash
 * recorder does (extensions/evidence.ts), so the PR gate trusts it.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifyCommand, COMMAND_KIND } from "./command-classifier.ts";
import { readCurrentBranch } from "./commit-branch.ts";
import { appendEvidence, buildRunRecord, checkDirectory, checkKind, checkOutcome, type CheckOutcome, evidenceFile, settleRunTree } from "./evidence.ts";
import { repoDocsDir } from "./repo-docs.ts";
import { riskNotice } from "./risk-map.ts";
import type { ExecFn } from "./worktree-snapshot.ts";
import { worktreeTreeResult } from "./worktree-tree.ts";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;
/** Output kept in memory for the summary; the output file has all of it. */
const MAX_OUTPUT_CHARS = 256 * 1024;
const FAIL_TAIL_LINES = 60;
const PASS_TAIL_LINES = 10;
const TAIL_LINE_CHARS = 300;
const TAIL_MAX_CHARS = 6000;
const HEADER_COMMAND_CHARS = 200;
/** How long to wait for output streams to close after the shell exits (a background child may hold them open). */
const CLOSE_GRACE_MS = 500;
const NPM_PLACEHOLDER = /no test specified/i;

// --- Command selection -----------------------------------------------------

export type CommandChoice = { command: string } | { error: string };

/** `check.test` from the brigadev settings, when it is a non-empty string. */
export function configuredTestCommand(settings: unknown): string | undefined {
	const check = (settings as { check?: { test?: unknown } } | undefined)?.check;
	return typeof check?.test === "string" && check.test.trim() ? check.test.trim() : undefined;
}

/** The test command the project's own files point to, or an error asking for `command`. */
export function detectTestCommand(cwd: string): CommandChoice {
	const manifest = join(cwd, "package.json");
	if (existsSync(manifest)) {
		try {
			const script = (JSON.parse(readFileSync(manifest, "utf8")) as { scripts?: { test?: unknown } }).scripts?.test;
			if (typeof script === "string" && script.trim() && !NPM_PLACEHOLDER.test(script)) return { command: "npm test" };
		} catch {
			// An unreadable package.json says nothing; try the other markers.
		}
	}
	if (existsSync(join(cwd, "pyproject.toml")) || existsSync(join(cwd, "pytest.ini"))) return { command: "pytest -q" };
	if (existsSync(join(cwd, "Cargo.toml"))) return { command: "cargo test" };
	if (existsSync(join(cwd, "go.mod"))) return { command: "go test ./..." };
	return { error: `No test command found in ${cwd} (no package.json test script, pytest.ini/pyproject.toml, Cargo.toml, or go.mod). Pass \`command\`, e.g. \`npm test\`.` };
}

/** The focus as one shell word: plain paths as they are, anything else single-quoted. */
export function withFocus(command: string, focus: string | undefined): string {
	const word = focus?.trim();
	if (!word) return command;
	return `${command} ${/^[\w@%+=:,./~^-]+$/.test(word) ? word : `'${word.replace(/'/g, "'\\''")}'`}`;
}

/** The given command, else the configured one, else the detected one; the focus is appended. */
export function resolveCommand(input: { command?: string; focus?: string; cwd: string; settings?: unknown }): CommandChoice {
	const base = input.command?.trim() || configuredTestCommand(input.settings);
	if (base) return { command: withFocus(base, input.focus) };
	const detected = detectTestCommand(input.cwd);
	return "error" in detected ? detected : { command: withFocus(detected.command, input.focus) };
}

/** Why `check` will not run a command: a test tool never delivers, deletes, or publishes. */
export const CHECK_REFUSAL = "check runs tests; use bash for commits, pushes, PRs, removals, and publishing (those go through the guard's confirmation).";

/** A refusal when the classifier sees a delivery (commit, push, PR), destructive, or publish command in `command`; undefined for anything else. */
export function checkRefusal(command: string): string | undefined {
	const found = classifyCommand(command).filter((match) => match.commit || match.kind === COMMAND_KIND.DELIVERY || match.kind === COMMAND_KIND.DESTRUCTIVE || match.kind === COMMAND_KIND.PUBLISH);
	return found.length > 0 ? `${CHECK_REFUSAL} (${[...new Set(found.map((match) => match.reason))].join("; ")})` : undefined;
}

// --- Counts ----------------------------------------------------------------

export interface Counts {
	pass: number;
	fail: number;
	skipped?: number;
	/** `packages` when the runner (go test) reports per package rather than per test. */
	unit?: "packages";
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");

const counts = (pass: number, fail: number, skipped = 0): Counts => (skipped > 0 ? { pass, fail, skipped } : { pass, fail });

/** `{ passed: 4, failed: 1 }` from "1 failed, 4 passed" style text. */
function tally(text: string): Record<string, number> {
	const found: Record<string, number> = {};
	for (const match of text.matchAll(/(\d+) ([a-z]+)/g)) found[match[2]] = (found[match[2]] ?? 0) + Number(match[1]);
	return found;
}

function nodeCounts(output: string): Counts | undefined {
	const value = (label: string) => {
		// `ℹ pass 5` (spec reporter, a terminal) or `# pass 5` (TAP: Node 22's default when stdout is a pipe).
		const match = new RegExp(`^(?:ℹ|#) ${label} (\\d+)\\s*$`, "m").exec(output);
		return match ? Number(match[1]) : undefined;
	};
	const pass = value("pass");
	return pass === undefined ? undefined : counts(pass, value("fail") ?? 0, value("skipped"));
}

function jestCounts(output: string): Counts | undefined {
	const lines = output.split("\n").filter((line) => /^\s*Tests:?\s+\d/.test(line));
	const line = lines.at(-1);
	if (!line) return undefined;
	const found = tally(line);
	if (found.passed === undefined && found.failed === undefined) return undefined;
	return counts(found.passed ?? 0, found.failed ?? 0, found.skipped);
}

function cargoCounts(output: string): Counts | undefined {
	let pass = 0, fail = 0, ignored = 0, seen = false;
	for (const match of output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)) {
		seen = true;
		pass += Number(match[1]);
		fail += Number(match[2]);
		ignored += Number(match[3]);
	}
	return seen ? counts(pass, fail, ignored) : undefined;
}

function pytestCounts(output: string): Counts | undefined {
	const lines = output.split("\n").filter((line) => /^[=\s]*(?:\d+ (?:passed|failed|errors?|skipped|xfailed|xpassed|deselected|warnings?)(?:, )?)+ in [\d.]+s/.test(line));
	const line = lines.at(-1);
	if (!line) return undefined;
	const found = tally(line.replace(/ in [\d.]+s.*$/, ""));
	if (found.passed === undefined && found.failed === undefined && found.error === undefined && found.errors === undefined) return undefined;
	return counts(found.passed ?? 0, (found.failed ?? 0) + (found.error ?? 0) + (found.errors ?? 0), found.skipped);
}

function goCounts(output: string): Counts | undefined {
	const ok = output.match(/^ok\s+\S+\s+(?:[\d.]+s|\(cached\))/gm)?.length ?? 0;
	const failed = output.match(/^FAIL\s+\S+\s+(?:[\d.]+s|\[)/gm)?.length ?? 0;
	return ok + failed > 0 ? { pass: ok, fail: failed, unit: "packages" } : undefined;
}

/** Pass/fail counts from node --test, jest/vitest, cargo, pytest, or go test output; undefined when none is recognized. */
export function parseCounts(output: string): Counts | undefined {
	const text = stripAnsi(output);
	return nodeCounts(text) ?? jestCounts(text) ?? cargoCounts(text) ?? pytestCounts(text) ?? goCounts(text);
}

export function formatCounts(c: Counts): string {
	const passed = c.unit === "packages" ? `${c.pass} packages ok` : `${c.pass} passed`;
	return `${passed}, ${c.fail} failed${c.skipped ? `, ${c.skipped} skipped` : ""}`;
}

// --- Result shaping --------------------------------------------------------

export interface ShapeInput {
	command: string;
	exitCode?: number;
	/** Signal that ended the run, when the exit code is missing. */
	signal?: string;
	timedOut?: boolean;
	aborted?: boolean;
	durationMs: number;
	output: string;
	outputFile?: string;
}

function tailText(output: string, lines: number): string {
	const kept = stripAnsi(output)
		.trimEnd()
		.split("\n")
		.slice(-lines)
		.map((line) => (line.length > TAIL_LINE_CHARS ? `${line.slice(0, TAIL_LINE_CHARS)}…` : line))
		.join("\n");
	return kept.length > TAIL_MAX_CHARS ? `…${kept.slice(-TAIL_MAX_CHARS)}` : kept;
}

/**
 * The model-facing result: `PASS|FAIL exit=<n> <duration>s: <command>`, the
 * counts when recognized, the last 60 lines on a failure (the last 10 on a
 * pass whose counts were not recognized), and the output file's path.
 */
export function shapeResult(input: ShapeInput): string {
	const passed = input.exitCode === 0 && !input.timedOut && !input.aborted;
	const exit = input.timedOut ? "timeout" : input.aborted ? "aborted" : (input.exitCode ?? input.signal ?? "none");
	const command = input.command.length > HEADER_COMMAND_CHARS ? `${input.command.slice(0, HEADER_COMMAND_CHARS)}…` : input.command;
	const found = parseCounts(input.output);
	const lines = [`${passed ? "PASS" : "FAIL"} exit=${exit} ${(input.durationMs / 1000).toFixed(1)}s: ${command}`];
	if (found) lines.push(formatCounts(found));
	const tail = passed && found ? "" : tailText(input.output, passed ? PASS_TAIL_LINES : FAIL_TAIL_LINES);
	if (tail) lines.push(tail);
	if (input.outputFile) lines.push(`full output: ${input.outputFile}`);
	return lines.join("\n");
}

// --- Evidence outcome ------------------------------------------------------

// A separator or construct after which the shell's exit code may not be the test's.
const UNTRUSTED_SHELL = /\|\||;|\n|`|\$\(|(?<![&>])&(?![&>\d-])/;

/**
 * "pass" or "fail" from the real exit code when it is the test's: the command
 * runs under `set -o pipefail`, so a pipe keeps it; `;`, `||`, `&`, a newline,
 * or a substitution hands it to something else. A recognized runner also gets
 * the evidence recorder's own checks (a `--help` or `--collect-only` run is not a
 * test run).
 */
export function evidenceOutcome(command: string, exitCode: number | undefined): CheckOutcome {
	if (exitCode === undefined) return "unknown";
	if (checkKind(command) !== undefined) return checkOutcome(`set -o pipefail; ${command}`, exitCode);
	if (UNTRUSTED_SHELL.test(command)) return "unknown";
	return exitCode === 0 ? "pass" : "fail";
}

// --- Running ---------------------------------------------------------------

export interface RunOptions {
	command: string;
	cwd: string;
	timeoutMs: number;
	signal?: AbortSignal;
	/** The complete output is written here. */
	outputFile: string;
}

export interface RunOutcome {
	exitCode?: number;
	signal?: string;
	timedOut: boolean;
	aborted: boolean;
	durationMs: number;
	/** The end of the combined stdout and stderr (the file has all of it). */
	output: string;
}

/** An empty output file in a fresh private temp folder. */
export function createOutputFile(): string {
	return join(mkdtempSync(join(tmpdir(), "brigadev-check-")), "output.log");
}

/**
 * Runs `command` in bash under `set -o pipefail` (so the exit code is the
 * runner's through a pipe), in its own process group, which a timeout or an
 * abort kills as a whole. Output goes to `outputFile` as it arrives.
 */
export function runCommand(options: RunOptions): Promise<RunOutcome> {
	const started = Date.now();
	return new Promise((resolve) => {
		const fd = openSync(options.outputFile, "w", 0o600);
		let tail = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let graceTimer: NodeJS.Timeout | undefined;

		// A parent `node --test` run marks its children with NODE_TEST_CONTEXT; a nested runner would skip its files.
		const { NODE_TEST_CONTEXT: _inherited, ...env } = process.env;
		const child = spawn("bash", ["-c", `set -o pipefail; ${options.command}`], {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});

		const kill = () => {
			try {
				if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
			} catch {
				try {
					child.kill("SIGKILL");
				} catch {
					// Already gone.
				}
			}
		};
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			try {
				closeSync(fd);
			} catch {
				// The output file is a convenience.
			}
			resolve({
				exitCode: exit?.code ?? undefined,
				signal: exit?.signal ?? undefined,
				timedOut,
				aborted,
				durationMs: Date.now() - started,
				output: tail,
			});
		};

		const take = (chunk: string) => {
			try {
				writeSync(fd, chunk);
			} catch {
				// Keep running; the summary still has the tail.
			}
			tail += chunk;
			if (tail.length > MAX_OUTPUT_CHARS) tail = tail.slice(-MAX_OUTPUT_CHARS);
		};
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", take);
		}
		child.on("error", (error) => {
			take(`could not start bash: ${error.message}\n`);
			finish();
		});
		child.on("exit", (code, signal) => {
			exit = { code, signal };
			graceTimer = setTimeout(finish, CLOSE_GRACE_MS);
		});
		child.on("close", finish);
	});
}

// --- The tool --------------------------------------------------------------

export interface CheckRequest {
	command?: string;
	focus?: string;
	timeoutSeconds?: number;
}

export interface CheckEnvironment {
	cwd: string;
	exec: ExecFn;
	signal?: AbortSignal;
	/** "parent" or the subagent name. */
	agent: string;
	/** The brigadev settings (`check.test` is the configured command). */
	settings?: unknown;
}

export interface CheckDetails {
	command: string;
	exitCode?: number;
	outcome: CheckOutcome;
	outputFile: string;
	durationMs: number;
	counts?: Counts;
	/** Whether an evidence record was written (no git, or a write failure, means no). */
	recorded: boolean;
}

export interface CheckResult {
	text: string;
	isError?: boolean;
	details?: CheckDetails;
}

/** Trees of a repository's worktree: the full one and the one without docs; undefined without git or on a failure. */
const trees = async (dir: string) => {
	const result = await worktreeTreeResult(dir, { sourceTree: true });
	return result.kind === "tree" ? result : undefined;
};

function timeoutMs(seconds: number | undefined): number {
	const value = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.max(value, 1), MAX_TIMEOUT_SECONDS) * 1000;
}

/** The command `check` runs when the request names none: the configured or detected test command, with the focus. */
function defaultCommand(focus: string | undefined, env: CheckEnvironment): string | undefined {
	const choice = resolveCommand({ focus, cwd: env.cwd, settings: env.settings });
	return "command" in choice ? choice.command : undefined;
}

const NOT_RECORDED = "Not recorded as test evidence: this is not a recognized test runner or the configured/detected test command, so it does not count as test evidence for the PR gate. Run the tests (omit `command`, or use the project's test command).";

export async function runCheck(request: CheckRequest, env: CheckEnvironment): Promise<CheckResult> {
	const choice = resolveCommand({ command: request.command, focus: request.focus, cwd: env.cwd, settings: env.settings });
	if ("error" in choice) return { text: `Error: ${choice.error}`, isError: true };
	const { command } = choice;
	const refusal = checkRefusal(command);
	if (refusal) return { text: `Error: ${refusal}`, isError: true };

	const dir = checkDirectory(command, env.cwd);
	let before: Awaited<ReturnType<typeof trees>>;
	try {
		before = await trees(dir);
	} catch {
		before = undefined;
	}
	const outputFile = createOutputFile();
	const run = await runCommand({ command, cwd: env.cwd, timeoutMs: timeoutMs(request.timeoutSeconds), signal: env.signal, outputFile });

	let outcome: CheckOutcome = run.timedOut || run.aborted ? "unknown" : evidenceOutcome(command, run.exitCode);
	let recorded = false;
	// Only a test run vouches for a tree: a runner the evidence recorder recognizes, or the configured/detected test command
	// (whatever its name). Any other command (`true`, `echo ok`) says nothing about the tests, so it leaves no record.
	const vouches = checkKind(command) === "test" || command === defaultCommand(request.focus, env);
	if (!vouches) outcome = "unknown";
	try {
		if (vouches) {
			const after = await trees(dir);
			const settled = settleRunTree(before?.tree, after?.tree, before?.sourceTree, after?.sourceTree);
			if (settled.record) {
				const branch = await readCurrentBranch(env.exec, dir);
				const record = buildRunRecord({
					ts: new Date().toISOString(),
					branch,
					tree: settled.tree,
					srcTree: settled.srcTree,
					note: settled.note,
					cwd: env.cwd,
					topLevel: after?.root,
					agent: env.agent,
					command,
					exitCode: run.exitCode,
					output: run.output,
				});
				// This tool runs tests by definition, whatever the command's name: the kind and the outcome are the tool's, not the command-pattern guess.
				record.kind = "test";
				record.outcome = settled.note ? "unknown" : outcome;
				outcome = record.outcome;
				appendEvidence(evidenceFile(repoDocsDir(dir), branch), record);
				recorded = true;
			}
		}
	} catch {
		// Evidence is best effort: a failed write must not hide the test result.
	}

	const shaped = shapeResult({ command, exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, aborted: run.aborted, durationMs: run.durationMs, output: run.output, outputFile });
	// One risk line, only when the branch's tier or categories changed since the last one; never fatal.
	const notice = await riskNotice(env.exec, dir, env.settings);
	return {
		text: `${vouches ? shaped : `${shaped}\n${NOT_RECORDED}`}${notice ? `\n${notice}` : ""}`,
		details: { command, exitCode: run.exitCode, outcome, outputFile, durationMs: run.durationMs, counts: parseCounts(run.output), recorded },
	};
}
