import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alreadyDeliveredText, createResultDelivery, DELIVERY_ATTEMPTS, deliveredNote, RESULT_MESSAGE_TYPE, resultCard, resultMessage } from "../lib/result-delivery.ts";
import { createSubagentRegistry, type LaunchSummary } from "../lib/subagent-registry.ts";

const summary = (id: string, over: Partial<LaunchSummary> = {}): LaunchSummary => ({ id, status: "settled", total: 1, done: 1, startedAt: 0, settledAt: 1, consumed: false, error: undefined, ...over });

/** A delivery buffer over a fake parent: `idle` is flipped by the test, `consumed` stands for wait/cancel. */
function rig() {
	const state = { idle: true };
	const consumed = new Set<string>();
	const delivered: string[] = [];
	const marked: string[] = [];
	const delivery = createResultDelivery<string>({
		isIdle: () => state.idle,
		isConsumed: (id) => consumed.has(id),
		markConsumed: (id) => {
			marked.push(id);
			consumed.add(id);
		},
		deliver: ({ id, result }) => void delivered.push(`${id}:${result}`),
	});
	return { state, consumed, delivered, marked, delivery, settle: (id: string, result = `R-${id}`) => delivery.settled({ launch: summary(id), result }) };
}

describe("result delivery: idle and busy", () => {
	it("delivers at once when the parent is idle, and marks the launch consumed", () => {
		const h = rig();
		h.settle("L1");
		assert.deepEqual(h.delivered, ["L1:R-L1"]);
		assert.deepEqual(h.marked, ["L1"]);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("holds while the parent is mid-turn and flushes when it becomes idle", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.delivery.flush();
		assert.deepEqual(h.delivered, [], "still busy: nothing delivered");
		assert.deepEqual(h.delivery.held(), ["L1"]);
		assert.equal(h.consumed.has("L1"), false, "a held result is not consumed yet");
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.delivered, ["L1:R-L1"]);
		assert.deepEqual(h.marked, ["L1"]);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("skips a result that wait or cancel collected while it was held", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.settle("L2");
		h.consumed.add("L1"); // subagent_wait collected it
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.delivered, ["L2:R-L2"]);
		assert.deepEqual(h.marked, ["L2"]);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("ignores a settle for a launch that was already consumed (sync launches never get here; this covers a wait that raced the settle)", () => {
		const h = rig();
		h.delivery.settled({ launch: summary("L1", { consumed: true }), result: "R" });
		assert.deepEqual(h.delivered, []);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("flushes held results in settle order, one delivery per launch", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L3");
		h.settle("L1");
		h.settle("L2");
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.delivered, ["L3:R-L3", "L1:R-L1", "L2:R-L2"]);
	});

	it("a new settle while idle goes after older held results", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.state.idle = true;
		h.settle("L2");
		assert.deepEqual(h.delivered, ["L1:R-L1", "L2:R-L2"]);
	});

	it("never delivers twice across repeated idle signals", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.state.idle = true;
		h.delivery.flush();
		h.delivery.flush();
		h.delivery.flush();
		assert.deepEqual(h.delivered, ["L1:R-L1"]);
		h.settle("L1", "again");
		assert.deepEqual(h.delivered, ["L1:R-L1"], "a launch settles once; a repeated settle of a consumed id is ignored");
	});

	it("a delivery that re-enters flush (the parent turn starts synchronously) does not deliver the rest twice", () => {
		const consumed = new Set<string>();
		const seen: string[] = [];
		let idle = false;
		const delivery = createResultDelivery<string>({
			isIdle: () => idle,
			isConsumed: (id) => consumed.has(id),
			markConsumed: (id) => void consumed.add(id),
			deliver: ({ id }) => {
				seen.push(id);
				delivery.flush();
			},
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		delivery.settled({ launch: summary("L2"), result: "b" });
		idle = true;
		delivery.flush();
		assert.deepEqual(seen, ["L1", "L2"]);
	});

	it("a throwing deliver keeps the launch held and unconsumed, and does not stop later deliveries", () => {
		const consumed = new Set<string>();
		const seen: string[] = [];
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: (id) => consumed.has(id),
			markConsumed: (id) => void consumed.add(id),
			deliver: ({ id }) => {
				if (id === "L1") throw new Error("stale ctx");
				seen.push(id);
			},
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		delivery.settled({ launch: summary("L2"), result: "b" });
		assert.deepEqual(seen, ["L2"]);
		assert.equal(consumed.has("L1"), false);
		assert.equal(consumed.has("L2"), true);
		assert.deepEqual(delivery.held(), ["L1"], "kept (and so pinned) for a retry");
		assert.equal(delivery.isHeld("L1"), true);
	});
});

describe("result delivery: a delivery that throws is retried, then reported", () => {
	/** `deliver` throws while `failing` holds a launch id; every failure and notice is recorded. */
	function flaky(failing: Set<string>) {
		const consumed = new Set<string>();
		const log = { delivered: [] as string[], attempts: [] as string[], failed: [] as string[], errors: [] as unknown[] };
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: (id) => consumed.has(id),
			markConsumed: (id) => void consumed.add(id),
			deliver: ({ id }) => {
				log.attempts.push(id);
				if (failing.has(id)) throw new Error(`stale ${id}`);
				log.delivered.push(id);
			},
			onDeliveryFailed: ({ id }, error) => {
				log.failed.push(id);
				log.errors.push(error);
			},
		});
		return { consumed, log, delivery };
	}

	it("a failed delivery is retried on the next idle flush and succeeds once the parent accepts it", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		assert.deepEqual(h.log.attempts, ["L1"], "one attempt per flush, not a loop");
		assert.deepEqual(h.delivery.held(), ["L1"]);
		failing.clear();
		h.delivery.flush();
		assert.deepEqual(h.log.delivered, ["L1"]);
		assert.equal(h.consumed.has("L1"), true);
		assert.deepEqual(h.delivery.held(), []);
		assert.deepEqual(h.log.failed, [], "a retry that worked is not a failure");
	});

	it("gives up after the attempt bound: unconsumed, no longer held, reported once", () => {
		const h = flaky(new Set(["L1"]));
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		for (let i = 1; i < DELIVERY_ATTEMPTS; i++) {
			assert.deepEqual(h.log.failed, [], `still retrying after ${i} attempts`);
			assert.equal(h.delivery.isHeld("L1"), true);
			h.delivery.flush();
		}
		assert.equal(h.log.attempts.length, DELIVERY_ATTEMPTS);
		assert.deepEqual(h.log.failed, ["L1"]);
		assert.match(String((h.log.errors[0] as Error).message), /stale L1/, "the last error is passed on");
		assert.equal(h.consumed.has("L1"), false, "left unconsumed so subagent_wait can still collect it");
		assert.equal(h.delivery.isHeld("L1"), false, "unpinned: the registry may prune it");
		h.delivery.flush();
		h.delivery.flush();
		assert.equal(h.log.attempts.length, DELIVERY_ATTEMPTS, "no attempts after giving up");
		assert.deepEqual(h.log.failed, ["L1"], "reported exactly once");
	});

	it("other items keep flowing while one fails, and order is kept on the retry", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.delivery.settled({ launch: summary("L2"), result: "b" });
		// Any flush retries what is held (here the one L2's settle triggers), so L1 has had two attempts by now.
		assert.deepEqual(h.log.delivered, ["L2"]);
		assert.deepEqual(h.delivery.held(), ["L1"]);
		failing.clear();
		h.delivery.flush();
		assert.deepEqual(h.log.delivered, ["L2", "L1"]);
		assert.deepEqual(h.log.failed, []);
	});

	it("a retried item that was collected by wait meanwhile is dropped without a report", () => {
		const h = flaky(new Set(["L1"]));
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.consumed.add("L1");
		h.delivery.flush();
		assert.deepEqual(h.delivery.held(), []);
		assert.deepEqual(h.log.failed, []);
		assert.equal(h.log.attempts.length, 1);
	});

	it("a throwing onDeliveryFailed does not break the flush; without one a give-up is silent", () => {
		const seen: string[] = [];
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: () => false,
			markConsumed: () => {},
			deliver: ({ id }) => {
				if (id === "L1") throw new Error("x");
				seen.push(id);
			},
			onDeliveryFailed: () => {
				throw new Error("ui gone");
			},
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		for (let i = 1; i < DELIVERY_ATTEMPTS; i++) delivery.flush();
		delivery.settled({ launch: summary("L2"), result: "b" });
		assert.deepEqual(seen, ["L2"]);
		assert.deepEqual(delivery.held(), []);
	});

	it("stop and reset forget the retry bookkeeping", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.delivery.reset();
		assert.deepEqual(h.delivery.held(), []);
		// The same id settling again in a new session gets a fresh bound.
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		for (let i = 1; i < DELIVERY_ATTEMPTS; i++) h.delivery.flush();
		assert.equal(h.log.attempts.length, 1 + DELIVERY_ATTEMPTS);
		assert.deepEqual(h.log.failed, ["L1"]);
	});
});

