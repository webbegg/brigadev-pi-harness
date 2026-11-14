import assert from "node:assert/strict";
import { it } from "node:test";
import { createResultDelivery } from "../lib/result-delivery.ts";
import { createSubagentRegistry } from "../lib/subagent-registry.ts";

// Verifier T9 (S2): the delivery buffer wired to the registry the way extensions/subagents.ts wires it
// (isPinned = isHeld, isConsumed/markConsumed through the registry, settle events feed `settled`).

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function rig(maxSettled = 64) {
	let idle = false;
	const delivered: string[] = [];
	let n = 0;
	let delivery: ReturnType<typeof createResultDelivery<string>>;
	const registry = createSubagentRegistry<string>({ setTimer: () => 0, clearTimer: () => {}, newId: () => `L${++n}`, maxSettled, isPinned: (id) => delivery.isHeld(id) });
	delivery = createResultDelivery<string>({
		isIdle: () => idle,
		isConsumed: (id) => registry.get(id)?.consumed ?? true,
		markConsumed: (id) => void registry.markConsumed(id),
		deliver: ({ id, result }) => void delivered.push(`${id}:${result}`),
	});
	registry.subscribe((event) => {
		if (event.type === "settle") delivery.settled(event);
	});
	const launch = () => {
		let finish!: (v: string) => void;
		const id = registry.start({ total: 1, run: () => new Promise<string>((resolve) => (finish = resolve)) });
		return { id, finish: (v: string) => finish(v) };
	};
	return { registry, delivery, delivered, launch, setIdle: (v: boolean) => (idle = v) };
}

it("S2: settled while idle is delivered at once and consumed", async () => {
	const h = rig();
	h.setIdle(true);
	const a = h.launch();
	a.finish("A");
	await tick();
	assert.deepEqual(h.delivered, ["L1:A"]);
	assert.equal(h.registry.get(a.id)?.consumed, true);
});

it("S2: held while busy, flushed once in settle order, never twice", async () => {
	const h = rig();
	const [a, b, c] = [h.launch(), h.launch(), h.launch()];
	c.finish("C");
	await tick();
	a.finish("A");
	await tick();
	b.finish("B");
	await tick();
	assert.deepEqual(h.delivered, []);
	h.setIdle(true);
	h.delivery.flush();
	h.delivery.flush();
	assert.deepEqual(h.delivered, ["L3:C", "L1:A", "L2:B"]);
});

it("S2: a wait blocked on the launch while the parent is busy gets the result, and the next idle flush skips it", async () => {
	const h = rig();
	const a = h.launch();
	const waiting = h.registry.wait(a.id, 60_000);
	a.finish("A");
	const outcome = await waiting;
	assert.equal(outcome.status, "settled");
	h.setIdle(true);
	h.delivery.flush();
	assert.deepEqual(h.delivered, []);
});

it("S2: wait and flush in the same tick deliver once", async () => {
	const h = rig();
	const a = h.launch();
	a.finish("A");
	await tick();
	const waiting = h.registry.wait(a.id, 1000);
	h.setIdle(true);
	h.delivery.flush();
	assert.equal((await waiting).status, "settled");
	assert.deepEqual(h.delivered, []);
});

it("S2: held results survive the prune cap until delivered", async () => {
	const h = rig(2);
	const launches = Array.from({ length: 6 }, () => h.launch());
	for (const l of launches) {
		l.finish(l.id);
		await tick();
	}
	assert.equal(h.registry.list().length, 6);
	h.setIdle(true);
	h.delivery.flush();
	assert.equal(h.delivered.length, 6);
});

it("S2: stop drops held results and ignores later settles; reset accepts again", async () => {
	const h = rig();
	const a = h.launch();
	a.finish("A");
	await tick();
	h.delivery.stop();
	const b = h.launch();
	b.finish("B");
	await tick();
	h.setIdle(true);
	h.delivery.flush();
	assert.deepEqual(h.delivered, []);
	h.delivery.reset();
	const c = h.launch();
	c.finish("C");
	await tick();
	assert.deepEqual(h.delivered, ["L3:C"]);
});
