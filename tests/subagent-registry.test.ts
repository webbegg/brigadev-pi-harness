import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSubagentRegistry, type RegistryEvent } from "../lib/subagent-registry.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Manual timers and clock, so no test waits for real time. */
function fakeTime() {
	let now = 1000;
	let nextHandle = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		now: () => now,
		setTimer: (fn: () => void, ms: number) => {
			const handle = nextHandle++;
			timers.set(handle, { at: now + ms, fn });
			return handle;
		},
		clearTimer: (handle: unknown) => void timers.delete(handle as number),
		advance(ms: number) {
			now += ms;
			for (const [handle, t] of [...timers]) {
				if (t.at <= now) {
					timers.delete(handle);
					t.fn();
				}
			}
		},
		pending: () => timers.size,
	};
}

/** A launch body the test settles by hand; honours the abort signal like a real run. */
function manualRun() {
	let resolve!: (value: string) => void;
	let reject!: (error: Error) => void;
	let signal!: AbortSignal;
	let progress!: (done: number, total: number) => void;
	const promise = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
	return {
		run: (s: AbortSignal, ctl: { progress: (done: number, total: number) => void }) => ((signal = s), (progress = ctl.progress), promise),
		resolve: (v: string) => resolve(v),
		reject: (e: Error) => reject(e),
		get signal() {
			return signal;
		},
		progress: (done: number, total: number) => progress(done, total),
	};
}

function setup(over: { maxSettled?: number } = {}) {
	const time = fakeTime();
	let n = 0;
	const registry = createSubagentRegistry<string>({ now: time.now, setTimer: time.setTimer, clearTimer: time.clearTimer, newId: () => `L${++n}`, ...over });
	const events: RegistryEvent[] = [];
	registry.subscribe((e) => events.push(e));
	return { registry, time, events };
}

describe("subagent registry: start", () => {
	it("returns an id at once and tracks the launch as running", () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 3, run: m.run });
		assert.equal(id, "L1");
		assert.deepEqual(registry.get(id), { id: "L1", status: "running", total: 3, done: 0, startedAt: 1000, settledAt: undefined, consumed: false, error: undefined });
		assert.equal(m.signal.aborted, false);
	});

	it("a run that throws synchronously settles as an error instead of throwing from start", async () => {
		const { registry } = setup();
		const id = registry.start({
			total: 1,
			run: () => {
				throw new Error("boom");
			},
		});
		await tick();
		assert.equal(registry.get(id)?.status, "settled");
		assert.equal(registry.get(id)?.error, "boom");
	});
});

describe("subagent registry: wait", () => {
	it("settled: returns the result and marks the launch consumed", async () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		const waiting = registry.wait(id, 60_000);
		m.resolve("the report");
		const outcome = await waiting;
		assert.equal(outcome.status, "settled");
		assert.equal(outcome.status === "settled" && outcome.result, "the report");
		assert.equal(registry.get(id)?.consumed, true);
	});

	it("already settled: returns at once", async () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		m.resolve("done");
		await tick();
		const outcome = await registry.wait(id, 1000);
		assert.equal(outcome.status, "settled");
	});

	it("a failed run reports its error and is consumed too", async () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		m.reject(new Error("spawn failed"));
		const outcome = await registry.wait(id, 1000);
		assert.equal(outcome.status === "settled" && outcome.error, "spawn failed");
		assert.equal(registry.get(id)?.consumed, true);
	});

	it("timeout: reports still running with progress and does not consume", async () => {
		const { registry, time } = setup();
		const m = manualRun();
		const id = registry.start({ total: 4, run: m.run });
		m.progress(1, 4);
		const waiting = registry.wait(id, 5000);
		time.advance(5000);
		const outcome = await waiting;
		assert.equal(outcome.status, "running");
		assert.equal(outcome.status === "running" && outcome.launch.done, 1);
		assert.equal(outcome.status === "running" && outcome.launch.total, 4);
		assert.equal(registry.get(id)?.consumed, false);
		assert.equal(time.pending(), 0);
	});

	it("settling before the timeout clears the timer", async () => {
		const { registry, time } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		const waiting = registry.wait(id, 5000);
		m.resolve("ok");
		await waiting;
		assert.equal(time.pending(), 0);
	});

	it("an aborted wait call returns still running without consuming", async () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		const controller = new AbortController();
		const waiting = registry.wait(id, 60_000, controller.signal);
		controller.abort();
		assert.equal((await waiting).status, "running");
		assert.equal(registry.get(id)?.consumed, false);
	});

	it("unknown id", async () => {
		const { registry } = setup();
		assert.deepEqual(await registry.wait("nope", 10), { status: "unknown" });
		assert.deepEqual(await registry.cancel("nope"), { status: "unknown" });
	});
});