describe("result delivery: session lifecycle", () => {
	it("reset clears held results (a new session)", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.delivery.reset();
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.delivered, []);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("stop clears held results and ignores settles that arrive after it (shutdown aborts children, which then settle)", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.delivery.stop();
		h.settle("L2");
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.delivered, []);
		h.delivery.reset();
		h.settle("L3");
		assert.deepEqual(h.delivered, ["L3:R-L3"], "reset starts delivering again");
	});

	it("isHeld tells which launches the registry must keep", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		assert.equal(h.delivery.isHeld("L1"), true);
		assert.equal(h.delivery.isHeld("L2"), false);
	});
});

describe("result delivery with the registry", () => {
	const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

	function wired(maxSettled: number) {
		let n = 0;
		let idle = false;
		const delivered: string[] = [];
		// biome-ignore lint: the delivery is created after the registry, like the extension does
		let delivery!: ReturnType<typeof createResultDelivery<string>>;
		const registry = createSubagentRegistry<string>({
			setTimer: (fn, ms) => setTimeout(fn, ms),
			clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
			newId: () => `L${++n}`,
			maxSettled,
			isPinned: (id) => delivery.isHeld(id),
		});
		delivery = createResultDelivery<string>({
			isIdle: () => idle,
			isConsumed: (id) => registry.get(id)?.consumed ?? true,
			markConsumed: (id) => void registry.markConsumed(id),
			deliver: ({ id, result }) => void delivered.push(`${id}:${result}`),
		});
		registry.subscribe((e) => e.type === "settle" && delivery.settled(e));
		return { registry, delivery, delivered, setIdle: (v: boolean) => (idle = v) };
	}

	it("the settled-launch prune never drops a held, undelivered result", async () => {
		const h = wired(2);
		const first = h.registry.start({ total: 1, run: async () => "first" });
		await tick();
		for (let i = 0; i < 6; i++) h.registry.start({ total: 1, run: async () => `x${i}` });
		await tick();
		assert.ok(h.registry.get(first), "the held launch is still in the registry, so wait can still collect it");
		assert.equal(h.registry.get(first)?.consumed, false);
		h.setIdle(true);
		h.delivery.flush();
		assert.equal(h.delivered[0], `${first}:first`);
		assert.equal(h.registry.get(first)?.consumed, true, "delivery consumed it");
		assert.equal(h.delivered.length, 7, "all held results flushed once, none lost");
		// Once delivered (consumed, no longer held) it can be pruned like any other settled launch.
		h.registry.start({ total: 1, run: async () => "y" });
		await tick();
		assert.equal(h.registry.get(first), undefined);
	});

	it("a result collected by wait while held is not delivered, even after the prune", async () => {
		const h = wired(2);
		const first = h.registry.start({ total: 1, run: async () => "first" });
		await tick();
		const outcome = await h.registry.wait(first, 1000);
		assert.equal(outcome.status, "settled");
		for (let i = 0; i < 6; i++) h.registry.start({ total: 1, run: async () => `x${i}` });
		await tick();
		h.setIdle(true);
		h.delivery.flush();
		assert.ok(!h.delivered.some((d) => d.startsWith(`${first}:`)));
		assert.equal(h.delivered.length, 6);
		assert.equal(h.registry.get(first)?.consumedBy, "wait");
	});

	it("a wait after delivery sees that the launch was delivered, not collected", async () => {
		const h = wired(5);
		h.setIdle(true);
		const id = h.registry.start({ total: 1, run: async () => "the report" });
		await tick();
		assert.deepEqual(h.delivered, [`${id}:the report`]);
		const outcome = await h.registry.wait(id, 1000);
		assert.equal(outcome.status === "settled" && outcome.launch.consumedBy, "delivered");
	});
});

