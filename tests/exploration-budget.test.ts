import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExplorationBudget, isLookupTool } from "../lib/exploration-budget.ts";

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
});
