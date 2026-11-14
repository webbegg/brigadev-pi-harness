import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createSemaphore } from "../lib/semaphore.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("semaphore", () => {
	it("grants up to the limit at once and queues the rest", async () => {
		const sem = createSemaphore(2);
		await sem.acquire();
		await sem.acquire();
		assert.deepEqual({ active: sem.active, waiting: sem.waiting }, { active: 2, waiting: 0 });
		let third = false;
		void sem.acquire().then(() => (third = true));
		await tick();
		assert.equal(third, false);
		assert.equal(sem.waiting, 1);
	});

	it("hands a released slot to the oldest waiter (FIFO)", async () => {
		const sem = createSemaphore(1);
		const first = await sem.acquire();
		const order: string[] = [];
		const b = sem.acquire().then((release) => (order.push("b"), release));
		const c = sem.acquire().then((release) => (order.push("c"), release));
		first();
		const releaseB = await b;
		await tick();
		assert.deepEqual(order, ["b"]);
		releaseB();
		await c;
		assert.deepEqual(order, ["b", "c"]);
		assert.equal(sem.active, 1);
	});

	it("release is idempotent: a double release never frees a second slot", async () => {
		const sem = createSemaphore(1);
		const release = await sem.acquire();
		release();
		release();
		assert.equal(sem.active, 0);
		await sem.acquire();
		let second = false;
		void sem.acquire().then(() => (second = true));
		await tick();
		assert.equal(second, false);
	});

	it("rejects a queued acquire when its signal aborts, and the slot goes to the next waiter", async () => {
		const sem = createSemaphore(1);
		const held = await sem.acquire();
		const controller = new AbortController();
		const cancelled = sem.acquire(controller.signal);
		const next = sem.acquire();
		controller.abort();
		await assert.rejects(cancelled, (e: Error) => e.name === "AbortError");
		assert.equal(sem.waiting, 1);
		held();
		await next;
		assert.equal(sem.active, 1);
	});

	it("rejects at once when the signal is already aborted, without taking a slot", async () => {
		const sem = createSemaphore(1);
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(sem.acquire(controller.signal), (e: Error) => e.name === "AbortError");
		assert.equal(sem.active, 0);
	});

	it("an abort after the slot was granted changes nothing", async () => {
		const sem = createSemaphore(1);
		const controller = new AbortController();
		const release = await sem.acquire(controller.signal);
		controller.abort();
		assert.equal(sem.active, 1);
		release();
		assert.equal(sem.active, 0);
	});
});
