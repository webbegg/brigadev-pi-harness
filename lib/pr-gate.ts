// The PR risk gate (S9): before `gh pr create`, a branch that commits source needs a passing test
// recorded for the committed HEAD (the evidence check; commits themselves are never gated), a T2
// branch needs a brigadev-verify run, and verify
// blockers need a repro test that went RED then GREEN after the verify, and a `fix/` branch needs the bug reproduced: a
// failing test run followed by a passing one (factory lanes S7). Pure functions of plain
// inputs (the guard reads the facts); a T1 branch without a review ledger only earns a note.
// The guard asks instead of passing when it cannot read the facts: this is the gate in front of delivery.

import { basename, blankHeredocs, classifyCommand, ghGroupAction, segmentDirectories, tokenize, unwrap } from "./command-classifier.ts";
import type { EvidenceRecord, RunRecord, VerifyRecord } from "./evidence.ts";
import type { RiskCategory, Tier } from "./risk-map.ts";

export type PrGateDecision = { action: "allow" | "ask"; reasons: string[]; note?: string };

export interface PrGateInput {
	tier: Tier;
	categories: Partial<Record<RiskCategory, string[]>>;
	/** The branch's evidence records (other branches' records are ignored). */
	records: readonly EvidenceRecord[];
	branch: string | null;
	/** `reviews/<branch>.md` exists in the repo docs folder. */
	ledgerExists: boolean;
	/** No base branch resolved: committed changes were not classified, so a tier below T2 is not trustworthy. */
	baseUnknown?: boolean;
	/** The branch commits a source path (not only docs) since its base, or that cannot be told (unknown base, git failing): HEAD needs a passing test. */
	sourceChanged?: boolean;
	/** HEAD's tree and its source tree (docs removed), matched against recorded test runs; `error` when git could not compute them. Absent: no test check. */
	head?: { tree: string; sourceTree: string; root?: string } | { error: string };
	/** The project's full test command (configured or detected, no focus): only a run of it vouches for HEAD. Absent: any test run counts. */
	suiteCommand?: string;
}

/** The categories that make a branch T2, in the order the risk line names them. */
const T2_CATEGORIES: readonly RiskCategory[] = ["security", "data", "contract"];

export const NO_LEDGER_NOTE = "no review ledger for this branch";
export const UNKNOWN_BASE_REASON = "risk tier unknown: no base branch found";
export const UNRESOLVED_DIRECTORY_REASON = "PR risk gate could not resolve the directory of gh pr create";
export const NO_HEAD_TEST_REASON = "no passing test recorded for the committed HEAD";
export const HEAD_TREE_ERROR_REASON = "test evidence unknown: HEAD's tree could not be computed";
export const PR_FACTS_ERROR_REASON = "PR gate could not read the branch facts";
export const NO_REPRO_REASON = "fix branch shows no reproduction: no failing test run followed by a passing one on this branch";

/** A bug-fix branch by name: `fix/<slug>`, the prefix brigadev-branch-pr gives a fix. */
const isFixBranch = (branch: string | null): boolean => branch?.startsWith("fix/") === true;

/** Why a fix branch lacks a reproduction (a test run that failed, then one that passed), or undefined when it has one or is not a fix. */
function reproReason(input: PrGateInput): string | undefined {
	if (!isFixBranch(input.branch) || !input.sourceChanged) return undefined;
	const runs = input.records.filter((r): r is RunRecord => r.type === "run" && r.branch === input.branch);
	return redThenGreen(runs, "") ? undefined : NO_REPRO_REASON;
}

