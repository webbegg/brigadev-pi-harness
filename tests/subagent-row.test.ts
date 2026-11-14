import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COLLAPSED_CALLS, modelSegment, rowHeader, subagentRow, type RowInput } from "../lib/subagent-row.ts";

describe("subagent row", () => {
	const now = 100_000;
	const calls = (n: number) => Array.from({ length: n }, (_, i) => ({ name: "read", arguments: { path: `lib/f${i}.ts` } }));
	const input = (overrides: Partial<RowInput> = {}): RowInput => ({
		agent: "brigadev-worker",
		state: "running",
		model: "claude-bridge/claude-sonnet-5-5",
		thinking: "high",
		route: "profile:fast/worker",
		startedAt: now - 25_000,
		cost: 0.0312,
		calls: calls(2),
		...overrides,
	});

	it("shows every segment while running", () => {
		assert.equal(rowHeader(input(), now), "◐ brigadev-worker · claude-sonnet-5-5 · high · 25s · 2 calls · $0.031");
	});

	it("shows every segment when finished, with the final elapsed", () => {
		const done = input({ state: "done", endedAt: now - 5_000, calls: calls(1) });
		assert.equal(rowHeader(done, now), "✓ brigadev-worker · claude-sonnet-5-5 · high · 20s · 1 call · $0.031");
		assert.ok(rowHeader(input({ state: "failed" }), now).startsWith("✗ "));
	});

	it("drops the thinking segment when unset and the provider prefix always", () => {
		const header = rowHeader(input({ thinking: undefined }), now);
		assert.doesNotMatch(header, /claude-bridge/);
		assert.equal(header, "◐ brigadev-worker · claude-sonnet-5-5 · 25s · 2 calls · $0.031");
	});

	it("keeps the model visible before the run has a model or any usage", () => {
		const header = rowHeader(input({ model: undefined, thinking: undefined, calls: [], cost: 0 }), now);
		assert.equal(header, "◐ brigadev-worker · default · 25s");
	});

	it("keeps the fallback trail in the model segment", () => {
		const trail = modelSegment(input({ model: "claude-bridge/claude-sonnet-5-5", fallbacks: ["claude-bridge/claude-opus-5-5 (quota)"] }));
		assert.equal(trail, "claude-opus-5-5 ✗ quota ↪ claude-sonnet-5-5");
		assert.match(rowHeader(input({ fallbacks: ["a/opus-5-5 (quota)"], model: "a/sonnet-5-5" }), now), /· opus-5-5 ✗ quota ↪ sonnet-5-5 ·/);
	});

	it("chains several failed attempts and does not repeat the last failed model", () => {
		assert.equal(modelSegment(input({ model: "p/c", fallbacks: ["p/a (quota)", "p/b (rate_limit)"] })), "a ✗ quota ↪ b ✗ rate_limit ↪ c");
		assert.equal(modelSegment(input({ state: "failed", model: "p/b", fallbacks: ["p/a (quota)", "p/b (rate_limit)"] })), "a ✗ quota ↪ b ✗ rate_limit");
	});

	it("marks only parent-inherited models with ↑ in the collapsed row", () => {
		assert.match(rowHeader(input({ route: "parent" }), now), /· claude-sonnet-5-5 ↑ ·/);
		assert.doesNotMatch(rowHeader(input({ route: "profile:fast/worker" }), now), /↑/);
		assert.doesNotMatch(rowHeader(input({ route: "definition" }), now), /↑/);
		// after a fallback the model no longer comes from the parent
		assert.doesNotMatch(rowHeader(input({ route: "parent ↪ fallback", fallbacks: ["p/a (quota)"] }), now), /claude-sonnet-5-5 ↑/);
	});

	it("shows the route source only when expanded", () => {
		const collapsed = subagentRow(input(), { now, expanded: false }).map((l) => l.text).join("\n");
		assert.doesNotMatch(collapsed, /profile:fast/);
		const expanded = subagentRow(input(), { now, expanded: true }).map((l) => l.text).join("\n");
		assert.match(expanded, /profile:fast\/worker/);
		assert.match(subagentRow(input({ route: "definition" }), { now, expanded: true }).map((l) => l.text).join("\n"), /definition/);
		assert.match(subagentRow(input({ route: "parent" }), { now, expanded: true }).map((l) => l.text).join("\n"), /parent/);
	});

	it("keeps the last calls and counts the earlier ones", () => {
		const lines = subagentRow(input({ calls: calls(10) }), { now, expanded: false }).map((l) => l.text);
		assert.equal(lines[1], `  … ${10 - COLLAPSED_CALLS} earlier calls`);
		assert.match(lines[lines.length - 1], /lib\/f9\.ts/);
		assert.match(lines[2], new RegExp(`lib/f${10 - COLLAPSED_CALLS}\\.ts`));
		assert.doesNotMatch(lines.join("\n"), /lib\/f0\.ts/);
		assert.equal(subagentRow(input({ calls: calls(COLLAPSED_CALLS + 1) }), { now, expanded: false })[1].text, "  … 1 earlier call");
	});

	it("collapsed row is the header plus at most the configured number of call lines (S7)", () => {
		for (const n of [0, 1, COLLAPSED_CALLS, COLLAPSED_CALLS + 1, 40]) {
			const lines = subagentRow(input({ calls: calls(n) }), { now, expanded: false });
			const callLines = lines.filter((l) => l.text.startsWith("  → "));
			assert.ok(callLines.length <= COLLAPSED_CALLS, `n=${n}`);
			assert.ok(lines.length <= 1 + COLLAPSED_CALLS + 1, `n=${n} lines=${lines.length}`);
			assert.equal(lines.length, 1 + callLines.length + (n > COLLAPSED_CALLS ? 1 : 0));
		}
		const custom = subagentRow(input({ calls: calls(9) }), { now, expanded: false, maxCalls: 2 });
		assert.equal(custom.length, 1 + 1 + 2);
		assert.equal(subagentRow(input({ calls: [] }), { now, expanded: false }).length, 1);
	});

	it("expanded lists every call without an earlier-calls line", () => {
		const lines = subagentRow(input({ calls: calls(10) }), { now, expanded: true }).map((l) => l.text);
		assert.equal(lines.filter((l) => l.startsWith("  → ")).length, 10);
		assert.doesNotMatch(lines.join("\n"), /earlier/);
	});

	it("previews call arguments", () => {
		const lines = subagentRow(input({ calls: [{ name: "bash", arguments: { command: "npm test\nmore" } }] }), { now, expanded: false }).map((l) => l.text);
		assert.equal(lines[1], "  → bash $ npm test");
	});

	it("adds one error line to a failed collapsed row", () => {
		const lines = subagentRow(input({ state: "failed", error: "Rate limit hit\nsecond line", calls: [] }), { now, expanded: false });
		assert.equal(lines.length, 2);
		assert.equal(lines[1].text, "  Rate limit hit");
		assert.equal(lines[1].tone, "error");
	});

	it("tones the header by state", () => {
		assert.equal(subagentRow(input(), { now, expanded: false })[0].tone, "accent");
		assert.equal(subagentRow(input({ state: "done" }), { now, expanded: false })[0].tone, "success");
		assert.equal(subagentRow(input({ state: "failed" }), { now, expanded: false })[0].tone, "error");
	});
});