describe("alreadyDeliveredText: what subagent_wait says about a launch whose result was delivered", () => {
	it("names the launch, says it was delivered to this session, and lists each task's saved folder", () => {
		const text = alreadyDeliveredText("launch-7", [
			{ agent: "scout", artifactsDir: "/docs/runs/scout-1" },
			{ agent: "reviewer", artifactsDir: "/docs/runs/reviewer-2" },
		]);
		assert.match(text, /launch-7/);
		assert.match(text, /already delivered to this session/);
		assert.ok(text.includes("scout: /docs/runs/scout-1"));
		assert.ok(text.includes("reviewer: /docs/runs/reviewer-2"));
		assert.ok(text.includes("result.json"), "says where the full text is");
	});

	it("a task without a saved folder says so; no tasks at all still names the launch", () => {
		assert.ok(alreadyDeliveredText("L1", [{ agent: "scout" }]).includes("scout: (no saved folder)"));
		const bare = alreadyDeliveredText("L2", []);
		assert.match(bare, /L2/);
		assert.match(bare, /already delivered to this session/);
		assert.ok(!bare.includes("result.json"));
	});

	it("carries none of the result text", () => {
		const text = alreadyDeliveredText("L1", [{ agent: "scout", artifactsDir: "/d/r" }]);
		assert.ok(text.split("\n").length <= 4);
	});
});

