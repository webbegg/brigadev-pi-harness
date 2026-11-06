import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createStallWatchdog,
	DEFAULT_STALL_TIMEOUT_MS,
	DEFAULT_TOOL_STALL_TIMEOUT_MS,
	resolveStallTimeouts,
	stallMessage,
	type StallInfo,
} from "../lib/stall-watchdog.ts";

/** Fake scheduler: time only moves when the test advances it. */
function fakeScheduler() {
	let now = 0;
	let nextId = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimer: (fn: () => void, ms: number) => {
			const id = nextId++;
			timers.set(id, { at: now + ms, fn });
			return id;
		},
		clearTimer: (handle: unknown) => void timers.delete(handle as number),
		advance(ms: number) {
			now += ms;
			for (const [id, t] of [...timers]) {
				if (t.at <= now && timers.delete(id)) t.fn();
			}
		},
		pending: () => timers.size,
	};
}

const MIN = 60_000;

function setup(options: { stallTimeoutMs?: number; toolStallTimeoutMs?: number } = {}) {
	const clock = fakeScheduler();
	const stalls: StallInfo[] = [];
	const dog = createStallWatchdog({
		stallTimeoutMs: options.stallTimeoutMs ?? 4 * MIN,
		toolStallTimeoutMs: options.toolStallTimeoutMs ?? 30 * MIN,
		setTimer: clock.setTimer,
		clearTimer: clock.clearTimer,
		onStall: (info) => stalls.push(info),
	});
	return { clock, stalls, dog };
}

describe("stall watchdog", () => {
	it("fires once after the idle budget with the last step", () => {
		const { clock, stalls, dog } = setup();
		dog.activity("assistant message");
		clock.advance(4 * MIN - 1);
		assert.equal(stalls.length, 0);
		clock.advance(1);
		assert.deepEqual(stalls, [{ minutes: 4, lastStep: "assistant message" }]);
		clock.advance(60 * MIN);
		assert.equal(stalls.length, 1);
	});

	it("restarts the budget on every event", () => {
		const { clock, stalls, dog } = setup();
		dog.start();
		for (let i = 0; i < 5; i++) {
			clock.advance(3 * MIN);
			dog.activity(`step ${i}`);
		}
		assert.equal(stalls.length, 0);
		clock.advance(4 * MIN);
		assert.deepEqual(stalls, [{ minutes: 4, lastStep: "step 4" }]);
	});

	it("uses the tool budget while a tool call is in flight", () => {
		const { clock, stalls, dog } = setup();
		dog.activity("assistant message");
		dog.toolStarted("call-1", "tool bash");
		clock.advance(29 * MIN);
		assert.equal(stalls.length, 0);
		clock.advance(1 * MIN);
		assert.deepEqual(stalls, [{ minutes: 30, lastStep: "tool bash" }]);
	});

	it("returns to the idle budget once every tool call has a result", () => {
		const { clock, stalls, dog } = setup();
		dog.toolStarted("a", "tool read");
		dog.toolStarted("b", "tool grep");
		dog.toolFinished("a", "result read");
		clock.advance(10 * MIN);
		assert.equal(stalls.length, 0);
		dog.toolFinished("b", "result grep");
		clock.advance(4 * MIN);
		assert.deepEqual(stalls, [{ minutes: 4, lastStep: "result grep" }]);
	});

	it("ignores a result for an unknown call", () => {
		const { clock, stalls, dog } = setup();
		dog.toolFinished("ghost", "result");
		clock.advance(4 * MIN);
		assert.equal(stalls.length, 1);
	});

	it("stop cancels the timer and later events do not re-arm it", () => {
		const { clock, stalls, dog } = setup();
		dog.activity("x");
		dog.stop();
		assert.equal(clock.pending(), 0);
		dog.activity("y");
		dog.toolStarted("c", "z");
		assert.equal(clock.pending(), 0);
		clock.advance(60 * MIN);
		assert.equal(stalls.length, 0);
	});

	it("keeps one timer armed at a time", () => {
		const { clock, dog } = setup();
		dog.start();
		dog.activity("a");
		dog.toolStarted("c", "b");
		assert.equal(clock.pending(), 1);
	});
});

describe("resolveStallTimeouts", () => {
	it("defaults to 4 and 30 minutes", () => {
		assert.deepEqual(resolveStallTimeouts({}), { stallTimeoutMs: 4 * MIN, toolStallTimeoutMs: 30 * MIN });
		assert.equal(DEFAULT_STALL_TIMEOUT_MS, 4 * MIN);
		assert.equal(DEFAULT_TOOL_STALL_TIMEOUT_MS, 30 * MIN);
	});

	it("reads the env overrides", () => {
		assert.deepEqual(resolveStallTimeouts({ BRIGADEV_STALL_TIMEOUT_MS: "1000", BRIGADEV_TOOL_STALL_TIMEOUT_MS: "2500" }), {
			stallTimeoutMs: 1000,
			toolStallTimeoutMs: 2500,
		});
	});

	it("falls back to defaults for invalid values", () => {
		for (const bad of ["", "abc", "0", "-5", "NaN", "Infinity"]) {
			assert.deepEqual(resolveStallTimeouts({ BRIGADEV_STALL_TIMEOUT_MS: bad, BRIGADEV_TOOL_STALL_TIMEOUT_MS: bad }), {
				stallTimeoutMs: 4 * MIN,
				toolStallTimeoutMs: 30 * MIN,
			});
		}
	});
});

describe("stallMessage", () => {
	it("formats minutes and the last step", () => {
		assert.equal(stallMessage({ minutes: 4, lastStep: "tool bash" }), "stalled for 4 min after: tool bash");
	});
});
