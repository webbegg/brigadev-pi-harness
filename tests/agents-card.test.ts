import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentsCard, formatElapsed, visibleRuns, type AgentRun } from "../lib/agents-card.ts";

describe("agents card", () => {
	const now = 100_000;
	const run = (overrides: Partial<AgentRun>): AgentRun => ({ id: "r", agent: "brigadev-explore", task: "map the auth flow", state: "running", tokens: 22_000, cost: 0.0014, startedAt: now - 25_000, ...overrides });

	it("formats elapsed time", () => {
		assert.equal(formatElapsed(25_000), "25s");
		assert.equal(formatElapsed(84_000), "1m24s");
	});

	it("lists running first and expires finished runs", () => {
		const runs = [run({ id: "a", state: "done", endedAt: now - 1000, startedAt: now - 9000 }), run({ id: "b" }), run({ id: "c", state: "done", endedAt: now - 120_000 })];
		assert.deepEqual(visibleRuns(runs, now).map((r) => r.id), ["b", "a"]);
	});

	it("aligns columns and fits the width", () => {
		const lines = agentsCard([run({ model: "claude-bridge/claude-haiku-5-5", thinking: "low" }), run({ id: "w", agent: "brigadev-worker", task: "write signals", model: "claude-bridge/claude-sonnet-5-5", thinking: "high", tokens: 120_000, cost: 0.31 })], { width: 100, now, collapsed: false });
		assert.equal(lines[0].text, "Agents · 2 running · 0 done");
		assert.ok(lines.slice(1).every((l) => l.text.length === 100), lines.map((l) => l.text.length).join(","));
		assert.match(lines[1].text, /claude-haiku-5-5 · low/);
		assert.ok(lines[1].text.endsWith("25s"));
	});

	it("keeps elapsed visible once rows get their 2-column indent", () => {
		const terminal = 130;
		const lines = agentsCard([run({ model: "claude-bridge/claude-haiku-5-5", thinking: "low" })], { width: terminal - 2, now, collapsed: false });
		assert.ok(`  ${lines[1].text}`.length <= terminal);
		assert.ok(lines[1].text.endsWith("25s"));
	});

	it("drops columns on narrow terminals but keeps elapsed", () => {
		const lines = agentsCard([run({ model: "claude-bridge/claude-haiku-5-5", thinking: "low" })], { width: 50, now, collapsed: false });
		assert.doesNotMatch(lines[1].text, /haiku/);
		assert.ok(lines[1].text.trimEnd().endsWith("25s"));
	});

	it("drops cost, then tokens, and keeps the model last (S3a)", () => {
		const r = run({ model: "claude-bridge/claude-haiku-5-5", thinking: "low" });
		const at = (width: number) => agentsCard([r], { width, now, collapsed: false })[1].text;
		assert.match(at(100), /\$0\.0014/);
		assert.match(at(100), /22k|22\.0k/);
		const mid = at(68);
		assert.doesNotMatch(mid, /\$0\.0014/, mid);
		assert.match(mid, /22k|22\.0k/, mid);
		assert.match(mid, /claude-haiku-5-5 · low/, mid);
		const narrow = at(60);
		assert.doesNotMatch(narrow, /\$0\.0014/, narrow);
		assert.doesNotMatch(narrow, /22k|22\.0k/, narrow);
		assert.match(narrow, /claude-haiku-5-5 · low/, narrow);
		assert.ok(narrow.trimEnd().endsWith("25s"));
		const tiny = at(40);
		assert.doesNotMatch(tiny, /haiku/, tiny);
		assert.ok(tiny.trimEnd().endsWith("25s"));
	});

	it("collapses to the header", () => {
		assert.equal(agentsCard([run({})], { width: 80, now, collapsed: true }).length, 1);
	});
});
