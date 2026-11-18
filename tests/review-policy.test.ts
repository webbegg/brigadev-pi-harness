import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

// Review policy: no 4R review inside the dev loop (high-risk units get brigadev-verify only); the review runs once,
// before the PR, and only after the user picks its scope.
const root = join(import.meta.dirname, "..");
const read = (...parts: string[]) => readFileSync(join(root, ...parts), "utf8");

describe("review policy", () => {
	it("the orchestrator no longer reviews each high-risk commit, and asks before the pre-PR review", () => {
		const text = read("assets", "orchestrator.md");
		assert.doesNotMatch(text, /work-unit commit carries a high-risk item/);
		assert.match(text, /`brigadev-review` when the user asks, or once before the PR after asking/);
	});

	it("the review skill has no high-risk-commit trigger", () => {
		const text = read("skills", "brigadev-review", "SKILL.md");
		assert.doesNotMatch(text, /work-unit commit carries a high-risk item/);
	});

	it("branch-pr asks the review scope (full, fitting, skip) before reviewing", () => {
		const text = read("skills", "brigadev-branch-pr", "SKILL.md");
		for (const needle of ["ask_user_choice", "Full 4R", "Fitting lenses", "Skip the review"]) assert.ok(text.includes(needle), needle);
	});

	it("the Open a PR workflow defers to that question instead of always reviewing", () => {
		const text = read("assets", "workflows", "open-pr.md");
		assert.doesNotMatch(text, /Run the pre-PR review first/);
		assert.match(text, /ask_user_choice/);
	});
});
