/**
 * Evidence log: every check run (tests, lint, typecheck, build) is recorded
 * with its exit code and output tail in `<repo docs>/evidence/<branch>.jsonl`,
 * keyed to the worktree content tree it ran on (lib/worktree-tree.ts).
 *
 * The commit gate reads it: a commit with source changes needs a passing
 * test recorded for the current tree, so any edit after the last passing run
 * blocks the commit until the tests run again. Only the user can force it.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { basename as executableName, blankHeredocs, tokenize, unwrap, type Segment } from "./command-classifier.ts";
import { canonicalPath, isInside } from "./paths.ts";

const MAX_COMMAND_CHARS = 500;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
// Prose only: `.txt` and `.mdx` hold requirements, CMake lists, and components, so they count as source.
const DOC_EXTENSIONS = /\.(md|markdown|rst|adoc)$/i;
const DOC_NAMES = new Set(["LICENSE", "NOTICE", "COPYING", "AUTHORS"]);

const TEST_TOOLS = new Set(["vitest", "jest", "mocha", "pytest", "rspec", "phpunit"]);
const CHECK_TOOLS = new Set(["tsc", "eslint"]);
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const TEST_SCRIPT = /^test(:.*)?$/;
const CHECK_SCRIPT = /^(lint|typecheck|check|build)(:.*)?$/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
// A segment starting with one of these can end the shell, replace it, or run other code before the test.
const CONTROL_WORDS = new Set(["exit", "return", "exec", "trap", "eval", "source", "."]);
const PIPEFAIL_SETTERS = new Set(["-o", "-eo", "-euo"]);
// Runner flags that exit 0 without running a test (help, version, listing, dry runs).
const NO_RUN_FLAGS = new Set(["--help", "-h", "--version", "-V", "--collect-only", "--co", "--listTests", "--list", "--dry-run"]);

export type CheckKind = "test" | "check";
export type CheckOutcome = "pass" | "fail" | "unknown";

export interface RunRecord {
	v: 1;
	type: "run";
	ts: string;
	branch: string | null;
	/** Worktree content tree the command ran on; undefined outside git. */
	tree?: string;
	cwd: string;
	/** "parent" or the subagent name. */
	agent: string;
	command: string;
	kind: CheckKind;
	exitCode?: number;
	outcome: CheckOutcome;
	tail: string;
	/** Why the outcome could not be trusted beyond the command itself (e.g. "tree changed during run"). */
	note?: string;
}

export interface ForceRecord {
	v: 1;
	type: "force";
	ts: string;
	branch: string | null;
	tree?: string;
	/** How the user forced it: "dialog" or "command". */
	via: "dialog" | "command";
	command: string;
}

export type EvidenceRecord = RunRecord | ForceRecord;

/** Skips leading option words (`-y`, `--silent`). */
const skipFlags = (args: string[]): string[] => {
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) i++;
	return args.slice(i);
};

/** Kind of a check run by a tool invoked directly (`vitest`, `cargo test`, `node --test`). */
function toolKind(argv: string[]): CheckKind | undefined {
	const name = executableName(argv[0] ?? "");
	const rest = argv.slice(1);
	if (TEST_TOOLS.has(name)) return "test";
	if (CHECK_TOOLS.has(name)) return "check";
	if ((name === "python" || name === "python3") && rest[0] === "-m" && rest[1] === "pytest") return "test";
	if (name === "node") {
		for (const word of rest) {
			if (!word.startsWith("-")) return undefined;
			if (word === "--test") return "test";
		}
		return undefined;
	}
	const sub = rest[0];
	switch (name) {
		case "cargo":
			return sub === "test" ? "test" : sub === "check" || sub === "build" || sub === "clippy" ? "check" : undefined;
		case "go":
			return sub === "test" ? "test" : sub === "vet" || sub === "build" ? "check" : undefined;
		case "make":
			return sub === "test" ? "test" : sub === "check" ? "check" : undefined;
		case "dotnet":
		case "mvn":
		case "gradle":
		case "gradlew":
			return sub === "test" ? "test" : undefined;
		default:
			return undefined;
	}
}

