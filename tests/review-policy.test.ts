import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// Review policy: no 4R review inside the dev loop (high-risk units get brigadev-verify only); the review runs once,
// before the PR, and only after the user picks its scope.
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

/** The orchestrator's review line(s): brigadev-review named, no per-commit or high-risk-commit trigger, brigadev-verify for high risk. */
function orchestratorReviewProblems(text: string): string[] {
	const lines = text.split("\n").filter((line) => line.includes("`brigadev-review`"));
	if (lines.length === 0) return ["the orchestrator does not mention brigadev-review"];
	const problems: string[] = [];
	for (const line of lines) {
		problems.push(...commitTriggerProblems(line));
		if (!line.includes("`brigadev-verify`") || !/high[- ]risk/i.test(line)) problems.push("the review line does not name brigadev-verify for high risk");
	}
	return problems;
}

/** The "When to use" section of the review skill has no high-risk-commit (or per-commit) trigger. */
function reviewSkillProblems(text: string): string[] {
	const when = section(text, "When to use");
	return when === undefined ? ['the review skill has no "When to use" section'] : commitTriggerProblems(when);
}

/** Step 5 of branch-pr: ask_user_choice and the three options (full / fitting / skip) all come before the brigadev-review invocation. */
function branchPrProblems(text: string): string[] {
	const step = /^5\. [\s\S]*?(?=^\d+\. |^## |$(?![\s\S]))/m.exec(text)?.[0];
	if (step === undefined) return ["branch-pr has no step 5"];
	const review = step.indexOf("`brigadev-review`");
	if (review < 0) return ["step 5 does not invoke brigadev-review"];
	const problems: string[] = [];
	const ask = step.indexOf("ask_user_choice");
	if (ask < 0) problems.push("step 5 does not use ask_user_choice");
	else if (ask > review) problems.push("step 5 invokes brigadev-review before ask_user_choice");
	for (const option of ["full", "fitting", "skip"]) {
		const at = new RegExp(`\\b${option}\\b`, "i").exec(step)?.index ?? -1;
		if (at < 0) problems.push(`step 5 offers no ${option} option`);
		else if (at > review) problems.push(`step 5 names the ${option} option only after invoking brigadev-review (the question must come before)`);
	}
	return problems;
}

describe("review policy", () => {
	it("the orchestrator names brigadev-review without a per-commit or high-risk trigger, and brigadev-verify for high risk", () => {
		assert.deepEqual(orchestratorReviewProblems(read("assets", "orchestrator.md")), []);
	});

	it("the review skill has no high-risk-commit trigger in When to use", () => {
		assert.deepEqual(reviewSkillProblems(read("skills", "brigadev-review", "SKILL.md")), []);
	});

	it("branch-pr asks the review scope (full, fitting, skip) before reviewing", () => {
		assert.deepEqual(branchPrProblems(read("skills", "brigadev-branch-pr", "SKILL.md")), []);
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
			const mutated = mutate(text, /high risk gets `brigadev-verify` instead/, "after each work-unit commit that carries a high-risk item");
			assert.match(orchestratorReviewProblems(mutated).join("\n"), /commit/i);
		});

		it("review on every commit, with verify still named", () => {
			const mutated = mutate(text, /only when the user asks, or once before the PR/, "on every commit, or once before the PR");
			assert.notDeepEqual(orchestratorReviewProblems(mutated), []);
		});

		it("brigadev-verify no longer named for high risk", () => {
			const mutated = mutate(text, /high risk gets `brigadev-verify` instead/, "high risk gets extra care");
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

		it("ask_user_choice removed", () => {
			assert.match(branchPrProblems(text.replaceAll("ask_user_choice", "ask")).join("\n"), /ask_user_choice/);
		});

		it("an option removed (skip, fitting, full), each on its own", () => {
			for (const [from, option] of [["Skip the review", "skip"], ["Fitting lenses", "fitting"], ["Full 4R", "full"]] as const) {
				const mutated = mutate(text, from, "Another thing");
				assert.match(branchPrProblems(mutated).join("\n"), new RegExp(option, "i"), option);
			}
		});

		it("the review is invoked before the question", () => {
			const mutated = mutate(text, "5. **Review before the PR**, once the work units are done:", "5. Run `brigadev-review` on the branch.");
			assert.match(branchPrProblems(mutated).join("\n"), /before/i);
		});

		it("an option is only named after the invocation", () => {
			const mutated = mutate(mutate(text, "**Full 4R** (all four lenses), ", ""), "with the chosen scope", "with the chosen scope (full)");
			assert.match(branchPrProblems(mutated).join("\n"), /full option only after/);
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
			const mutated = text.replace("(recommended: only the lenses the change's risk needs)", "(the default pick)").replace("Show the ledger.", "Share the ledger.");
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
