import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseAgent } from "../lib/agents.ts";
import { classifyFailure } from "../lib/fallback.ts";
import { DEFAULT_WRAP_UP_GRACE_MS, overBudgetMessage, resolveRunBudget, wrapUpMessage } from "../lib/run-budget.ts";

describe("parseAgent budgetMinutes", () => {
	const agent = (budget: unknown) => parseAgent("---\nbody", "/pkg/agents/v.md", "package", () => ({ frontmatter: { name: "v", description: "d", budgetMinutes: budget }, body: "body" }));

	it("keeps a positive number of minutes, from YAML numbers or numeric strings", () => {
		assert.equal(agent(10)?.budgetMinutes, 10);
		assert.equal(agent(2.5)?.budgetMinutes, 2.5);
		assert.equal(agent("12")?.budgetMinutes, 12);
	});

	it("ignores a missing, zero, negative, or non-numeric budget", () => {
		for (const value of [undefined, 0, -3, "", "ten", Number.NaN, Number.POSITIVE_INFINITY, true]) {
			assert.equal(agent(value)?.budgetMinutes, undefined, String(value));
		}
	});
});

describe("resolveRunBudget", () => {
	it("has no budget without budgetMinutes", () => {
		assert.equal(resolveRunBudget(undefined, {}), undefined);
	});

	it("turns minutes into ms with the default wrap-up grace", () => {
		assert.deepEqual(resolveRunBudget(10, {}), { budgetMs: 600_000, graceMs: DEFAULT_WRAP_UP_GRACE_MS });
	});

	it("takes the wrap-up grace from BRIGADEV_WRAP_UP_GRACE_MS, ignoring invalid values", () => {
		assert.equal(resolveRunBudget(1, { BRIGADEV_WRAP_UP_GRACE_MS: "5000" })?.graceMs, 5000);
		for (const raw of ["", "0", "-1", "soon"]) assert.equal(resolveRunBudget(1, { BRIGADEV_WRAP_UP_GRACE_MS: raw })?.graceMs, DEFAULT_WRAP_UP_GRACE_MS, raw);
	});

	it("never arms a timer Node would clamp to 1 ms (above 2^31-1 ms)", () => {
		assert.equal(resolveRunBudget(40_000, {})?.budgetMs, 2_147_483_647);
		assert.equal(resolveRunBudget(1, { BRIGADEV_WRAP_UP_GRACE_MS: "1e10" })?.graceMs, 2_147_483_647);
	});

	it("BRIGADEV_RUN_BUDGET=off disables every budget", () => {
		assert.equal(resolveRunBudget(10, { BRIGADEV_RUN_BUDGET: "off" }), undefined);
	});
});

describe("budget messages", () => {
	it("the wrap-up request asks for the result now, with unrun checks listed as unverified", () => {
		const text = wrapUpMessage(10);
		assert.match(text, /10 min/);
		assert.match(text, /structured_output/);
		assert.match(text, /unverified/);
	});

	it("an over-budget failure never triggers a model fallback (another model would run as long)", () => {
		assert.match(overBudgetMessage(10, 180_000), /^over budget: /);
		assert.equal(classifyFailure("error", overBudgetMessage(10, 180_000, { state: "rejected", error: "429 rate limit, network timeout" })), undefined, "a rejection reason never makes it fall back");
		for (const [minutes, graceMs] of [[10, 180_000], [401, 180_000], [403, 180_000], [429, 180_000], [500, 180_000], [10, 30_000_000], [10, 24_060_000]] as const) {
			assert.equal(classifyFailure("error", overBudgetMessage(minutes, graceMs)), undefined, `${minutes} min / ${graceMs} ms`);
		}
	});
});