/** Kind of a check run through a package manager or a runner (`npm run test`, `pnpm exec vitest`, `npx jest`). */
function runnerKind(argv: string[]): CheckKind | undefined {
	const name = executableName(argv[0] ?? "");
	let rest = skipFlags(argv.slice(1));
	if (name === "npx" || name === "bunx") return toolKind(rest);
	if (!PACKAGE_MANAGERS.has(name)) return undefined;
	if (name === "pnpm" && rest[0] === "exec") return toolKind(skipFlags(rest.slice(1)));
	if (rest[0] === "run") rest = skipFlags(rest.slice(1));
	const script = rest[0];
	if (script === undefined) return undefined;
	if (TEST_SCRIPT.test(script)) return "test";
	if (CHECK_SCRIPT.test(script)) return "check";
	return name === "yarn" ? toolKind(rest) : undefined;
}

/** Kind of a segment whose command word is a check runner; a runner named only as an argument is not one. */
function segmentKind(argv: string[]): CheckKind | undefined {
	let i = 0;
	while (i < argv.length && (ASSIGNMENT.test(argv[i]) || argv[i] === "!")) i++;
	const command = argv.slice(i);
	return command.length === 0 ? undefined : (runnerKind(command) ?? toolKind(command));
}

const parse = (command: string): Segment[] => tokenize(blankHeredocs(command), { redirections: true });

/** The first segment that runs a test, else the first that runs another check. */
function firstCheck(segments: Segment[]): { kind: CheckKind; index: number } | undefined {
	let other: { kind: CheckKind; index: number } | undefined;
	for (let index = 0; index < segments.length; index++) {
		const kind = segmentKind(segments[index].argv);
		if (kind === "test") return { kind, index };
		if (kind && !other) other = { kind, index };
	}
	return other;
}

export function checkKind(command: string): CheckKind | undefined {
	return firstCheck(parse(command))?.kind;
}

/** Where the command runs, so a `cd` before the check can be judged. */
export interface CheckContext {
	/** The session's working directory. */
	cwd?: string;
	/** Top level of the git work tree the evidence is keyed to. */
	topLevel?: string;
	/** Home directory for `~` (default: the user's). */
	home?: string;
}

function isPipefailSetter(argv: string[] | undefined): boolean {
	return !!argv && argv.length === 3 && argv[0] === "set" && PIPEFAIL_SETTERS.has(argv[1]) && argv[2] === "pipefail";
}

