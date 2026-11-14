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
import { basename, dirname, join } from "node:path";

const TEST_COMMAND =
	/\b(npm|pnpm|yarn|bun)\s+(run\s+)?test\b|\bnode\s+--test\b|\b(vitest|jest|mocha|pytest|rspec|phpunit|cargo\s+test|go\s+test|make\s+test|dotnet\s+test|mvn\s+test|gradlew?\s+test)\b/;
const OTHER_CHECK_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|typecheck|check|build)\b|\b(tsc|eslint|cargo\s+(check|build|clippy)|go\s+(vet|build)|make\s+check)\b/;

const MAX_COMMAND_CHARS = 500;
const TAIL_LINES = 20;
const TAIL_CHARS = 2000;
const DOC_EXTENSIONS = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const DOC_NAMES = new Set(["LICENSE", "NOTICE", "COPYING", "AUTHORS"]);

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

function firstCheck(command: string): { kind: CheckKind; end: number } | undefined {
	const test = TEST_COMMAND.exec(command);
	if (test) return { kind: "test", end: test.index + test[0].length };
	const other = OTHER_CHECK_COMMAND.exec(command);
	return other ? { kind: "check", end: other.index + other[0].length } : undefined;
}

export function checkKind(command: string): CheckKind | undefined {
	return firstCheck(command)?.kind;
}

/**
 * "pass" or "fail" only when the shell's exit code belongs to the check: a
 * later `;`, `||`, `&`, newline, or pipe (without pipefail) hands it to
 * another command, so the outcome is unknown. `&&` keeps it.
 */
export function checkOutcome(command: string, exitCode: number | undefined): CheckOutcome {
	const found = firstCheck(command);
	if (!found || exitCode === undefined) return "unknown";
	const rest = command.slice(found.end);
	const withoutAnd = rest.replace(/&&/g, " ").replace(/\d*>&\d*/g, " ").replace(/&>/g, " ");
	if (/[\n;]/.test(rest) || rest.includes("||") || withoutAnd.includes("&")) return "unknown";
	if (rest.replace(/\|\|/g, " ").includes("|") && !/\bpipefail\b/.test(command)) return "unknown";
	return exitCode === 0 ? "pass" : "fail";
}

export function outputTail(output: string, lines = TAIL_LINES): string {
	const tail = output.trimEnd().split("\n").slice(-lines).join("\n");
	return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

export function buildRunRecord(input: { ts: string; branch: string | null; tree?: string; cwd: string; agent: string; command: string; exitCode?: number; output: string }): RunRecord {
	return {
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
		outcome: checkOutcome(input.command, input.exitCode),
		tail: outputTail(input.output),
	};
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
	"Run the tests in their own bash command (its exit code must be the test's: no later `;`, `||`, `&`, or `|` unless `set -o pipefail` is set), then commit again. If the user wants to commit anyway, only they can force it: the guard asks them when a UI is present; otherwise tell them to run /brigadev:force-commit.";

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
export function runRecordFromResult(event: ToolResultLike | undefined, context: { ts: string; branch: string | null; tree: string | undefined; cwd: string; agent: string }): RunRecord | undefined {
	try {
		if (!event || event.toolName !== "bash" || context.tree === undefined) return undefined;
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
		body: `${command.length > 300 ? `${command.slice(0, 300)}…` : command}\n\n${detail}\n\nCommit anyway? Your answer is logged as evidence.`,
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
