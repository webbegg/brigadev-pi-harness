import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExplorationBudget, isLookupTool, isShellLookup, SHELL_READ_NOTICE } from "../lib/exploration-budget.ts";

describe("exploration budget", () => {
	it("counts only read, grep, find, and ls as lookups", () => {
		for (const name of ["read", "grep", "find", "ls"]) assert.equal(isLookupTool(name), true);
		for (const name of ["bash", "edit", "write", "subagent"]) assert.equal(isLookupTool(name), false);
	});

	it("suggests brigadev-explore exactly once, on the fifth lookup", () => {
		const budget = createExplorationBudget();
		for (let i = 0; i < 4; i++) assert.equal(budget.record("read"), undefined);
		assert.match(budget.record("grep") ?? "", /brigadev-explore/);
		assert.equal(budget.record("ls"), undefined);
	});

	it("ignores non-lookup tools", () => {
		const budget = createExplorationBudget();
		for (let i = 0; i < 10; i++) assert.equal(budget.record("bash"), undefined);
		assert.equal(budget.record("read"), undefined);
	});

	it("resets on a new request", () => {
		const budget = createExplorationBudget();
		for (let i = 0; i < 5; i++) budget.record("find");
		budget.reset();
		for (let i = 0; i < 4; i++) assert.equal(budget.record("read"), undefined);
		assert.ok(budget.record("read"));
	});

	it("counts read-only shell commands, which agents often use instead of the read tool", () => {
		for (const c of ["cat lib/cost.ts", "cd /repo && sed -n 1,80p lib/agents.ts", "head -40 README.md; tail -5 CHANGELOG.md", "grep -rn foo src | head", "rg -n bar lib", "ls -la extensions", "wc -l lib/*.ts"]) {
			assert.equal(isShellLookup(c), true, c);
		}
	});

	it("does not count shell commands that write, run, or rewrite", () => {
		for (const c of ["npm test", "git status", "cat <<'EOF' > notes.md\nx\nEOF", "sed -i '' 's/a/b/' x.ts", "python3 - <<'E'\nopen('x','w')\nE", "cat a.txt > b.txt", "echo hi"]) {
			assert.equal(isShellLookup(c), false, c);
		}
	});

	it("records bash calls by their command", () => {
		const budget = createExplorationBudget();
		for (let i = 0; i < 4; i++) assert.equal(budget.record("bash", { command: "cat x.ts" }), undefined);
		assert.equal(budget.record("bash", { command: "npm test" }), undefined);
		assert.match(budget.record("bash", { command: "sed -n 1,9p y.ts" }) ?? "", /brigadev-explore/);
	});
});

describe("shell read nudge", () => {
	const cat = { command: "cat lib/cost.ts" };

	it("fires on the first read-only shell lookup of a request, once", () => {
		const budget = createExplorationBudget();
		assert.equal(budget.nudgeShellRead("bash", { command: "npm test" }), undefined);
		assert.equal(budget.nudgeShellRead("read", cat), undefined);
		assert.equal(budget.nudgeShellRead("bash", cat), SHELL_READ_NOTICE);
		assert.equal(budget.nudgeShellRead("bash", { command: "grep -rn x lib" }), undefined);
		assert.equal(budget.nudgeShellRead("bash", cat), undefined);
	});

	it("names the file tools and the reason", () => {
		assert.match(SHELL_READ_NOTICE, /^\[brigadev runtime\] Use read, grep, find, or ls for files instead of bash/);
		assert.match(SHELL_READ_NOTICE, /invisible to the guard and reviewers/);
	});

	it("does not fire for writes, runs, or malformed input", () => {
		const budget = createExplorationBudget();
		for (const command of ["git status", "sed -i '' s/a/b/ x.ts", "cat a > b"]) assert.equal(budget.nudgeShellRead("bash", { command }), undefined, command);
		assert.equal(budget.nudgeShellRead("bash", {}), undefined);
		assert.equal(budget.nudgeShellRead("bash"), undefined);
		assert.equal(budget.nudgeShellRead("bash", cat), SHELL_READ_NOTICE);
	});

	it("fires again after a new request resets it", () => {
		const budget = createExplorationBudget();
		assert.equal(budget.nudgeShellRead("bash", cat), SHELL_READ_NOTICE);
		budget.reset();
		assert.equal(budget.nudgeShellRead("bash", cat), SHELL_READ_NOTICE);
		assert.equal(budget.nudgeShellRead("bash", cat), undefined);
	});

	it("is independent of the lookup budget", () => {
		const budget = createExplorationBudget();
		for (let i = 0; i < 4; i++) assert.equal(budget.record("read"), undefined);
		assert.equal(budget.nudgeShellRead("bash", cat), SHELL_READ_NOTICE);
		assert.match(budget.record("bash", cat) ?? "", /brigadev-explore/);
	});
});
