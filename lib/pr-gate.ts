// The PR risk gate (S9): before `gh pr create`, a T2 branch needs a brigadev-verify run, and verify
// blockers need a repro test that went RED then GREEN after the verify. Pure functions of plain
// inputs (the guard reads the facts); a T1 branch without a review ledger only earns a note.
// This is advice on top of the human PR decision, so every failure to read the facts fails open.

import { basename, blankHeredocs, classifyCommand, segmentDirectories, tokenize, unwrap } from "./command-classifier.ts";
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
}

/** The categories that make a branch T2, in the order the risk line names them. */
const T2_CATEGORIES: readonly RiskCategory[] = ["security", "data", "contract"];

export const NO_LEDGER_NOTE = "no review ledger for this branch";

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
	if (tier === "T0") return { action: "allow", reasons: [] };
	const reasons: string[] = [];
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
	} else if (decided?.outcome === "blockers") {
		const runs = input.records.filter((r): r is RunRecord => r.type === "run" && r.branch === branch);
		if (!redThenGreen(runs, decided.ts)) reasons.push(`verify blockers ${decided.blockers.join(",")} have no repro test RED→GREEN after the verify`);
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
	if (!classifyCommand(command).some((match) => match.reason === "gh pr create")) return undefined;
	const segments = tokenize(blankHeredocs(command), { redirections: true });
	const dirs = segmentDirectories(segments, cwd);
	let found: string | undefined;
	for (let i = 0; i < segments.length; i++) {
		const { argv } = unwrap(segments[i].argv);
		if (basename(argv[0] ?? "") !== "gh" || argv[1] !== "pr" || argv[2] !== "create") continue;
		if (dirs[i] === undefined || (found !== undefined && dirs[i] !== found)) return undefined;
		found = dirs[i];
	}
	return found;
}

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
	if (/repro test/.test(joined)) steps.push("add the repro test for each verify blocker and run it through check (RED, then GREEN)");
	return `Blocked by brigadev guard: gh pr create was declined (${joined}). To clear it: ${steps.join("; ")}; then retry. Do not open the PR another way.`;
}
