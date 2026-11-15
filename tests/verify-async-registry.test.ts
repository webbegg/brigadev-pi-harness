import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSemaphore } from "../lib/semaphore.ts";
import { createSubagentRegistry, MAX_SETTLED_LAUNCHES } from "../lib/subagent-registry.ts";

const tick = () => new Promise((r) => setImmediate(r));
const registry = () => {
	let n = 0;
	return createSubagentRegistry<string>({ setTimer: (f, ms) => setTimeout(f, ms), clearTimer: (h) => clearTimeout(h as NodeJS.Timeout), newId: () => `L${++n}` });
};
const deferred = () => {
	let resolve!: (v: string) => void;
	const promise = new Promise<string>((r) => (resolve = r));
	return { promise, resolve };
};

describe("subagent registry (verifier regressions)", () => {
	it("keeps exactly 64 settled launches and never prunes running ones beyond the cap", async () => {
		const r = registry();
		const held = Array.from({ length: 5 }, () => deferred());
		const running = held.map((d) => r.start({ total: 1, run: () => d.promise }));
		const settled: string[] = [];
		for (let i = 0; i < MAX_SETTLED_LAUNCHES; i++) settled.push(r.start({ total: 1, run: async () => `ok${i}` }));
		await tick();
		assert.deepEqual(r.counts(), { running: 5, settled: 64 });
		assert.ok(r.get(settled[0]));
		r.start({ total: 1, run: async () => "x" });
		await tick();
		assert.equal(r.get(settled[0]), undefined);
		assert.ok(r.get(settled[1]));
		for (const id of running) assert.equal(r.get(id)?.status, "running");
	});

	// Fails at 7ed64a1: start is emitted after run() is invoked.
	it("start is emitted before progress even when the run reports progress synchronously", () => {
		const r = registry();
		const events: string[] = [];
		r.subscribe((e) => events.push(e.type));
		r.start({ total: 1, run: (_s, control) => (control.progress(1, 1), new Promise<string>(() => {})) });
		assert.deepEqual(events, ["start", "progress"]);
	});

	it("runs the launch body synchronously inside start, so writers registered there are visible to the next admission", () => {
		const r = registry();
		const writers: string[] = [];
		r.start({ total: 1, run: async () => (writers.push("w"), await tick(), "done") });
		assert.deepEqual(writers, ["w"]);
	});

	it("a zero-timeout wait on a running launch does not consume it", async () => {
		const r = registry();
		const d = deferred();
		const id = r.start({ total: 1, run: () => d.promise });
		assert.equal((await r.wait(id, 0)).status, "running");
		assert.equal(r.get(id)?.consumed, false);
		d.resolve("R");
		const outcome = await r.wait(id, 1000);
		assert.equal(outcome.status === "settled" && outcome.result, "R");
		assert.equal(r.get(id)?.consumed, true);
	});
});

describe("semaphore (verifier regressions)", () => {
	it("random acquire/abort/double-release never exceeds the limit and ends with no slot or waiter left", async () => {
		let seed = 7;
		const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
		for (let round = 0; round < 30; round++) {
			const limit = 1 + Math.floor(rnd() * 4);
			const s = createSemaphore(limit);
			await Promise.all(
				Array.from({ length: 30 }, async () => {
					const c = new AbortController();
					if (rnd() < 0.1) c.abort();
					const later = rnd() < 0.3 ? setTimeout(() => c.abort(), Math.floor(rnd() * 5)) : undefined;
					let release: () => void;
					try {
						release = await s.acquire(c.signal);
					} catch (error) {
						assert.equal((error as Error).name, "AbortError");
						return;
					}
					assert.ok(s.active >= 1 && s.active <= limit);
					await new Promise((r) => setTimeout(r, Math.floor(rnd() * 3)));
					release();
					release();
					clearTimeout(later);
				}),
			);
			assert.equal(s.active, 0);
			assert.equal(s.waiting, 0);
		}
	});
});
