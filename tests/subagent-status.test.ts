import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { FINISHED_TTL_MS, type AgentRun } from "../lib/agents-card.ts";
import { activeTasks, formatStatus, statusCounts } from "../lib/subagent-status.ts";

const row = (over: Partial<AgentRun> = {}): AgentRun => ({ id: "r", agent: "scout", task: "t", state: "running", tokens: 0, cost: 0, startedAt: 0, ...over });
const queued = { exitCode: -1 };
const running = { exitCode: -1 };
const finished = { exitCode: 0, endedAt: 5 };
const settledPlaceholder = { exitCode: -1, endedAt: 5 };

describe("formatStatus: the footer line", () => {
	it("is hidden when nothing runs and nothing finished recently", () => {
		assert.equal(formatStatus({ running: 0, done: 0 }), undefined);
	});

	it("running only", () => {
		assert.equal(formatStatus({ running: 2, done: 0 }), "agents: 2 running · alt+a");
	});

	it("done only", () => {
		assert.equal(formatStatus({ running: 0, done: 3 }), "agents: 3 done · alt+a");
	});

	it("both, with the viewer shortcut last", () => {
		assert.equal(formatStatus({ running: 2, done: 3 }), "agents: 2 running · 3 done · alt+a");
		assert.equal(formatStatus({ running: 1, done: 1 }), "agents: 1 running · 1 done · alt+a");
	});

	it("takes the shortcut from the caller", () => {
		assert.equal(formatStatus({ running: 1, done: 0 }, "ctrl+x"), "agents: 1 running · ctrl+x");
	});
});

describe("activeTasks: running is derived from launch state, never from a counter", () => {
	it("counts queued and running tasks across launches, not finished or settled ones", () => {
		assert.equal(activeTasks([[queued, running, finished], [running, settledPlaceholder]]), 3);
	});

	it("a launch that is no longer tracked contributes nothing (no exit path leaks a count)", () => {
		const live = [running, queued];
		assert.equal(activeTasks([live]), 2);
		assert.equal(activeTasks([]), 0);
	});
});

describe("statusCounts: sync and async launches together", () => {
	const now = 1_000_000;

	it("running comes from the launches (queued included), done from the card's finished rows", () => {
		const runs = [row({ state: "running" }), row({ state: "done", endedAt: now - 1000 }), row({ state: "failed", endedAt: now - 2000 })];
		assert.deepEqual(statusCounts([[queued, running]], runs, now), { running: 2, done: 2 });
	});

	it("done follows the agents card lifetime (FINISHED_TTL_MS): a row at exactly the TTL has left the card and the footer", () => {
		const runs = [row({ state: "done", endedAt: now - FINISHED_TTL_MS + 1 }), row({ state: "done", endedAt: now - FINISHED_TTL_MS })];
		assert.deepEqual(statusCounts([], runs, now), { running: 0, done: 1 });
	});

	it("a card row that never finished does not count as done", () => {
		assert.deepEqual(statusCounts([], [row({ state: "running" })], now), { running: 0, done: 0 });
	});
});