/** Directory after `cd`/`pushd` from `dir`, or undefined when it cannot be known to be inside `top`. */
function cdTarget(argv: string[], dir: string, top: string, home: string): string | undefined {
	if (executableName(argv[0]) === "popd") return undefined;
	const args = argv.slice(1).filter((word) => word === "-" || !word.startsWith("-"));
	if (args.length > 1 || args[0] === "-") return undefined;
	const raw = args[0] ?? "~";
	if (/[$`*?[{]/.test(raw) || (raw.startsWith("~") && raw !== "~" && !raw.startsWith("~/"))) return undefined;
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
	const target = canonicalPath(resolve(dir, expanded));
	return isInside(top, target) ? target : undefined;
}

/**
 * "pass" or "fail" only when the shell's exit code is the check's. That holds
 * for a plain `&&` chain whose segment is the runner itself: a `;`, `||`, `&`,
 * newline, `!`, comment, subshell, substitution, or a pipe after the check
 * hands the code to something else, and so does an `exit`, `exec`, `eval`, or
 * `source` before it. The one exception is a leading `set -o pipefail;`, which
 * lets a pipe follow the check. A `cd` before the check must stay inside the
 * git top level. Anything else is "unknown".
 */
export function checkOutcome(command: string, exitCode: number | undefined, context: CheckContext = {}): CheckOutcome {
	if (exitCode === undefined) return "unknown";
	const text = blankHeredocs(command);
	if (text.includes("`") || text.includes("$(")) return "unknown";
	// The tokenizer drops a separator that ends the command: `npm test &` runs in the background.
	const end = text.trimEnd();
	if (end.endsWith(";") || (end.endsWith("&") && !end.endsWith("&&"))) return "unknown";
	const segments = tokenize(text, { redirections: true });
	const found = firstCheck(segments);
	if (!found) return "unknown";
	// `-v` is verbose for most runners but the version for node (`node --test -v`).
	const testArgv = segments[found.index].argv;
	if (testArgv.some((word) => NO_RUN_FLAGS.has(word) || (word === "-v" && testArgv.some((w) => executableName(w) === "node")))) return "unknown";

	const pipefail = isPipefailSetter(segments[0]?.argv) && (segments[1]?.before === ";" || segments[1]?.before === "&&");
	for (let i = 0; i < segments.length; i++) {
		const { argv, before } = segments[i];
		const allowed = (i === 0 && before === "") || before === "&&" || (before === ";" && pipefail && i === 1) || (before === "|" && (i <= found.index || pipefail));
		if (!allowed || argv[0] === "!" || argv.some((word) => word.startsWith("#"))) return "unknown";
	}

	let dir = context.cwd ? canonicalPath(context.cwd) : undefined;
	const top = context.topLevel ? canonicalPath(context.topLevel) : undefined;
	for (let i = 0; i < found.index; i++) {
		const { argv: rest } = unwrap(segments[i].argv);
		const words = [...segments[i].argv.slice(0, segments[i].argv.length - rest.length), ...rest.slice(0, 1)];
		if (words.some((word) => CONTROL_WORDS.has(executableName(word)))) return "unknown";
		const name = executableName(rest[0] ?? "");
		if (name === "cd" || name === "pushd" || name === "popd") {
			dir = dir && top ? cdTarget(rest, dir, top, context.home ?? homedir()) : undefined;
			if (!dir) return "unknown";
		}
	}
	return exitCode === 0 ? "pass" : "fail";
}

export function outputTail(output: string, lines = TAIL_LINES): string {
	const tail = output.trimEnd().split("\n").slice(-lines).join("\n");
	return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

export function buildRunRecord(input: { ts: string; branch: string | null; tree?: string; cwd: string; agent: string; command: string; exitCode?: number; output: string; topLevel?: string; note?: string }): RunRecord {
	const record: RunRecord = {
		v: 1,
		type: "run",
		ts: input.ts,
		branch: input.branch,
		tree: input.tree,
		cwd: input.cwd,
		agent: input.agent,
		command: input.command.slice(0, MAX_COMMAND_CHARS),
		kind: checkKind(input.command) ?? "check",
		exitCode: input.exitCode,
		outcome: input.note ? "unknown" : checkOutcome(input.command, input.exitCode, { cwd: input.cwd, topLevel: input.topLevel }),
		tail: outputTail(input.output),
	};
	if (input.note) record.note = input.note;
	return record;
}

/**
 * The tree a run may be keyed to. A run counts for a tree only if that tree
 * was the same before and after it: an edit made while it ran (a parallel tool
 * call, `test && edit`) must not be vouched for. Without the tree before the
 * run, or when it changed, the run is recorded without a tree and as unknown.
 * No tree after the run means no git: nothing is recorded.
 */
export function settleRunTree(before: string | undefined, after: string | undefined): { record: false } | { record: true; tree: string | undefined; note?: string } {
	if (after === undefined) return { record: false };
	if (before === undefined) return { record: true, tree: undefined, note: "tree before the run is unknown" };
	if (before !== after) return { record: true, tree: undefined, note: "tree changed during run" };
	return { record: true, tree: after };
}

export function branchSlug(branch: string | null): string {
	return branch ? branch.replace(/[^A-Za-z0-9._-]+/g, "-") : "detached";
}

export function evidenceFile(docsDir: string, branch: string | null): string {
	return join(docsDir, "evidence", `${branchSlug(branch)}.jsonl`);
}

/** One JSON line per record; appends from several processes stay whole lines. */
export function appendEvidence(file: string, record: EvidenceRecord): void {
	mkdirSync(dirname(file), { recursive: true });
	appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readEvidence(file: string): EvidenceRecord[] {
	if (!existsSync(file)) return [];
	const records: EvidenceRecord[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed?.v === 1 && (parsed.type === "run" || parsed.type === "force")) records.push(parsed);
		} catch {
			// A torn or hand-edited line must not hide the rest of the log.
		}
	}
	return records;
}

/** Prose and legal files never need a test run; everything else is source. */
export function isSourcePath(path: string): boolean {
	return !DOC_EXTENSIONS.test(path) && !DOC_NAMES.has(basename(path));
}

export type GateDecision = { action: "allow"; why: string } | { action: "block"; reason: string };

export interface GateInput {
	/** Paths `git status` reports as changed, project-relative. */
	dirtyPaths: readonly string[];
	/** Current worktree content tree; undefined when git cannot tell. */
	tree: string | undefined;
	/** The commit may run in another directory or on another branch. */
	elsewhere: boolean;
	records: readonly EvidenceRecord[];
	/** Tree a user force (/brigadev:force-commit) was granted for. */
	forcedTree: string | undefined;
}

const UNBLOCK =
	"Run the tests in their own bash command, with the runner as the command itself (`npm test`, `node --test`, ...; optionally in an `&&` chain) so its exit code is the test's: no `;`, `||`, `&`, `!`, comment, subshell, or later `|` unless a leading `set -o pipefail;` is set, and no `cd` out of the repository. Then commit again. If the user wants to commit anyway, only they can force it: the guard asks them when a UI is present; otherwise tell them to run /brigadev:force-commit.";

export function decideCommitGate(input: GateInput): GateDecision {
	if (input.elsewhere) {
		return { action: "block", reason: `Blocked by brigadev evidence gate: this commit runs in another directory or on another branch, so the recorded test runs cannot vouch for it. Commit from the session's directory. ${UNBLOCK}` };
	}
	if (input.tree === undefined) return { action: "allow", why: "no git tree to check" };
	if (!input.dirtyPaths.some(isSourcePath)) return { action: "allow", why: "docs-only changes" };
	if (input.forcedTree === input.tree) return { action: "allow", why: "forced by the user" };
	const runs = input.records.filter((r): r is RunRecord => r.type === "run" && r.kind === "test" && r.tree === input.tree);
	if (runs.some((r) => r.outcome === "pass")) return { action: "allow", why: "passing test on this tree" };
	const last = runs.at(-1);
	const detail = !last
		? "no passing test is recorded for the current working tree (source files changed since the last passing run, or the tests never ran)"
		: last.outcome === "fail"
			? `the last test run on this tree failed (\`${last.command}\`, exit ${last.exitCode})`
			: `the last test run on this tree has no trustworthy exit code (\`${last.command}\`)`;
	return { action: "block", reason: `Blocked by brigadev evidence gate: ${detail}. ${UNBLOCK}` };
}

/** Fields of a tool_result event the recorder reads; anything else about the event is ignored. */
export interface ToolResultLike {
	toolName?: unknown;
	input?: unknown;
	content?: unknown;
	structuredContent?: unknown;
}

const asObject = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" ? (value as Record<string, unknown>) : undefined);

function textOf(content: unknown): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => asObject(part))
		.filter((part) => part?.type === "text" && typeof part.text === "string")
		.map((part) => part?.text as string)
		.join("\n");
}

/**
 * Run record for a finished bash tool call, or undefined when it is not a
 * check command or there is no worktree tree to key it to (no git: nothing is
 * written, so scratch copies never create docs folders). Never throws.
 */
export function runRecordFromResult(event: ToolResultLike | undefined, context: { ts: string; branch: string | null; tree: string | undefined; cwd: string; agent: string; topLevel?: string; note?: string }): RunRecord | undefined {
	try {
		// A note stands in for the tree when it could not be trusted; with neither there is no git to key the run to.
		if (!event || event.toolName !== "bash" || (context.tree === undefined && !context.note)) return undefined;
		const command = asObject(event.input)?.command;
		if (typeof command !== "string" || checkKind(command) === undefined) return undefined;
		const structured = asObject(event.structuredContent);
		const exitCode = typeof structured?.exit_code === "number" ? structured.exit_code : undefined;
		const output = typeof structured?.output === "string" ? structured.output : textOf(event.content);
		return buildRunRecord({ ...context, command, exitCode, output });
	} catch {
		return undefined;
	}
}

export function forceRecord(input: { ts: string; branch: string | null; tree?: string; via: ForceRecord["via"]; command: string }): ForceRecord {
	return { v: 1, type: "force", ts: input.ts, branch: input.branch, tree: input.tree, via: input.via, command: input.command.slice(0, MAX_COMMAND_CHARS) };
}

/** What the user sees when the gate blocks: the reason without the instructions meant for the model. */
export function gateDialog(reason: string, command: string): { title: string; body: string } {
	const detail = reason
		.replace(/^Blocked by brigadev evidence gate:\s*/, "")
		.replace(/\s*(Run the tests in their own|Commit from the session's directory).*$/s, "")
		.trim();
	return {
		title: "brigadev: evidence gate blocked this commit",
		body: `${command.length > 300 ? `${command.slice(0, 300)}…` : command}\n\n${detail}\n\nCommit anyway? Forcing is logged as evidence.`,
	};
}

/**
 * The gate decision with the user's one-shot force applied only when the
 * commit would be blocked without it; `consumedForce` tells the caller to
 * spend the grant and log it.
 */
export function commitGateWithForce(input: GateInput): { decision: GateDecision; consumedForce: boolean } {
	const plain = decideCommitGate({ ...input, forcedTree: undefined });
	if (plain.action === "allow" || input.forcedTree === undefined) return { decision: plain, consumedForce: false };
	const forced = decideCommitGate(input);
	return { decision: forced, consumedForce: forced.action === "allow" };
}
