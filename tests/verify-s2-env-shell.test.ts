import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { decideWithBranchRule } from "../lib/commit-branch.ts";
import { PERMISSION_MODE } from "../lib/permission-policy.ts";

describe("commits redirected by an env prefix on a shell wrapper", () => {
	it("still ask on a feature branch", async () => {
		for (const command of [
			"GIT_DIR=../other/.git bash -c 'git commit -m x'",
			"env GIT_DIR=../other/.git bash -c 'git commit -m x'",
			"GIT_WORK_TREE=../other sh -c 'git commit -m x'",
			"GIT_DIR=../other/.git eval 'git commit -m x'",
		]) {
			const decision = await decideWithBranchRule(classifyCommand(command), PERMISSION_MODE.NORMAL, false, async () => ({ currentBranch: "feat/x", defaultBranch: "main" }));
			assert.equal(decision.action, "confirm", command);
		}
	});
});