describe("subagent registry: cancel", () => {
	it("aborts the run, waits for its partial result, and marks it consumed", async () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 2, run: m.run });
		const cancelling = registry.cancel(id);
		assert.equal(m.signal.aborted, true);
		m.resolve("partial");
		const outcome = await cancelling;
		assert.equal(outcome.status === "settled" && outcome.result, "partial");
		assert.equal(registry.get(id)?.consumed, true);
	});

	it("cancelling a settled launch returns its result and consumes it", async () => {
		const { registry } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		m.resolve("final");
		await tick();
		const outcome = await registry.cancel(id);
		assert.equal(outcome.status === "settled" && outcome.result, "final");
		assert.equal(registry.get(id)?.consumed, true);
	});
});

describe("subagent registry: events", () => {
	it("emits start, progress, settle in order", async () => {
		const { registry, events } = setup();
		const m = manualRun();
		const id = registry.start({ total: 2, run: m.run });
		m.progress(1, 2);
		m.resolve("x");
		await tick();
		assert.deepEqual(
			events.map((e) => [e.type, e.launch.id, e.launch.done]),
			[
				["start", id, 0],
				["progress", id, 1],
				["settle", id, 1],
			],
		);
	});

	it("settle carries the result and the consumed flag at the time of settling", async () => {
		const { registry, events } = setup();
		const m = manualRun();
		const id = registry.start({ total: 1, run: m.run });
		const waiting = registry.wait(id, 1000);
		m.resolve("r");
		await waiting;
		const settle = events.find((e) => e.type === "settle");
		assert.equal(settle?.type === "settle" && settle.result, "r");
		// wait consumed it after the settle event; a later reader sees it consumed
		assert.equal(registry.get(id)?.consumed, true);
	});

	it("a failing listener never breaks the registry; unsubscribe stops events", async () => {
		const { registry, events } = setup();
		registry.subscribe(() => {
			throw new Error("listener bug");
		});
		const seen: string[] = [];
		const off = registry.subscribe((e) => seen.push(e.type));
		const a = manualRun();
		registry.start({ total: 1, run: a.run });
		off();
		a.resolve("x");
		await tick();
		assert.deepEqual(seen, ["start"]);
		assert.equal(events.at(-1)?.type, "settle");
	});

	it("progress is ignored once settled and for unknown ids", async () => {
		const { registry, events } = setup();
		const m = manualRun();
		const id = registry.start({ total: 2, run: m.run });
		m.resolve("x");
		await tick();
		const before = events.length;
		m.progress(2, 2);
		registry.progress("nope", 1, 1);
		assert.equal(events.length, before);
		assert.equal(registry.get(id)?.done, 0);
	});
});

describe("subagent registry: lifecycle", () => {
	it("abortAll aborts every running launch and leaves settled ones alone", async () => {
		const { registry } = setup();
		const a = manualRun();
		const b = manualRun();
		const c = manualRun();
		registry.start({ total: 1, run: a.run });
		registry.start({ total: 1, run: b.run });
		const idC = registry.start({ total: 1, run: c.run });
		c.resolve("done");
		await tick();
		registry.abortAll();
		assert.equal(a.signal.aborted, true);
		assert.equal(b.signal.aborted, true);
		assert.equal(c.signal.aborted, false);
		assert.equal(registry.get(idC)?.status, "settled");
	});

	it("clear aborts running launches and forgets every launch", async () => {
		const { registry } = setup();
		const a = manualRun();
		const id = registry.start({ total: 1, run: a.run });
		registry.clear();
		assert.equal(a.signal.aborted, true);
		assert.equal(registry.get(id), undefined);
		assert.deepEqual(registry.list(), []);
		a.resolve("late");
		await tick();
		assert.deepEqual(registry.list(), []);
	});

	it("keeps at most 64 settled launches, pruning the oldest settled and never a running one", async () => {
		const { registry, time } = setup();
		const running = manualRun();
		const runningId = registry.start({ total: 1, run: running.run });
		const ids: string[] = [];
		for (let i = 0; i < 66; i++) {
			const m = manualRun();
			ids.push(registry.start({ total: 1, run: m.run }));
			m.resolve("x");
			await tick();
			time.advance(1);
		}
		const all = registry.list();
		assert.equal(all.filter((l) => l.status === "settled").length, 64);
		assert.equal(registry.get(runningId)?.status, "running");
		assert.equal(registry.get(ids[0]), undefined);
		assert.equal(registry.get(ids[1]), undefined);
		assert.ok(registry.get(ids[2]));
		assert.ok(registry.get(ids[65]));
	});

	it("counts running and settled launches", async () => {
		const { registry } = setup();
		const a = manualRun();
		const b = manualRun();
		registry.start({ total: 1, run: a.run });
		registry.start({ total: 1, run: b.run });
		a.resolve("x");
		await tick();
		assert.deepEqual(registry.counts(), { running: 1, settled: 1 });
	});
});
