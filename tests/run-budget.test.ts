import assert from "node:assert/strict";
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { parseAgent } from "../lib/agents.ts";
import { classifyFailure } from "../lib/fallback.ts";
import { DEFAULT_WRAP_UP_GRACE_MS, overBudgetMessage, resolveRunBudget, wrapUpMessage } from "../lib/run-budget.ts";
import { parseFrontmatter } from "./helpers/pi-stubs/pi-coding-agent.ts";

// Pi's real `parseFrontmatter` (@earendil-works/pi-coding-agent) is a peer dependency that is not installed in this repo, so this
// uses the test stub of it that the other agent-loading tests use: it keeps `budgetMinutes: 10` as the string "10" where Pi's YAML
// parser gives the number 10; `budgetMinutesOf` accepts both (see "parseAgent budgetMinutes").
describe("the shipped brigadev-verify agent", () => {
	const file = new URL("../assets/agents/brigadev-verify.md", import.meta.url);
	const content = fs.readFileSync(file, "utf8");
	const load = (text: string) => parseAgent(text, file.pathname, "package", (source) => parseFrontmatter<Record<string, unknown>>(source));

	it("has a 10 min budget through the frontmatter parser the extension loads agents with", () => {
		assert.equal(load(content)?.budgetMinutes, 10);
	});

	it("the check can fail: without its budgetMinutes line the agent has no budget", () => {
		assert.match(content, /^budgetMinutes: 10$/m);
		assert.equal(load(content.replace(/^budgetMinutes: 10\n/m, ""))?.budgetMinutes, undefined);
		assert.equal(load(content.replace(/^budgetMinutes: 10$/m, "budgetMinutes 10"))?.budgetMinutes, undefined);
	});
});

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
	it("names the steer's rejection when the follow-up then went unanswered, and keeps the over-budget prefix", () => {
		const message = overBudgetMessage(10, 180_000, { state: "sent", steerError: "Agent is compacting" });
		assert.equal(message, "over budget: no result 3 min after the 10 min budget; the child rejected the wrap-up steer (Agent is compacting) and never acknowledged the follow-up");
		assert.equal(classifyFailure("error", message), undefined);
		assert.match(overBudgetMessage(10, 180_000, { state: "sent" }), /; the child never acknowledged the wrap-up request$/);
	});

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
