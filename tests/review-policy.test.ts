import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// Review policy: no 4R review inside the dev loop (high-risk units get brigadev-verify only); before the PR a T1 or T2 branch
// gets an automatic review with the tier's lenses (no scope question), then at most the revise rounds the `check` line names.
//
// The checks look at the policy's structure (which tools are named, what comes before what, what is negated), never at exact
// prose, so rewording keeps passing. Each check is a function of the asset's text that returns the problems it found, which lets
// the tests prove it fails on a mutated copy of the text. The assets themselves are only read.
const root = join(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

const NEGATION = /\b(never|not|no|without|nor)\b/i;
/** A commit (each, every, per, or a high-risk one) named as the moment to act. */
const COMMIT_TRIGGER = /\b(per|each|every)\b[^.;\n]*\bcommit|\bhigh[- ]risk\b[^.;\n]*\bcommit|\bcommit\w*\b[^.;\n]*\bhigh[- ]risk\b/i;

/** Sentences (split at `.`, `;` and line ends) that make commits, or high-risk commits, a trigger and are not negated. */
function commitTriggerProblems(text: string): string[] {
	return text
		.split(/[.;\n]/)
		.map((sentence) => sentence.trim())
		.filter((sentence) => COMMIT_TRIGGER.test(sentence) && !NEGATION.test(sentence))
		.map((sentence) => `a commit is a review trigger: "${sentence}"`);
}

/** The text of a `## heading` section, up to the next `## ` heading. */
function section(text: string, heading: string): string | undefined {
	const match = new RegExp(`^## ${heading}\\s*$([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "mi").exec(text);
	return match?.[1];
}

/** A scope question before the review (asking, or ask_user_choice, about the scope). */
const SCOPE_QUESTION = /\bask(?:s|ing)?\b[^.;\n]*\bscope\b|ask_user_choice/i;

/**
 * The orchestrator's review line(s): brigadev-review named, no per-commit or high-risk-commit trigger, brigadev-verify for high
 * risk, automatic before the PR, and no scope question.
 */
function orchestratorReviewProblems(text: string): string[] {
	const lines = text.split("\n").filter((line) => line.includes("`brigadev-review`"));
	if (lines.length === 0) return ["the orchestrator does not mention brigadev-review"];
	const problems: string[] = [];
	for (const line of lines) {
		problems.push(...commitTriggerProblems(line));
		if (!line.includes("`brigadev-verify`") || !/high[- ]risk/i.test(line)) problems.push("the review line does not name brigadev-verify for high risk");
		if (!/\bautomatic\w*\b[^.;]*\bbefore the PR\b/i.test(line)) problems.push("the review line does not make the review automatic before the PR");
		if (SCOPE_QUESTION.test(line)) problems.push("the review line asks the scope");
	}
	return problems;
}

/** The "When to use" section of the review skill has no high-risk-commit (or per-commit) trigger. */
function reviewSkillProblems(text: string): string[] {
	const when = section(text, "When to use");
	return when === undefined ? ['the review skill has no "When to use" section'] : commitTriggerProblems(when);
}

/**
 * Step 5 of branch-pr: no scope question before the brigadev-review invocation; T0 gets no review; T1 is automatic and T2 adds
 * brigadev-verify; the revise rounds come from the `check` line; the user can skip.
 */
function branchPrProblems(text: string): string[] {
	const step = /^5\. [\s\S]*?(?=^\d+\. |^## |$(?![\s\S]))/m.exec(text)?.[0];
	if (step === undefined) return ["branch-pr has no step 5"];
	const review = step.indexOf("`brigadev-review`");
	if (review < 0) return ["step 5 does not invoke brigadev-review"];
	const problems: string[] = [];
	const ask = SCOPE_QUESTION.exec(step.slice(0, review));
	if (ask) problems.push(`step 5 asks the scope before reviewing: "${ask[0]}"`);
	if (!/\bT0\b[^.]*\bno review\b/.test(step)) problems.push("step 5 does not say T0 gets no review");
	if (!/\bT1\b[^.]*\bautomatic/i.test(step)) problems.push("step 5 does not make the T1 review automatic");
	if (!/\bT2\b[^.]*`brigadev-verify`/.test(step)) problems.push("step 5 does not add brigadev-verify for T2");
	if (!/revise rounds[^.]*`check` (?:risk )?line|`check` (?:risk )?line[^.]*revise rounds/.test(step)) problems.push("step 5 does not take the revise rounds from the `check` line");
	if (!/\bskip\w*\b[^.]*\buser\b|\buser\b[^.]*\bskip/i.test(step)) problems.push("step 5 does not let the user skip the review");
	return problems;
}

describe("review policy", () => {
	it("the orchestrator names brigadev-review without a per-commit or high-risk trigger, automatic before the PR, and brigadev-verify for high risk", () => {
		assert.deepEqual(orchestratorReviewProblems(read("assets", "orchestrator.md")), []);
	});

	it("the review skill has no high-risk-commit trigger in When to use", () => {
		assert.deepEqual(reviewSkillProblems(read("skills", "brigadev-review", "SKILL.md")), []);
	});

	it("branch-pr reviews T1/T2 automatically (no scope question), T0 not at all, with the revise rounds of the check line and a user skip", () => {
		assert.deepEqual(branchPrProblems(read("skills", "brigadev-branch-pr", "SKILL.md")), []);
	});
});

// Balanced review strategy: verify once per branch before the PR, repro-test fixes, a bounded correction batch, calibrated severity.
describe("balanced review policy", () => {
	const orchestrator = read("assets", "orchestrator.md");
	const delegation = read("assets", "delegation.md");
	const reviewSkill = read("skills", "brigadev-review", "SKILL.md");
	const branchPr = read("skills", "brigadev-branch-pr", "SKILL.md");
	const reviewer = read("assets", "agents", "review-4r.md");
	const verifier = read("assets", "agents", "brigadev-verify.md");
	const step = (text: string, n: number) => new RegExp(`^${n}\\. [\\s\\S]*?(?=^\\d+\\. |^## |$(?![\\s\\S]))`, "m").exec(text)?.[0] ?? "";

	it("orchestrator: one verify per branch before the PR, repro test RED→GREEN, no relaunch and no instead", () => {
		const check = step(orchestrator, 5);
		assert.match(check, /`brigadev-verify`[^.]*per branch, before the PR/);
		assert.match(check, /RED→GREEN/);
		assert.doesNotMatch(orchestrator, /relaunch once/);
		const review = orchestrator.split("\n").find((line) => line.includes("`brigadev-review`")) ?? "";
		assert.doesNotMatch(review, /\binstead\b/);
		assert.match(review, /`brigadev-verify` plus its fitting lenses in one parallel call/);
		for (const category of ["data", "security", "contract", "concurrency", "delivery", "untested"]) assert.match(orchestrator, new RegExp(`\\b${category}\\b`));
	});

	it("delegation: verify once per branch before the PR; one enforced recheck for security/data; bounded correction batch", () => {
		const verification = section(delegation, "Verification") ?? "";
		assert.match(verification, /once per branch, before the PR/);
		assert.match(verification, /recheck <ids>/);
		assert.match(verification, /security\/data/);
		assert.match(verification, /at most one/i);
		assert.match(verification, /repro test/);
		assert.match(verification, /blockers plus at most 5 defect WARNINGs in the same files/);
		assert.match(verification, /Follow-ups/);
		assert.match(verification, /advisories never start a correction/i);
		assert.match(verification, /one batch per revise round[^.]*`check`/);
		assert.doesNotMatch(verification, /limited to those blockers/);
		assert.doesNotMatch(verification, /second correction/i);
	});

	it("branch-pr step 5 reads the tier from the last check risk line: T0 no review (disclosed), T1 the tier's lenses, T2 with verify in one parallel call, then bounded revise rounds", () => {
		const five = step(branchPr, 5);
		assert.match(five, /last `check` risk line/);
		assert.match(five, /T0[^.]*Risk line/);
		assert.match(five, /T1/);
		assert.match(five, /T2[^.]*`brigadev-verify`[^.]*one parallel call/);
		assert.match(five, /the tier's lenses/);
		assert.match(five, /blockers plus at most 5 defect WARNINGs in the same files/);
		assert.match(five, /RED→GREEN/);
		assert.match(five, /re-review[^.]*only the lenses whose findings were fixed/);
		assert.match(five, /\*\*Needs your decision\*\*/);
	});

	it("review skill: R2 only for prompt/docs or on request; bounded revise rounds with a RED→GREEN repro; compact ledger", () => {
		assert.match(/^\| R2 Readability \|.*$/m.exec(reviewSkill)?.[0] ?? "", /prompt\/docs diffs or on request/);
		const correct = /^4\. \*\*Correct\*\*[\s\S]*?(?=^\d+\. )/m.exec(reviewSkill)?.[0] ?? "";
		assert.match(correct, /blockers plus at most 5 defect WARNINGs in the same files/);
		assert.match(correct, /RED→GREEN/);
		assert.match(correct, /security-parser/);
		assert.match(correct, /revise rounds?[^.]*`check`/);
		assert.match(correct, /only the lenses whose findings were fixed/);
		assert.match(correct, /never start a round/);
		assert.match(reviewSkill, /^Rounds: <n> of <N>/m);
		assert.match(section(reviewSkill, "When to use") ?? "", /automatic[^.]*before (?:the|a) PR[^.]*T1/i);
		assert.doesNotMatch(correct, /one re-review limited to those blocker IDs/);
		assert.match(reviewSkill, /top 5 advisories/);
		assert.match(reviewSkill, /SUGGESTION count/);
	});

	it("review-4r: severity calibration and the R1 checklist of recurring classes", () => {
		assert.match(reviewer, /CRITICAL = a shipped defect/);
		assert.match(reviewer, /test gaps and wording cap at WARNING/);
		assert.match(reviewer, /data loss is at least CRITICAL/);
		for (const needle of ["fsmonitor", "filters", "--config-env", "GIT_CONFIG_*", "symlinks", "fail-open", "ReDoS"]) assert.ok(reviewer.includes(needle), needle);
	});

	it("brigadev-verify has a recheck mode that probes only the listed blocker ids", () => {
		const recheck = section(verifier, "Recheck mode") ?? "";
		assert.match(recheck, /recheck <ids>/);
		assert.match(recheck, /only those blocker ids/);
		assert.match(recheck, /no new scope/i);
	});
});

// Each check must fail on a policy that regressed: the same text, mutated in memory.
describe("review policy checks catch a regression (mutated copies of the asset text)", () => {
	const mutate = (text: string, from: RegExp | string, to: string): string => {
		const out = text.replace(from, to);
		assert.notEqual(out, text, `the mutation did not apply: ${String(from)}`);
		return out;
	};

	describe("orchestrator", () => {
		const text = read("assets", "orchestrator.md");

		it("review per work-unit commit that carries a high-risk item", () => {
			const mutated = mutate(text, /high risk \(T2\) gets `brigadev-verify` plus its fitting lenses in one parallel call/, "after each work-unit commit that carries a high-risk item");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /commit/i);
		});

		it("review on every commit, with verify still named", () => {
			const mutated = mutate(text, /on request; automatic before the PR/, "on every commit; automatic before the PR");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /commit/i);
		});

		it("the review is no longer automatic before the PR", () => {
			const mutated = mutate(text, /on request; automatic before the PR for T1\/T2/, "only when the user asks");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /automatic/);
		});

		it("the scope question comes back", () => {
			const mutated = mutate(text, /\(user may skip\)/, "(after asking its scope)");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /asks the scope/);
		});

		it("brigadev-verify no longer named for high risk", () => {
			const mutated = mutate(text, /high risk \(T2\) gets `brigadev-verify` plus its fitting lenses in one parallel call/, "high risk gets extra care");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /brigadev-verify/);
		});

		it("brigadev-review no longer mentioned", () => {
			const mutated = text.replaceAll("`brigadev-review`", "`something-else`");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /brigadev-review/);
		});
	});

	describe("review skill", () => {
		const text = read("skills", "brigadev-review", "SKILL.md");

		it("a high-risk-commit trigger is added to When to use", () => {
			const mutated = mutate(text, "## When to use\n\n", "## When to use\n\nAfter every work-unit commit that carries a high-risk item, review it. ");
			assert.notDeepEqual(reviewSkillProblems(mutated), []);
		});

		it("a per-commit trigger replaces the prohibition", () => {
			const mutated = mutate(text, /Never review per commit/, "Review per commit");
			assert.notDeepEqual(reviewSkillProblems(mutated), []);
		});

		it("the same sentence outside When to use is not that section's business", () => {
			const mutated = text + "\n## Notes\n\nReview each commit that carries a high-risk item.\n";
			assert.deepEqual(reviewSkillProblems(mutated), []);
		});

		it("no When to use section", () => {
			assert.match(reviewSkillProblems(mutate(text, "## When to use", "## When")).join("\n"), /When to use/);
		});
	});

	describe("branch-pr step 5", () => {
		const text = read("skills", "brigadev-branch-pr", "SKILL.md");

		it("a scope question with ask_user_choice comes back before the review", () => {
			const mutated = mutate(text, "T1: run `brigadev-review`", "T1: ask the scope with one `ask_user_choice` (full, fitting, skip), then run `brigadev-review`");
			assert.match(branchPrProblems(mutated).join("\n"), /asks the scope/);
		});

		it("a question asked after the review is not a scope question", () => {
			const mutated = text.replace("Show the ledger.", "Show the ledger and ask_user_choice on the leftovers.");
			assert.notEqual(mutated, text);
			assert.deepEqual(branchPrProblems(mutated), []);
		});

		it("T0 gets a review", () => {
			const mutated = mutate(text, /T0: no review/, "T0: a short review");
			assert.match(branchPrProblems(mutated).join("\n"), /T0/);
		});

		it("the T1 review is no longer automatic", () => {
			const mutated = mutate(text, /, automatically, without asking the scope/, " when the user wants one");
			assert.match(branchPrProblems(mutated).join("\n"), /automatic/);
		});

		it("the T2 verify is dropped", () => {
			const mutated = mutate(text, /T2: the same, plus `brigadev-verify`/, "T2: the same");
			assert.match(branchPrProblems(mutated).join("\n"), /T2/);
		});

		it("the revise rounds no longer come from the check line", () => {
			const mutated = mutate(text, /at most the number the `check` line names/, "as many as it takes");
			assert.match(branchPrProblems(mutated).join("\n"), /revise rounds/);
		});

		it("the user skip removed", () => {
			const mutated = mutate(text, /Skip it only when the user said so, and say so in the Risk line\. /, "");
			assert.match(branchPrProblems(mutated).join("\n"), /skip/);
		});

		it("LOOP R3-007: the options carry no stale timing claim (one reviewer pass now)", () => {
			assert.doesNotMatch(text, /slowest/);
		});

		it("GATE R3-002: the evidence section names srcTree and root and the injected pipefail prefix", () => {
			assert.match(text, /`srcTree`/);
			assert.match(text, /`root`/);
			assert.match(text, /without the `set -o pipefail; `/);
		});

		it("step 5 missing", () => {
			assert.match(branchPrProblems(mutate(text, /^5\. /m, "- ")).join("\n"), /step 5/i);
		});

		it("rewording that keeps the structure still passes", () => {
			const mutated = mutate(mutate(text, "Stop when clean or out of rounds.", "Stop once nothing is left or no rounds remain."), "Show the ledger.", "Share the ledger.");
			assert.deepEqual(branchPrProblems(mutated), []);
		});
	});
});

describe("team review focus (LOOP R3-007)", () => {
	const text = read("assets", "workflows", "team-review.md");

	it("names the chosen lens first and adds the lens of any high-risk category, without the legacy item wording", () => {
		assert.doesNotMatch(text, /that lens only/);
		assert.doesNotMatch(text, /high-risk item/);
		assert.match(text, /name the chosen lens first, then add the lens that covers any high-risk category/);
	});
});
