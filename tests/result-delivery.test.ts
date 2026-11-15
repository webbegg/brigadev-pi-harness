import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alreadyDeliveredText, BATCH_TEXT_CAP, createResultDelivery, DELIVERY_ATTEMPTS, deliveredNote, omittedLaunchIds, omittedResultText, RESULT_MESSAGE_TYPE, resultBatchMessage, resultCard, resultMessage } from "../lib/result-delivery.ts";
import { PER_TASK_OUTPUT_CAP } from "../lib/subagent-launch.ts";
import { createSubagentRegistry, type LaunchSummary } from "../lib/subagent-registry.ts";

const summary = (id: string, over: Partial<LaunchSummary> = {}): LaunchSummary => ({ id, status: "settled", total: 1, done: 1, startedAt: 0, settledAt: 1, consumed: false, error: undefined, ...over });

/** A delivery buffer over a fake parent: `idle` is flipped by the test, `consumed` stands for wait/cancel. */
function rig() {
	const state = { idle: true };
	const consumed = new Set<string>();
	const delivered: string[] = [];
	// One entry per `deliver` call: the ids of the batch it got.
	const batches: string[][] = [];
	const marked: string[] = [];
	const delivery = createResultDelivery<string>({
		isIdle: () => state.idle,
		isConsumed: (id) => consumed.has(id),
		markConsumed: (id) => {
			marked.push(id);
			consumed.add(id);
		},
		deliver: (batch) => {
			batches.push(batch.map((b) => b.id));
			for (const { id, result } of batch) delivered.push(`${id}:${result}`);
		},
	});
	return { state, consumed, delivered, batches, marked, delivery, settle: (id: string, result = `R-${id}`) => delivery.settled({ launch: summary(id), result }) };
}

describe("result delivery: idle and busy", () => {
	it("delivers at once when the parent is idle, and marks the launch consumed", () => {
		const h = rig();
		h.settle("L1");
		assert.deepEqual(h.delivered, ["L1:R-L1"]);
		assert.deepEqual(h.batches, [["L1"]], "a settle while idle with one ready item is a batch of one");
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
		assert.deepEqual(h.batches, [["L2"]], "the collected one is not in the batch");
		assert.deepEqual(h.marked, ["L2"]);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("a batch whose items were all collected meanwhile delivers nothing", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.settle("L2");
		h.consumed.add("L1");
		h.consumed.add("L2");
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.batches, []);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("ignores a settle for a launch that was already consumed (sync launches never get here; this covers a wait that raced the settle)", () => {
		const h = rig();
		h.delivery.settled({ launch: summary("L1", { consumed: true }), result: "R" });
		assert.deepEqual(h.delivered, []);
		assert.deepEqual(h.delivery.held(), []);
	});

	it("D1: one flush delivers every held result as ONE batch, in settle order", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L3");
		h.settle("L1");
		h.settle("L2");
		h.state.idle = true;
		h.delivery.flush();
		assert.deepEqual(h.batches, [["L3", "L1", "L2"]], "one deliver call, so one message, so one parent turn");
		assert.deepEqual(h.delivered, ["L3:R-L3", "L1:R-L1", "L2:R-L2"]);
		assert.deepEqual(h.marked, ["L3", "L1", "L2"], "every item of the batch is marked consumed");
		assert.deepEqual(h.delivery.held(), []);
	});

	it("D1: a new settle while idle joins older held results in the same batch", () => {
		const h = rig();
		h.state.idle = false;
		h.settle("L1");
		h.state.idle = true;
		h.settle("L2");
		assert.deepEqual(h.batches, [["L1", "L2"]]);
	});

	it("D1: a launch that settles during the delivery of a batch is not dropped: it goes to the next flush", () => {
		const consumed = new Set<string>();
		const batches: string[][] = [];
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: (id) => consumed.has(id),
			markConsumed: (id) => void consumed.add(id),
			deliver: (batch) => {
				batches.push(batch.map((b) => b.id));
				if (batches.length === 1) delivery.settled({ launch: summary("L2"), result: "b" });
			},
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		assert.deepEqual(batches, [["L1"]], "not folded into the message being sent, not a second message in the same flush");
		assert.deepEqual(delivery.held(), ["L2"]);
		assert.equal(consumed.has("L2"), false);
		delivery.flush();
		assert.deepEqual(batches, [["L1"], ["L2"]]);
		assert.deepEqual(delivery.held(), []);
	});

	it("D1: markConsumed runs only after a successful deliver", () => {
		const events: string[] = [];
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: () => false,
			markConsumed: (id) => void events.push(`mark ${id}`),
			deliver: (batch) => void events.push(`deliver ${batch.map((b) => b.id).join("+")}`),
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		assert.deepEqual(events, ["deliver L1", "mark L1"]);
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
			deliver: (batch) => {
				seen.push(batch.map((b) => b.id).join("+"));
				delivery.flush();
			},
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		delivery.settled({ launch: summary("L2"), result: "b" });
		idle = true;
		delivery.flush();
		assert.deepEqual(seen, ["L1+L2"], "one batch, delivered once");
	});

	it("a throwing deliver keeps the whole batch held, in order, and unconsumed", () => {
		const consumed = new Set<string>();
		const seen: string[][] = [];
		let failing = true;
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: (id) => consumed.has(id),
			markConsumed: (id) => void consumed.add(id),
			deliver: (batch) => {
				if (failing) throw new Error("stale ctx");
				seen.push(batch.map((b) => b.id));
			},
		});
		delivery.settled({ launch: summary("L1"), result: "a" });
		delivery.settled({ launch: summary("L2"), result: "b" });
		assert.deepEqual(seen, []);
		assert.equal(consumed.has("L1"), false);
		assert.equal(consumed.has("L2"), false);
		assert.deepEqual(delivery.held(), ["L1", "L2"], "kept (and so pinned) for a retry, in settle order");
		assert.equal(delivery.isHeld("L1"), true);
		failing = false;
		delivery.flush();
		assert.deepEqual(seen, [["L1", "L2"]]);
		assert.equal(consumed.has("L1") && consumed.has("L2"), true);
	});
});