/** Why HEAD lacks a passing test, or undefined when one is recorded (or there is nothing to check). */
function headTestReason(input: PrGateInput): string | undefined {
	const { head } = input;
	if (!head || !input.sourceChanged) return undefined;
	if ("error" in head) return `${HEAD_TREE_ERROR_REASON} (${head.error})`;
	const runs = input.records.filter(
		(r): r is RunRecord =>
			r.type === "run" &&
			r.kind === "test" &&
			(r.root === undefined || head.root === undefined || r.root === head.root) &&
			(r.tree === head.tree || r.srcTree === head.sourceTree),
	);
	const suite = input.suiteCommand?.trim();
	// The latest suite run on HEAD decides (a later failure revokes an earlier pass); with no known suite, the latest test run.
	const suiteRuns = suite ? runs.filter((r) => r.command.trim() === suite) : runs;
	const latest = [...suiteRuns].sort(byTime).at(-1);
	if (latest?.outcome === "pass") return undefined;
	if (!latest && runs.some((r) => r.outcome === "pass")) return `${NO_HEAD_TEST_REASON} (only other test commands passed on it; the full suite is \`${suite}\`)`;
	const last = latest ?? runs.at(-1);
	const detail = !last ? "no test ran on it" : last.outcome === "fail" ? `the last run failed: \`${last.command}\`, exit ${last.exitCode}` : `the last run has no trustworthy exit code: \`${last.command}\``;
	return `${NO_HEAD_TEST_REASON} (${detail})`;
}

const byTime = <T extends { ts: string }>(a: T, b: T): number => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0);

/** True when, among `runs`, a failing test run is followed by a passing one (both strictly after `after`). */
function redThenGreen(runs: readonly RunRecord[], after: string): boolean {
	let red = false;
	for (const record of [...runs].filter((r) => r.kind === "test" && r.ts > after).sort(byTime)) {
		if (record.outcome === "fail") red = true;
		else if (record.outcome === "pass" && red) return true;
	}
	return false;
}

export function decidePrGate(input: PrGateInput): PrGateDecision {
	const { tier, branch } = input;
	const early = [headTestReason(input), reproReason(input)].filter((reason): reason is string => reason !== undefined);
	if (tier === "T0" && !input.baseUnknown) return early.length > 0 ? { action: "ask", reasons: early } : { action: "allow", reasons: [] };
	const reasons: string[] = early;
	if (input.baseUnknown && tier !== "T2") reasons.push(UNKNOWN_BASE_REASON);
	const verifies = input.records.filter((r): r is VerifyRecord => r.type === "verify" && r.branch === branch && r.outcome !== "failed");
	// The latest by time; among equal times the one recorded last (the log is append-only).
	const latestOf = (list: readonly VerifyRecord[]) => list.reduce<VerifyRecord | undefined>((best, record) => (!best || record.ts >= best.ts ? record : best), undefined);
	const latest = latestOf(verifies);
	// Blockers are judged from the latest verify with a definite result: an unverified recheck clears nothing.
	const decided = latestOf(verifies.filter((r) => r.outcome === "clean" || r.outcome === "blockers"));

	if (tier === "T2" && !latest) {
		const detail = T2_CATEGORIES.flatMap((category) => {
			const paths = input.categories[category];
			return paths?.length ? [`${category}: ${paths[0]}`] : [];
		}).join(", ");
		reasons.push(`T2 branch${detail ? ` (${detail})` : ""} has no brigadev-verify run`);
	} else if (tier === "T2" && !decided) {
		// A verify counts only with a definite result (clean or blockers); one that ended unverified proved nothing.
		reasons.push("latest brigadev-verify was unverified");
	} else if (decided && tier !== "T0") {
		const runs = input.records.filter((r): r is RunRecord => r.type === "run" && r.branch === branch);
		const unresolved: string[] = [];
		// A recheck probed only the ids its reason named: the other blockers of the branch verify it follows still need a test.
		if (decided.scope === "recheck") {
			const base = latestOf(verifies.filter((r) => r.scope === "branch" && r.outcome === "blockers" && r.ts <= decided.ts));
			const open = base ? base.blockers.filter((id) => !(decided.rechecked ?? []).includes(id)) : [];
			if (base && open.length > 0 && !redThenGreen(runs, base.ts)) unresolved.push(...open);
		}
		if (decided.outcome === "blockers" && !redThenGreen(runs, decided.ts)) unresolved.push(...decided.blockers.filter((id) => !unresolved.includes(id)));
		if (unresolved.length > 0) reasons.push(`verify blockers ${unresolved.join(",")} have no repro test RED→GREEN after the verify`);
	}

	const decision: PrGateDecision = { action: reasons.length > 0 ? "ask" : "allow", reasons };
	if (tier === "T1" && !input.ledgerExists) decision.note = NO_LEDGER_NOTE;
	return decision;
}

