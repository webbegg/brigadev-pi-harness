// lib/bg-delivery.ts: the exit notice of a background process reaches the session once, when idle, batched,
// and never after the model already saw the exit (same rule as async subagent results, lib/result-delivery.ts).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BgSnapshot } from "../lib/bg-processes.ts";
import { BG_EXIT_MESSAGE_TYPE, bgExitMessage, createBgDelivery } from "../lib/bg-delivery.ts";
import { DELIVERY_ATTEMPTS } from "../lib/result-delivery.ts";

const snap = (id: string, overrides: Partial<BgSnapshot> = {}): BgSnapshot => ({
	id,
	name: `proc ${id}`,
	command: "npm test",
	cwd: "/proj",
	pid: 5,
	state: "done",
	exitCode: 0,
	startedAt: 1000,
	endedAt: 13_000,
	output: "all good\n",
	totalBytes: 9,
	truncatedBytes: 0,
	...overrides,
});

function setup() {
	const state = { idle: true, consumed: new Set<string>(), failSend: false };
	const sent: Array<ReturnType<typeof bgExitMessage>> = [];
	const failures: string[] = [];
	const delivery = createBgDelivery({
		isIdle: () => state.idle,
		isConsumed: (id) => state.consumed.has(id),
		markConsumed: (id) => void state.consumed.add(id),
		send: (message) => {
			if (state.failSend) throw new Error("stale context");
			sent.push(message);
		},
		onDeliveryFailed: (id) => void failures.push(id),
	});
	return { state, sent, failures, delivery };
}

describe("delivery rule", () => {
	it("delivers an exit at once when the parent is idle, then records it as seen", () => {
		const { state, sent, delivery } = setup();
		delivery.settled(snap("bg-1"));
		assert.equal(sent.length, 1);
		assert.ok(state.consumed.has("bg-1"));
		delivery.flush();
		assert.equal(sent.length, 1, "never twice");
	});

	it("holds an exit while the parent is busy and delivers every held one as one message on the idle flush", () => {
		const { state, sent, delivery } = setup();
		state.idle = false;
		delivery.settled(snap("bg-1"));
		delivery.settled(snap("bg-2", { state: "failed", exitCode: 1 }));
		assert.equal(sent.length, 0);
		assert.deepEqual(delivery.held(), ["bg-1", "bg-2"]);
		delivery.flush();
		assert.equal(sent.length, 0, "still busy");
		state.idle = true;
		delivery.flush();
		assert.equal(sent.length, 1);
		assert.deepEqual(sent[0].details.processes.map((p) => p.id), ["bg-1", "bg-2"]);
		assert.deepEqual(delivery.held(), []);
	});

	it("skips an exit the model saw (bg_status / bg_kill) while it was held", () => {
		const { state, sent, delivery } = setup();
		state.idle = false;
		delivery.settled(snap("bg-1"));
		delivery.settled(snap("bg-2"));
		state.consumed.add("bg-1");
		state.idle = true;
		delivery.flush();
		assert.deepEqual(sent[0].details.processes.map((p) => p.id), ["bg-2"]);
	});

	it("does not deliver an exit that is already seen when it settles", () => {
		const { state, sent, delivery } = setup();
		state.consumed.add("bg-1");
		delivery.settled(snap("bg-1"));
		assert.equal(sent.length, 0);
	});

	it("ignores a second settle of the same id while it is held", () => {
		const { state, sent, delivery } = setup();
		state.idle = false;
		delivery.settled(snap("bg-1"));
		delivery.settled(snap("bg-1"));
		state.idle = true;
		delivery.flush();
		assert.equal(sent[0].details.processes.length, 1);
	});

	it("retries a failed send at the next idle flush, and gives up after the attempt bound, telling once", () => {
		const { state, sent, failures, delivery } = setup();
		state.failSend = true;
		delivery.settled(snap("bg-1"));
		assert.deepEqual(delivery.held(), ["bg-1"]);
		for (let i = 1; i < DELIVERY_ATTEMPTS; i++) delivery.flush();
		assert.deepEqual(failures, ["bg-1"]);
		assert.deepEqual(delivery.held(), []);
		state.failSend = false;
		delivery.flush();
		assert.equal(sent.length, 0);
		assert.equal(state.consumed.has("bg-1"), false, "left unseen so bg_status can still report it");
	});

	it("a send that works on retry delivers once", () => {
		const { state, sent, delivery } = setup();
		state.failSend = true;
		delivery.settled(snap("bg-1"));
		state.failSend = false;
		delivery.flush();
		assert.equal(sent.length, 1);
	});

	it("stop ignores later exits (session shutdown); reset accepts them again", () => {
		const { sent, delivery } = setup();
		delivery.stop();
		delivery.settled(snap("bg-1"));
		assert.equal(sent.length, 0);
		delivery.reset();
		delivery.settled(snap("bg-2"));
		assert.equal(sent.length, 1);
	});
});

describe("exit message", () => {
	it("one process: a header that says it is already collected, then the output tail", () => {
		const message = bgExitMessage([snap("bg-1")]);
		assert.equal(message.customType, BG_EXIT_MESSAGE_TYPE);
		assert.equal(message.display, true);
		assert.match(message.content, /^Background process bg-1 "proc bg-1" finished: done \(exit 0\) after 12s\./);
		assert.match(message.content, /Delivered automatically: it is already collected, so do not call bg_status or bg_kill for it\./);
		assert.match(message.content, /output \(last 1 line\):\nall good$/);
		assert.deepEqual(message.details, { processes: [{ id: "bg-1", name: "proc bg-1", state: "done", exitCode: 0, signal: undefined }], failed: false });
	});

	it("a failed or killed exit is marked as failed in the details", () => {
		assert.equal(bgExitMessage([snap("bg-1", { state: "failed", exitCode: 2 })]).details.failed, true);
		assert.equal(bgExitMessage([snap("bg-1", { state: "killed", signal: "SIGTERM", exitCode: undefined })]).details.failed, false);
	});

	it("several: a count header, then one section per process in order", () => {
		const message = bgExitMessage([snap("bg-1"), snap("bg-2", { state: "failed", exitCode: 1, output: "boom\n" })]);
		assert.match(message.content, /^2 background processes finished \(bg-1, bg-2\)\. Delivered automatically: they are already collected, so do not call bg_status or bg_kill for them\./);
		const first = message.content.indexOf("## bg-1");
		const second = message.content.indexOf("## bg-2");
		assert.ok(first > 0 && second > first);
		assert.match(message.content, /## bg-2 "proc bg-2": failed \(exit 1\) after 12s/);
		assert.ok(message.content.includes("boom"));
	});

	it("keeps the message short: only a bounded tail of each process, cleaned of escape codes", () => {
		const big = Array.from({ length: 500 }, (_, i) => `\u001b[31mline ${i}\u001b[0m`).join("\n");
		const message = bgExitMessage([snap("bg-1", { output: big })]);
		assert.ok(!message.content.includes("\u001b"));
		assert.ok(message.content.includes("line 499"));
		assert.ok(!message.content.includes("line 100\n"));
		assert.ok(Buffer.byteLength(message.content) < 20_000);
	});

	it("needs at least one process", () => {
		assert.throws(() => bgExitMessage([]));
	});
});
