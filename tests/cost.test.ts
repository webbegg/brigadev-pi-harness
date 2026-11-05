import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addUsage, cacheHitRate, emptyTally, formatCost, priceBridgeMessage, type CostCalculator, type UsageLike } from "../lib/cost.ts";

const usage = (overrides: Partial<UsageLike> = {}): UsageLike => ({
	input: 1000,
	output: 100,
	cacheRead: 0,
	cacheWrite: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	...overrides,
});

// $4 / $20 per 1M tokens, like the catalog's claude-opus-5-5 list price.
const calculate: CostCalculator = (provider, modelId, u) => {
	if (provider !== "anthropic" || modelId !== "claude-opus-5-5") return undefined;
	const input = (u.input * 4) / 1e6;
	const output = (u.output * 20) / 1e6;
	return { input, output, cacheRead: 0, cacheWrite: 0, total: input + output };
};

describe("priceBridgeMessage", () => {
	it("prices zero-cost claude-bridge turns at the list price", () => {
		const priced = priceBridgeMessage({ role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", usage: usage() }, calculate);
		assert.equal(priced?.usage?.cost.total, 0.006);
	});

	it("leaves other providers, priced turns, and unknown models alone", () => {
		assert.equal(priceBridgeMessage({ role: "assistant", provider: "anthropic", model: "claude-opus-5-5", usage: usage() }, calculate), undefined);
		assert.equal(priceBridgeMessage({ role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", usage: usage({ cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 } }) }, calculate), undefined);
		assert.equal(priceBridgeMessage({ role: "assistant", provider: "claude-bridge", model: "mystery", usage: usage() }, calculate), undefined);
		assert.equal(priceBridgeMessage({ role: "user", provider: "claude-bridge", model: "claude-opus-5-5", usage: usage() }, calculate), undefined);
	});

	it("does not mutate the original message", () => {
		const original = { role: "assistant", provider: "claude-bridge", model: "claude-opus-5-5", usage: usage() };
		priceBridgeMessage(original, calculate);
		assert.equal(original.usage.cost.total, 0);
	});
});

describe("tally", () => {
	it("accumulates usage and computes cache hit rate", () => {
		const t = emptyTally();
		addUsage(t, usage({ input: 100, cacheRead: 900, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.01 } }));
		addUsage(t, usage({ input: 0, cacheRead: 0, cacheWrite: 1000 }));
		assert.equal(t.turns, 2);
		assert.equal(t.cost, 0.01);
		assert.equal(cacheHitRate(t), 900 / 2000);
		assert.equal(cacheHitRate(emptyTally()), undefined);
	});

	it("formats cost by magnitude", () => {
		assert.equal(formatCost(1.234), "$1.23");
		assert.equal(formatCost(0.0567), "$0.057");
		assert.equal(formatCost(0.00123), "$0.0012");
	});

	it("formats zero cost without decimals", () => {
		assert.equal(formatCost(0), "$0");
	});
});