export { riskMapFor } from "./risk-map.ts";

/**
 * The directory a `gh pr create` in the command runs in, resolved from `cwd` and a leading `cd <dir> &&` chain.
 * Undefined when the command opens no PR, or when the directory cannot be resolved (the gate then does not run).
 */
export function prCreateDirectory(command: string, cwd: string): string | undefined {
	if (!opensPrCreate(command)) return undefined;
	const segments = tokenize(blankHeredocs(command), { redirections: true });
	const dirs = segmentDirectories(segments, cwd);
	let found: string | undefined;
	for (let i = 0; i < segments.length; i++) {
		const { argv } = unwrap(segments[i].argv);
		const { group, action } = ghGroupAction(argv.slice(1));
		if (basename(argv[0] ?? "") !== "gh" || group !== "pr" || action !== "create") continue;
		if (dirs[i] === undefined || (found !== undefined && dirs[i] !== found)) return undefined;
		found = dirs[i];
	}
	return found;
}

/** True when the classifier reads the command as a `gh pr create`, whether or not its directory resolves. */
export const opensPrCreate = (command: string): boolean => classifyCommand(command).some((match) => match.reason === "gh pr create");

/** What a confirmation dialog adds for the gate: the reasons, then the note. Empty when there is nothing to show. */
export function prGateDialogText(decision: PrGateDecision): string {
	const lines = [...decision.reasons.map((reason) => `- ${reason}`), ...(decision.note ? [`Note: ${decision.note}`] : [])];
	return lines.length > 0 ? `PR risk gate:\n${lines.join("\n")}` : "";
}

/** The block message when the user declines (or no one can be asked): the reasons, and what clears them. */
export function prGateBlockMessage(decision: PrGateDecision, categories: readonly RiskCategory[]): string {
	const joined = decision.reasons.join("; ");
	const steps: string[] = [];
	if (/no brigadev-verify run/.test(joined)) steps.push(`run one brigadev-verify for this branch with \`Risk: ${categories.length > 0 ? categories.join(",") : "<category>"}\` in the launch reason`);
	if (joined.includes(UNKNOWN_BASE_REASON)) steps.push("make the default branch resolvable (fetch origin, or create `main`/`master`, or set `git config init.defaultBranch <name>`) so the branch's committed changes can be classified");
	if (joined.includes(NO_HEAD_TEST_REASON)) steps.push("commit your changes, then run the tests with `check` on the clean working tree, the full suite with no `focus` or `command` (a run with uncommitted source edits does not vouch for HEAD)");
	if (joined.includes(HEAD_TREE_ERROR_REASON) || joined.includes(PR_FACTS_ERROR_REASON)) steps.push("fix the git problem (a corrupt index, a stuck lock, an unreadable evidence log)");
	if (joined.includes(UNRESOLVED_DIRECTORY_REASON)) steps.push("run `gh pr create` as its own plain command from the repository directory (or after a leading `cd <dir> &&`), not inside a subshell, `bash -c`, `eval`, or a variable path");
	if (joined.includes(NO_REPRO_REASON)) steps.push("reproduce the bug with a failing test run through `check` (RED), fix it, and run it again (GREEN); if the branch is not a bug fix, rename the branch (`chore/`, `refactor/`, `feat/`)");
	if (/repro test/.test(joined)) steps.push("add the repro test for each verify blocker and run it through check (RED, then GREEN)");
	return `Blocked by brigadev guard: gh pr create was declined (${joined}). To clear it: ${steps.join("; ")}; then retry. Do not open the PR another way.`;
}