describe("result delivery: a delivery that throws is retried, then reported", () => {
	/** `deliver` throws while its batch holds a launch id of `failing`; every failure and notice is recorded. */
	function flaky(failing: Set<string>) {
		const consumed = new Set<string>();
		const log = { delivered: [] as string[][], attempts: [] as string[][], failed: [] as string[], errors: [] as unknown[] };
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: (id) => consumed.has(id),
			markConsumed: (id) => void consumed.add(id),
			deliver: (batch) => {
				const ids = batch.map((b) => b.id);
				log.attempts.push(ids);
				const bad = ids.find((id) => failing.has(id));
				if (bad !== undefined) throw new Error(`stale ${bad}`);
				log.delivered.push(ids);
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
		assert.deepEqual(h.log.attempts, [["L1"]], "one attempt per flush, not a loop");
		assert.deepEqual(h.delivery.held(), ["L1"]);
		failing.clear();
		h.delivery.flush();
		assert.deepEqual(h.log.delivered, [["L1"]]);
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

	it("give-up releases every item of the batch unconsumed and reports each once", () => {
		const h = flaky(new Set(["L1"]));
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.delivery.settled({ launch: summary("L2"), result: "b" });
		for (let i = 1; i < DELIVERY_ATTEMPTS; i++) h.delivery.flush();
		assert.deepEqual(h.log.failed, ["L1", "L2"], "onDeliveryFailed once per item, in order");
		assert.equal(h.consumed.size, 0);
		assert.deepEqual(h.delivery.held(), []);
		assert.equal(h.delivery.isHeld("L2"), false);
	});

	it("a failed batch stays held as a whole, in order; a later settle joins it, and the retry sends them together", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.delivery.settled({ launch: summary("L2"), result: "b" });
		assert.deepEqual(h.log.delivered, []);
		assert.deepEqual(h.delivery.held(), ["L1", "L2"]);
		failing.clear();
		h.delivery.flush();
		assert.deepEqual(h.log.delivered, [["L1", "L2"]]);
		assert.deepEqual(h.log.failed, []);
	});

	it("R3-101: unrelated settles while idle do not burn the attempt budget; idle signals do", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		// Three more launches settle while the parent is idle: each triggers a flush that retries the whole batch.
		for (const id of ["L2", "L3", "L4"]) h.delivery.settled({ launch: summary(id), result: id });
		assert.deepEqual(h.log.failed, [], "settle-triggered flushes do not spend the batch's budget");
		assert.deepEqual(h.delivery.held(), ["L1", "L2", "L3", "L4"]);
		assert.deepEqual(h.log.delivered, []);
		// Only idle signals (flush) count: the settle-time attempt was the first, so two more give up.
		for (let i = 1; i < DELIVERY_ATTEMPTS; i++) {
			assert.deepEqual(h.log.failed, [], `still retrying before idle signal ${i}`);
			h.delivery.flush();
		}
		assert.deepEqual(h.log.failed, ["L1", "L2", "L3", "L4"], "the idle signals exhausted the budget; every item is reported");
		assert.equal(h.delivery.isHeld("L1"), false);
	});

	it("R3-101: a settle-triggered flush still retries an earlier failure, so it can succeed without an idle signal", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		failing.clear();
		h.delivery.settled({ launch: summary("L2"), result: "b" });
		assert.deepEqual(h.log.delivered, [["L1", "L2"]], "earlier failure first, then the new one, in one batch");
		assert.deepEqual(h.delivery.held(), []);
	});

	it("R3-101: settles between idle signals never add attempts beyond one per signal", () => {
		const h = flaky(new Set(["L1"]));
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.delivery.settled({ launch: summary("L2"), result: "b" });
		h.delivery.flush(); // idle signal 1: attempt 2
		h.delivery.settled({ launch: summary("L3"), result: "c" });
		h.delivery.settled({ launch: summary("L4"), result: "d" });
		assert.deepEqual(h.log.failed, [], "two attempts counted so far");
		h.delivery.flush(); // idle signal 2: attempt 3 = the bound
		assert.deepEqual(h.log.failed, ["L1", "L2", "L3", "L4"]);
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

	it("a retried batch drops the item that was collected meanwhile and sends the rest", () => {
		const failing = new Set(["L1"]);
		const h = flaky(failing);
		h.delivery.settled({ launch: summary("L1"), result: "a" });
		h.delivery.settled({ launch: summary("L2"), result: "b" });
		h.consumed.add("L1");
		h.delivery.flush();
		assert.deepEqual(h.log.delivered, [["L2"]]);
	});

	it("a throwing onDeliveryFailed does not break the flush; without one a give-up is silent", () => {
		const seen: string[] = [];
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: () => false,
			markConsumed: () => {},
			deliver: (batch) => {
				if (batch.some((b) => b.id === "L1")) throw new Error("x");
				seen.push(...batch.map((b) => b.id));
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

	it("a reset during a failing delivery does not bring the batch back", () => {
		const box: { delivery?: ReturnType<typeof createResultDelivery<string>> } = {};
		const delivery = createResultDelivery<string>({
			isIdle: () => true,
			isConsumed: () => false,
			markConsumed: () => {},
			deliver: () => {
				box.delivery?.reset();
				throw new Error("stale");
			},
		});
		box.delivery = delivery;
		delivery.settled({ launch: summary("L1"), result: "a" });
		assert.deepEqual(delivery.held(), []);
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
			deliver: (batch) => void delivered.push(...batch.map(({ id, result }) => `${id}:${result}`)),
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

type R0 = { details: { results: { agent: string; artifactsDir?: string }[] } };

describe("deliveredNote: the one decision both subagent_wait and subagent_cancel use", () => {
	const outcome = (consumedBy: "wait" | "cancel" | "delivered" | "delivered-omitted" | undefined) => ({
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

	it("a launch delivered as a pointer gets a note that says its result was too large to include and points to result.json", () => {
		const note = deliveredNote("L1", outcome("delivered-omitted")) ?? "";
		assert.equal(note, alreadyDeliveredText("L1", [{ agent: "scout", artifactsDir: "/d/runs/scout-1" }, { agent: "reviewer", artifactsDir: undefined }], { omitted: true }));
		assert.match(note, /too large to include in the delivered message/);
		assert.match(note, /result\.json/);
		assert.ok(note.includes("scout: /d/runs/scout-1"));
		assert.ok(!note.includes("in the conversation above"), "the false claim is gone");
		assert.notEqual(note, deliveredNote("L1", outcome("delivered")));
	});

	it("a full-text delivery keeps today's note exactly", () => {
		const note = deliveredNote("L1", outcome("delivered")) ?? "";
		assert.ok(note.startsWith("Launch L1 was already delivered to this session: its result is in the conversation above, so it is not repeated here."));
		assert.equal(note, alreadyDeliveredText("L1", [{ agent: "scout", artifactsDir: "/d/runs/scout-1" }, { agent: "reviewer", artifactsDir: undefined }]));
	});

	it("through the real registry: an omitted launch gets the pointer note via wait and cancel; a full-text one the unchanged note; the first consumer wins", async () => {
		type R = { details: { results: { agent: string; artifactsDir?: string }[] } };
		let n = 0;
		const registry = createSubagentRegistry<R>({ setTimer: setTimeout, clearTimer: (h) => clearTimeout(h as NodeJS.Timeout), newId: () => `L${++n}` });
		const ids = ["full", "cut"].map(() => registry.start({ total: 1, run: async () => ({ details: { results: [{ agent: "scout", artifactsDir: `/d/runs/${n}` }] } }) }));
		await new Promise((resolve) => setImmediate(resolve));
		// What the extension does after a delivery: the ids the size guard replaced are marked as delivered-omitted.
		const omitted = new Set(omittedLaunchIds([{ id: ids[0], text: "a".repeat(100), failed: false, pointer: "" }, { id: ids[1], text: "b".repeat(150), failed: false, pointer: "" }], 200));
		for (const id of ids) assert.equal(registry.markConsumed(id, omitted.has(id) ? "delivered-omitted" : "delivered"), true);
		assert.equal(registry.markConsumed(ids[1]), false);

		const waitedCut = await registry.wait(ids[1], 1000);
		const cancelledCut = await registry.cancel(ids[1]);
		for (const o of [waitedCut, cancelledCut]) {
			assert.match(deliveredNote(ids[1], o) ?? "", /too large to include in the delivered message/);
			assert.ok(!(deliveredNote(ids[1], o) ?? "").includes("in the conversation above"));
		}
		const waitedFull = await registry.wait(ids[0], 1000);
		const cancelledFull = await registry.cancel(ids[0]);
		for (const o of [waitedFull, cancelledFull]) assert.match(deliveredNote(ids[0], o) ?? "", /its result is in the conversation above/);
	});

	it("first consumer wins: an omitted delivery after a wait stays `wait` and gets no note", async () => {
		const registry = createSubagentRegistry<R0>({ setTimer: setTimeout, clearTimer: (h) => clearTimeout(h as NodeJS.Timeout), newId: () => "L9" });
		registry.start({ total: 1, run: async () => ({ details: { results: [] } }) });
		await new Promise((resolve) => setImmediate(resolve));
		await registry.wait("L9", 1000);
		assert.equal(registry.markConsumed("L9", "delivered-omitted"), false);
		const again = await registry.wait("L9", 1000);
		assert.equal(again.status === "settled" && again.launch.consumedBy, "wait");
		assert.equal(deliveredNote("L9", again), undefined);
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

describe("D1: the combined message of a batch and its card", () => {
	const entry = (id: string, text: string, failed = false) => ({ id, text, failed, pointer: omittedResultText(id, [{ agent: "scout", artifactsDir: `/docs/runs/${id}` }]) });
	const bytes = (s: string) => Buffer.byteLength(s, "utf8");

	it("the size cap is four per-task caps", () => {
		assert.equal(BATCH_TEXT_CAP, 4 * PER_TASK_OUTPUT_CAP);
	});

	it("one message that says how many results it holds, lists each launch in order with its wait text, and tells the model not to wait", () => {
		const m = resultBatchMessage([entry("L1", "Parallel: 1/1 succeeded\n\n### [scout] completed\n\nok"), entry("L2", "Agent error: boom", true)]);
		assert.equal(m.customType, RESULT_MESSAGE_TYPE);
		assert.equal(m.display, true);
		const first = m.content.split("\n")[0];
		assert.match(first, /2 async subagent results/);
		assert.match(first, /do not call subagent_wait/);
		const at = (s: string) => m.content.indexOf(s);
		assert.ok(at("L1") > 0 && at("L1") < at("Parallel: 1/1 succeeded") && at("Parallel: 1/1 succeeded") < at("L2: finished with errors") && at("L2: finished with errors") < at("Agent error: boom"));
		assert.ok(m.content.includes("L1: finished\n\nParallel: 1/1 succeeded\n\n### [scout] completed\n\nok"), "each launch carries exactly the text subagent_wait would return");
		assert.deepEqual(m.details, { launchId: "L1", failed: true, launches: [{ id: "L1", failed: false }, { id: "L2", failed: true }] });
	});

	it("a batch of one is the plain single message", () => {
		assert.deepEqual(resultBatchMessage([entry("L1", "ok")]), resultMessage("L1", "ok", false));
	});

	it("size guard: items past the cap keep a pointer to their saved folders instead of their text; the first is always whole", () => {
		const big = (c: string) => c.repeat(120 * 1024);
		const m = resultBatchMessage([entry("L1", big("a")), entry("L2", big("b")), entry("L3", big("c"))]);
		assert.ok(m.content.includes(big("a")), "the first item keeps its full text");
		assert.ok(!m.content.includes("bbbbbbbb") && !m.content.includes("cccccccc"), "later items lose their text");
		assert.ok(m.content.includes(omittedResultText("L2", [{ agent: "scout", artifactsDir: "/docs/runs/L2" }])));
		assert.ok(m.content.includes("/docs/runs/L3"));
		assert.ok(bytes(m.content) < BATCH_TEXT_CAP + 4096, "one message never explodes");
		assert.deepEqual(m.details.launches, [{ id: "L1", failed: false }, { id: "L2", failed: false }, { id: "L3", failed: false }], "every launch is still listed");
		const huge = resultBatchMessage([entry("L1", "z".repeat(BATCH_TEXT_CAP + 10)), entry("L2", "small")]);
		assert.ok(huge.content.includes("z".repeat(BATCH_TEXT_CAP + 10)), "the first item is never cut, even above the cap");
		assert.ok(!huge.content.includes("small"), "nothing else fits after it");
	});

	it("size guard: once one item overflows, every later one is a pointer too (the full ones are a prefix)", () => {
		const m = resultBatchMessage([entry("L1", "a".repeat(100)), entry("L2", "b".repeat(150)), entry("L3", "c".repeat(10))], 200);
		assert.ok(m.content.includes("a".repeat(100)));
		assert.ok(!m.content.includes("bbbb"));
		assert.ok(!m.content.includes("cccc"), "L3 would fit, but the order of results is kept");
		assert.ok(m.content.includes("/docs/runs/L3"));
	});

	it("omittedLaunchIds: the ids whose text the size guard replaces, the same rule resultBatchMessage applies", () => {
		const e = (id: string, n: number) => entry(id, "x".repeat(n));
		assert.deepEqual(omittedLaunchIds([e("L1", 100), e("L2", 150), e("L3", 10)], 200), ["L2", "L3"]);
		assert.deepEqual(omittedLaunchIds([e("L1", 100), e("L2", 50)], 200), []);
		assert.deepEqual(omittedLaunchIds([e("L1", BATCH_TEXT_CAP + 10), e("L2", 1)]), ["L2"], "the first is never omitted");
		assert.deepEqual(omittedLaunchIds([e("L1", BATCH_TEXT_CAP + 10)]), []);
		assert.deepEqual(omittedLaunchIds([]), []);
	});

	it("omittedResultText: names the launch, says the text was left out, lists each task's saved folder", () => {
		const text = omittedResultText("L9", [{ agent: "scout", artifactsDir: "/d/runs/s" }, { agent: "reviewer" }]);
		assert.match(text, /L9/);
		assert.match(text, /left out/);
		assert.ok(text.includes("scout: /d/runs/s"));
		assert.ok(text.includes("reviewer: (no saved folder)"));
		assert.ok(text.includes("result.json"));
	});

	it("collapsed card: a header with the count, each launch's first lines, and what is hidden", () => {
		const m = resultBatchMessage([entry("L1", "a\nb\nc"), entry("L2", "x")]);
		const card = resultCard(m.content, m.details, false);
		assert.deepEqual(card.lines.map((l) => l.text), ["✓ 2 subagent results (delivered)", "  ✓ L1 finished", "    a", "    b", "    … 1 more line", "  ✓ L2 finished", "    x"]);
		assert.equal(card.hidden, 1);
		assert.equal(card.lines[0].tone, "success");
	});

	it("collapsed card: a failed launch is flagged in the header and on its own line", () => {
		const m = resultBatchMessage([entry("L1", "ok"), entry("L2", "Agent error: boom", true)]);
		const card = resultCard(m.content, m.details, false);
		assert.equal(card.lines[0].text, "✗ 2 subagent results, 1 with errors (delivered)");
		assert.equal(card.lines[0].tone, "error");
		const l2 = card.lines.findIndex((l) => l.text === "  ✗ L2 finished with errors");
		assert.ok(l2 > 0);
		assert.equal(card.lines[l2].tone, "error");
		assert.equal(card.lines[l2 + 1].text, "    Agent error: boom");
	});

	it("expanded card: only the header line; the body holds every launch's whole text", () => {
		const m = resultBatchMessage([entry("L1", "a\nb\nc\nd"), entry("L2", "x\ny")]);
		const card = resultCard(m.content, m.details, true);
		assert.deepEqual(card.lines.map((l) => l.text), ["✓ 2 subagent results (delivered)"]);
		assert.equal(card.hidden, 0);
		assert.ok(card.body.includes("a\nb\nc\nd"));
		assert.ok(card.body.includes("x\ny"));
		assert.ok(card.body.indexOf("L1") < card.body.indexOf("L2"));
	});

	it("a launch's text that contains another launch's heading does not confuse the card", () => {
		const tricky = entry("L1", "see L2: finished\nmore");
		const m = resultBatchMessage([tricky, entry("L2", "real")]);
		const card = resultCard(m.content, m.details, false);
		assert.deepEqual(card.lines.map((l) => l.text), ["✓ 2 subagent results (delivered)", "  ✓ L1 finished", "    see L2: finished", "    more", "  ✓ L2 finished", "    real"]);
	});
});