describe("deliveredNote: the one decision both subagent_wait and subagent_cancel use", () => {
	const outcome = (consumedBy: "wait" | "cancel" | "delivered" | undefined) => ({
		status: "settled" as const,
		launch: summary("L1", consumedBy ? { consumed: true, consumedBy } : {}),
		result: { details: { results: [{ agent: "scout", artifactsDir: "/d/runs/scout-1" }, { agent: "reviewer" }] } },
	});

	it("a settled launch the idle delivery already put in the session gets the short note", () => {
		const note = deliveredNote("L1", outcome("delivered"));
		assert.equal(note, alreadyDeliveredText("L1", [{ agent: "scout", artifactsDir: "/d/runs/scout-1" }, { agent: "reviewer", artifactsDir: undefined }]));
	});

	it("anything else is collected normally (undefined)", () => {
		assert.equal(deliveredNote("L1", outcome("wait")), undefined);
		assert.equal(deliveredNote("L1", outcome("cancel")), undefined);
		assert.equal(deliveredNote("L1", outcome(undefined)), undefined);
		assert.equal(deliveredNote("L1", { status: "unknown" }), undefined);
		assert.equal(deliveredNote("L1", { status: "running", launch: summary("L1", { status: "running" }) }), undefined);
	});

	it("a delivered launch with no result still gets the note, naming no folders", () => {
		const note = deliveredNote("L1", { status: "settled", launch: summary("L1", { consumed: true, consumedBy: "delivered" }), error: "boom" });
		assert.equal(note, alreadyDeliveredText("L1", []));
	});

	it("cancel after delivery through the registry reports the note, not the result", async () => {
		const registry = createSubagentRegistry<{ details: { results: { agent: string }[] } }>({ setTimer: setTimeout, clearTimer: (h) => clearTimeout(h as NodeJS.Timeout), newId: () => "L2" });
		registry.start({ total: 1, run: async () => ({ details: { results: [{ agent: "scout" }] } }) });
		await new Promise((resolve) => setImmediate(resolve));
		assert.equal(registry.markConsumed("L2"), true);
		const cancelled = await registry.cancel("L2");
		assert.match(deliveredNote("L2", cancelled) ?? "", /already delivered to this session/);
	});
});

describe("result delivery: the injected message and its card", () => {
	it("the message carries the launch id and the wait text, and tells the model not to wait again", () => {
		const m = resultMessage("launch-1", "Parallel: 1/1 succeeded\n\n### [scout] completed\n\nok", false);
		assert.equal(m.customType, RESULT_MESSAGE_TYPE);
		assert.equal(m.display, true);
		assert.deepEqual(m.details, { launchId: "launch-1", failed: false });
		assert.ok(m.content.includes("launch-1"));
		assert.ok(m.content.endsWith("\n\nParallel: 1/1 succeeded\n\n### [scout] completed\n\nok"));
		assert.match(m.content.split("\n")[0], /do not call subagent_wait/);
	});

	it("collapsed card: header, the first lines, and a count of the rest", () => {
		const m = resultMessage("L1", ["a", "b", "c", "d", "e"].join("\n"), false);
		const card = resultCard(m.content, m.details, false);
		assert.deepEqual(card.lines.map((l) => l.text), ["✓ subagent L1 finished (delivered)", "  a", "  b", "  c", "  … 2 more lines"]);
		assert.equal(card.hidden, 2);
		assert.equal(card.lines[0].tone, "success");
	});

	it("a short result has no 'more' line, and an error is flagged", () => {
		const m = resultMessage("L2", "Agent error: boom", true);
		const card = resultCard(m.content, m.details, false);
		assert.deepEqual(card.lines.map((l) => l.text), ["✗ subagent L2 finished with errors (delivered)", "  Agent error: boom"]);
		assert.equal(card.lines[0].tone, "error");
		assert.equal(card.hidden, 0);
	});

	it("expanded card: only the header; the body is the whole text", () => {
		const m = resultMessage("L1", "x\ny\nz\nw", false);
		const card = resultCard(m.content, m.details, true);
		assert.equal(card.lines.length, 1);
		assert.equal(card.body, "x\ny\nz\nw");
	});
});
