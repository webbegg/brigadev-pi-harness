import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addUsage, cacheHitRate, emptyTally, formatCost, priceBridgeMessage, type CostCalculator, type UsageLike } from "../lib/cost.ts";
import { usageReportLines, type UsageSnapshot } from "../lib/usage-windows.ts";

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

describe("usageReportLines", () => {
	const NOW = 1_794_000_000_000;
	const snapshot = (overrides: Partial<UsageSnapshot> = {}): UsageSnapshot => ({
		status: "allowed",
		claim: "seven_day",
		overageStatus: "rejected",
		resetsAt: 1_794_060_000,
		windows: [
			{ name: "5h", utilization: 0.92, resetsAt: 1_794_010_000 },
			{ name: "7d", utilization: 0.55, resetsAt: 1_794_060_000 },
		],
		observedAt: NOW - 3 * 60_000,
		...overrides,
	});

	it("says nothing was reported yet when there are no snapshots", () => {
		assert.match(usageReportLines([], NOW)[0], /^No usage reported yet/);
	});

	it("lists a provider with its binding window, age, and one bar per window", () => {
		const lines = usageReportLines([["claude-bridge", snapshot()]], NOW);
		assert.equal(lines[0], "claude-bridge: allowed · binding: seven_day · extra usage: rejected · seen 3 min ago");
		assert.match(lines[1], /^ {2}5h {9}▰▰▰▰▰▰▰▰▰▱ {2}92%  resets /);
		assert.match(lines[2], /^ {2}week {7}▰▰▰▰▰▰▱▱▱▱ {2}55%  resets /);
		assert.equal(lines.length, 3);
	});

	it("flags a spent provider and tells when it is usable again", () => {
		const lines = usageReportLines([["claude-bridge", snapshot({ status: "rejected" })]], NOW);
		assert.match(lines[0], /^claude-bridge: LIMIT REACHED/);
		assert.match(lines[lines.length - 1], /^ {2}limit reached until /);
	});
});
