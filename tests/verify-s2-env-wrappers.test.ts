import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { decideWithBranchRule } from "../lib/commit-branch.ts";
import { PERMISSION_MODE } from "../lib/permission-policy.ts";

const onFeature = (command: string) => decideWithBranchRule(classifyCommand(command), PERMISSION_MODE.NORMAL, false, async () => ({ currentBranch: "feat/x", defaultBranch: "main" }));

describe("git-location variables around wrapped shells", () => {
	it("still ask through runner wrappers and nested shells", async () => {
		for (const command of [
			"GIT_DIR=../other/.git nice bash -c 'git commit -m x'",
			"GIT_DIR=../other/.git exec bash -c 'git commit -m x'",
			"command env GIT_DIR=../other/.git sh -c 'git commit -m x'",
			"env -i GIT_DIR=../other/.git bash -c 'git commit -m x'",
			"GIT_DIR=../other/.git bash -c 'bash -c \"git commit -m x\"'",
			"(GIT_DIR=../other/.git bash -c 'git commit -m x')",
			"GIT_DIR=\"../other/.git\" zsh -c 'git commit -m x'",
		]) {
			assert.equal((await onFeature(command)).action, "confirm", command);
		}
	});

	it("do not ask when the variable name only appears in the message", async () => {
		for (const command of ['git commit -m "GIT_DIR=x"', 'git add . && git commit -m "docs: explain GIT_DIR=path usage"']) {
			assert.equal((await onFeature(command)).action, "allow", command);
		}
	});
});
