import assert from "node:assert/strict";
import { test } from "node:test";
import { BUS, CHANNELS, createBus, onAction, parseAction, publish } from "../lib/bus.ts";
import workflowState from "../extensions/workflow-state.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const on = (pi: ReturnType<typeof createFakePi>, channel: string) => pi.emitted.filter((e) => e.channel === channel).map((e) => e.data as any);

test("bus: channel specs follow the dashboard's naming rules", () => {
	for (const [channel, spec] of Object.entries(CHANNELS)) {
		assert.match(channel, /^brigadev:[a-z]+$/);
		assert.match(spec.as, /^[a-z0-9_]+$/);
		if (spec.delivery !== "live") assert.ok(spec.key, `${channel} needs a key`);
	}
});

test("bus: parseAction accepts well-formed actions only", () => {
	assert.deepEqual(parseAction({ action: "answer", id: "p1", value: true }), { action: "answer", id: "p1", value: true });
	assert.deepEqual(parseAction({ action: "answer", id: "p1", value: "Option A" }), { action: "answer", id: "p1", value: "Option A" });
	assert.deepEqual(parseAction({ action: "prompt", text: "go", deliverAs: "steer" }), { action: "prompt", text: "go", deliverAs: "steer" });
	assert.deepEqual(parseAction({ action: "abort", extra: 1 }), { action: "abort" });
	assert.deepEqual(parseAction({ action: "cancel-agent", id: "l1:0" }), { action: "cancel-agent", id: "l1:0" });
	for (const bad of [null, "x", {}, { action: "answer", id: "p1" }, { action: "answer", id: "", value: true }, { action: "answer", id: "p", value: 3 }, { action: "prompt", text: "   " }, { action: "prompt", text: "x", deliverAs: "now" }, { action: "cancel-agent" }, { action: "rm -rf" }]) {
		assert.equal(parseAction(bad), undefined, JSON.stringify(bad));
	}
});

test("bus: publish survives a throwing listener; onAction filters kinds and invalid input", () => {
	const bus = createBus();
	bus.on(BUS.phase, () => {
		throw new Error("boom");
	});
	assert.doesNotThrow(() => publish(bus, BUS.phase, {}));
	const seen: unknown[] = [];
	const off = onAction(bus, "answer", (a) => seen.push(a));
	bus.emit(BUS.action, { action: "abort" });
	bus.emit(BUS.action, { action: "answer", id: "x" });
	bus.emit(BUS.action, { action: "answer", id: "x", value: false });
	off();
	bus.emit(BUS.action, { action: "answer", id: "y", value: true });
	assert.deepEqual(seen, [{ action: "answer", id: "x", value: false }]);
});

test("workflow-state publishes the inferred phase over a run", async () => {
	const pi = createFakePi();
	workflowState(pi as any);
	const ctx = createFakeCtx({ cwd: "/tmp" });
	await pi.fire("agent_start", { type: "agent_start" }, ctx);
	await pi.fire("tool_execution_start", { toolCallId: "1", toolName: "read", args: { path: "a.ts" } }, ctx);
	await pi.fire("tool_execution_start", { toolCallId: "2", toolName: "edit", args: { path: "a.ts" } }, ctx);
	await pi.fire("agent_end", { type: "agent_end", messages: [] }, ctx);
	assert.deepEqual(
		on(pi, BUS.phase).map((s) => s.phase),
		["authorize", "explore", "implement", "idle"],
	);
});

test("workflow-state publishes todo snapshots and check results from tool results", async () => {
	const pi = createFakePi();
	workflowState(pi as any);
	const ctx = createFakeCtx({ cwd: "/tmp" });
	const todos = [{ id: "T1", text: "bus", status: "done" }];
	await pi.fire("tool_execution_end", { toolCallId: "t", toolName: "todo", isError: false, result: { details: { todos } } }, ctx);
	await pi.fire("tool_execution_end", { toolCallId: "c", toolName: "check", isError: false, durationMs: 12, result: { details: { command: "npm test", exitCode: 0, outcome: "pass", counts: { passed: 3, failed: 0 }, durationMs: 10 } } }, ctx);
	await pi.fire("tool_execution_end", { toolCallId: "x", toolName: "check", isError: true, result: { content: [] } }, ctx);
	assert.deepEqual(on(pi, BUS.todo), [{ scope: "todo", todos }]);
	const checks = on(pi, BUS.check);
	assert.equal(checks.length, 1, "a check without details publishes nothing");
	assert.deepEqual({ ...checks[0], at: 0 }, { id: "c", command: "npm test", outcome: "pass", exitCode: 0, counts: { passed: 3, failed: 0 }, durationMs: 10, at: 0 });
});

test("workflow-state stays silent in a subagent", async () => {
	const previous = process.env.BRIGADEV_CHILD;
	process.env.BRIGADEV_CHILD = "1";
	try {
		const pi = createFakePi();
		workflowState(pi as any);
		assert.equal(pi.handlers.size, 0);
	} finally {
		if (previous === undefined) delete process.env.BRIGADEV_CHILD;
		else process.env.BRIGADEV_CHILD = previous;
	}
});
