import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDocPath } from "../lib/worktree-tree.ts";
import { evaluateCommitGate } from "../lib/evidence.ts";
import { runCheck } from "../lib/check.ts";

const exec = async (command: string, args: string[], options: { cwd?: string } = {}) => {
	const r = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
	return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", code: r.status ?? 1, killed: false };
};
// A nested node --test run skips its files when NODE_TEST_CONTEXT is inherited.
const { NODE_TEST_CONTEXT: _inherited, ...plainEnv } = process.env;
const sh = (cwd: string, command: string) => spawnSync("bash", ["-c", command], { cwd, encoding: "utf8", env: plainEnv });

function failingRepo(): string {
	const dir = join(mkdtempSync(join(tmpdir(), "ev-docs-")), "repo");
	mkdirSync(join(dir, "docs"), { recursive: true });
	sh(dir, "git init -q -b feat/x && git config user.email a@b && git config user.name t && git config commit.gpgsign false");
	// The fixture's own package.json (type: module) keeps the .js files ES modules wherever TMPDIR lives.
	writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }));
	writeFileSync(join(dir, "docs/helper.js"), "export const h = 1;\n");
	writeFileSync(join(dir, "t.test.js"), 'import test from "node:test"; import assert from "node:assert"; import { h } from "./docs/helper.js"; test("x", () => assert.equal(h, 1));\n');
	writeFileSync(join(dir, "src.js"), "export const v = 1;\n");
	sh(dir, "git add -A && git commit -qm init");
	return dir;
}

test("code files never count as docs, whatever their folder or name", () => {
	for (const path of ["docs/helper.js", "docs/conf.py", "lib/CHANGELOG.ts", "src/LICENSE_check.py", "src/AUTHORSHIP.js", "NOTICEboard.go"]) assert.equal(isDocPath(path), false, path);
	for (const path of ["README.md", "docs/guide.md", "CHANGELOG.md", "LICENSE", "LICENSE.txt", "NOTICE", "COPYING", "AUTHORS"]) assert.equal(isDocPath(path), true, path);
});

test("a broken docs/*.js that the tests import does not pass the gate after a passing run", async () => {
	process.env.BRIGADEV_HOME = mkdtempSync(join(tmpdir(), "ev-home-"));
	const dir = failingRepo();
	writeFileSync(join(dir, "src.js"), "export const v = 2;\n");
	const passed = await runCheck({ command: "node --test t.test.js" }, { cwd: dir, exec, agent: "parent" });
	assert.equal(passed.details?.outcome, "pass");
	writeFileSync(join(dir, "docs/helper.js"), "export const h = 2;\n");
	assert.notEqual(sh(dir, "node --test t.test.js >/dev/null 2>&1").status, 0, "the tests now fail");
	const gate = await evaluateCommitGate({ exec, command: "git commit -am x", cwd: dir, forcedTree: undefined });
	assert.equal(gate?.decision.action, "block");
});

test("check with a command that runs no tests does not vouch for a commit", async () => {
	process.env.BRIGADEV_HOME = mkdtempSync(join(tmpdir(), "ev-home-"));
	const dir = failingRepo();
	writeFileSync(join(dir, "src.js"), "export const v = 2;\n");
	writeFileSync(join(dir, "docs/helper.js"), "export const h = 2;\n"); // the real tests fail now
	for (const command of ["true", "exit 0", "echo ok"]) {
		const result = await runCheck({ command }, { cwd: dir, exec, agent: "parent" });
		assert.notEqual(result.details?.outcome, "pass", command);
		const gate = await evaluateCommitGate({ exec, command: "git commit -am x", cwd: dir, forcedTree: undefined });
		assert.equal(gate?.decision.action, "block", command);
	}
});

test("a command that is the configured test command is recorded, and one that is not says it was not recorded", async () => {
	process.env.BRIGADEV_HOME = mkdtempSync(join(tmpdir(), "ev-home-"));
	const dir = failingRepo();
	writeFileSync(join(dir, "src.js"), "export const v = 2;\n");
	writeFileSync(join(dir, "docs/helper.js"), "export const h = 2;\n");
	const settings = { check: { test: "node --test t.test.js" } };
	const configured = await runCheck({}, { cwd: dir, exec, agent: "parent", settings });
	assert.equal(configured.details?.recorded, true);
	assert.equal(configured.details?.outcome, "fail");
	const other = await runCheck({ command: "echo ok" }, { cwd: dir, exec, agent: "parent", settings });
	assert.equal(other.details?.recorded, false);
	assert.match(other.text, /not recorded as test evidence/i);
});
