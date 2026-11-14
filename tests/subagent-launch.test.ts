import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../lib/child-run.ts";
import { emptyTally } from "../lib/cost.ts";
import type { ActiveWriter } from "../lib/delegation.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { activeTasks } from "../lib/subagent-status.ts";
import { runLaunch, toResult, type AgentCall, type FallbackStep, type LaunchHooks, type LaunchTask } from "../lib/subagent-launch.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
	for (let i = 0; i < 5; i++) await tick();
};

const reply = (task: string, text: string, over: Partial<RunResult> = {}): RunResult => ({
	agent: "scout",
	task,
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as any],
	stderr: "",
	usage: emptyTally(),
	stopReason: "stop",
	...over,
});
const errored = (task: string, message: string): RunResult => reply(task, "", { stopReason: "error", errorMessage: message, messages: [] });

/** A runner the test finishes by hand. */
function manual() {
	let resolve!: (r: RunResult) => void;
	let reject!: (e: Error) => void;
	const promise = new Promise<RunResult>((res, rej) => ((resolve = res), (reject = rej)));
	return { promise, resolve, reject };
}

/** Rejects like a killed child when the launch is aborted. */
const killedOnAbort = (call: AgentCall) =>
	new Promise<RunResult>((_, reject) => {
		const kill = () => reject(new Error("Subagent was aborted"));
		if (call.signal?.aborted) kill();
		else call.signal?.addEventListener("abort", kill, { once: true });
	});

type Spec = { writer?: boolean; skills?: string[]; surfaces?: string[] };

function rig(specs: Spec[], options: { limit?: number; chain?: (index: number) => FallbackStep[]; snapshots?: Array<Map<string, string> | undefined> } = {}) {
	const slots = createSemaphore(options.limit ?? 4);
	const active: ActiveWriter[] = [];
	const events: string[] = [];
	const started: number[] = [];
	const cooled: string[] = [];
	const notices: string[] = [];
	const labels: string[] = [];
	const snapshots = [...(options.snapshots ?? [])];
	const addListeners = new Set<(ws: ActiveWriter[]) => void>();
	let run: (call: AgentCall) => Promise<RunResult> = async (call) => reply(`task ${call.index}`, `answer ${call.index}`);
	const tasks: LaunchTask[] = specs.map((spec, i) => ({
		request: { agent: spec.writer ? "builder" : "scout", task: `task ${i}`, reason: "Independent units", skills: spec.skills, allowedEditSurfaces: spec.surfaces ?? (spec.writer ? [`src/w${i}/**`] : undefined) },
		agent: { name: spec.writer ? "builder" : "scout", description: "d", writer: Boolean(spec.writer), systemPrompt: "", source: "package", filePath: "/a.md" },
		route: { model: "m1", modelSource: "definition", thinkingSource: "definition" },
		routeLabel: "definition",
	}));
	const results = (): RunResult[] => tasks.map((t, i) => ({ agent: t.agent.name, task: `task ${i}`, exitCode: -1, messages: [], stderr: "", usage: emptyTally(), queued: true }));
	const h = {
		slots,
		active,
		events,
		started,
		cooled,
		notices,
		labels,
		tasks,
		/** Fresh placeholders, as the extension builds them. */
		placeholders: results,
		/** Makes `view.start` throw for the given task (a stale context after /reload). */
		startError: undefined as ((index: number) => Error | undefined) | undefined,
		runner: (fn: typeof run) => void (run = fn),
		/** Another launch's writer registers (as the extension's shared list would report it). */
		registerOther(writer: ActiveWriter) {
			active.push(writer);
			addListeners.forEach((listener) => listener([writer]));
		},
		unregisterOther(writer: ActiveWriter) {
			active.splice(active.indexOf(writer), 1);
		},
		launch(mode: "single" | "parallel", hooks: Partial<LaunchHooks> = {}, signal?: AbortSignal, placeholders = results()) {
			return runLaunch(
				{ mode, tasks, results: placeholders, signal, hooks: { tolerateAbort: false, ...hooks } },
				{
					slots,
					runAgent: async (call) => {
						started.push(call.index);
						labels.push(call.routeLabel);
						const result = await run(call);
						// What the real runner stamps on every attempt.
						return Object.assign(result, { agent: tasks[call.index].agent.name, model: call.route.model, thinking: call.route.thinking });
					},
					skills: () => [],
					chain: options.chain ?? (() => [{ model: "m1" }]),
					coolModel: (model, category) => void cooled.push(`${model}:${category}`),
					fallbackNotice: (info) => void notices.push(`${info.from}->${info.to}:${info.category}`),
					writers: {
						add: (ws) => {
							active.push(...ws);
							addListeners.forEach((listener) => listener(ws));
						},
						remove: (w) => void (active.includes(w) && active.splice(active.indexOf(w), 1)),
						list: () => [...active],
						onAdd: (listener) => (addListeners.add(listener), () => void addListeners.delete(listener)),
					},
					view: {
						start: (i) => {
							events.push(`start:${i}`);
							const error = h.startError?.(i);
							if (error) throw error;
						},
						attempt: (i) => void events.push(`attempt:${i}`),
						update: (i) => void events.push(`update:${i}`),
						finish: (i) => void events.push(`finish:${i}`),
					},
					snapshot: async () => snapshots.shift(),
				},
			);
		},
	};
	return h;
}

/** Nothing may be left behind, whatever the path: no slot, no waiter, no writer. */
const assertClean = (h: ReturnType<typeof rig>) => {
	assert.equal(h.slots.active, 0, "every slot is released");
	assert.equal(h.slots.waiting, 0, "no acquire is left waiting");
	assert.deepEqual(h.active, [], "every writer is unregistered");
};

describe("runLaunch: slots and writers on every exit path", () => {
	it("success: runs under a slot, releases it, unregisters the writer", async () => {
		const h = rig([{ writer: true }]);
		h.runner(async (call) => {
			assert.equal(h.slots.active, 1);
			assert.equal(h.active.length, 1);
			return reply(`task ${call.index}`, "done");
		});
		const launched = await h.launch("single");
		assert.equal(launched.details.results[0].exitCode, 0);
		assertClean(h);
	});

	it("registers writers before the first await", () => {
		const h = rig([{ writer: true }, {}]);
		h.runner(() => new Promise(() => {}));
		void h.launch("parallel");
		assert.equal(h.active.length, 1);
		assert.equal(h.active[0].agent, "builder");
		assert.deepEqual(h.active[0].surfaces, ["src/w0/**"]);
	});

	it("failure: a failed child is a result, the slot and writer are released", async () => {
		const h = rig([{ writer: true }]);
		h.runner(async (call) => reply(`task ${call.index}`, "", { exitCode: 1, stderr: "bad" }));
		const launched = await h.launch("single");
		assert.equal(launched.details.results[0].exitCode, 1);
		assertClean(h);
	});

	it("thrown error: rethrown, with slot and writer released and the card settled", async () => {
		const h = rig([{ writer: true }]);
		h.runner(async () => {
			throw new Error("spawn exploded");
		});
		await assert.rejects(h.launch("single"), /spawn exploded/);
		assert.ok(h.events.includes("finish:0"));
		assertClean(h);
	});

	it("abort while running (sync): the launch throws and nothing is left held", async () => {
		const h = rig([{ writer: true }, {}]);
		h.runner(killedOnAbort);
		const abort = new AbortController();
		const launch = h.launch("parallel", {}, abort.signal);
		await settle();
		assert.equal(h.slots.active, 2);
		abort.abort();
		await assert.rejects(launch, /Subagent was aborted/);
		assertClean(h);
	});

	it("abort while running (async): settles with aborted partial results", async () => {
		const h = rig([{ writer: true }, {}]);
		h.runner(killedOnAbort);
		const abort = new AbortController();
		const launch = h.launch("parallel", { tolerateAbort: true }, abort.signal);
		await settle();
		abort.abort();
		const { details } = await launch;
		assert.deepEqual(details.results.map((r) => r.stopReason), ["aborted", "aborted"]);
		assert.ok(details.results.every((r) => r.endedAt !== undefined));
		assertClean(h);
	});

	it("abort while queued (async): the queued task never starts and settles cancelled", async () => {
		const h = rig([{}, { writer: true }], { limit: 1 });
		h.runner(killedOnAbort);
		const abort = new AbortController();
		const launch = h.launch("parallel", { tolerateAbort: true }, abort.signal);
		await settle();
		assert.equal(h.slots.waiting, 1);
		assert.deepEqual(h.active.map((w) => w.agent), ["builder"], "the queued writer is already registered");
		abort.abort();
		const { details } = await launch;
		assert.deepEqual(h.started, [0], "the queued task never started");
		assert.equal(details.results[1].cancelled, true);
		assert.equal(details.results[1].queued, true);
		assert.ok(details.results[1].endedAt !== undefined);
		assertClean(h);
	});

	it("abort while queued (sync): throws, and the queued writer is unregistered", async () => {
		const h = rig([{}, { writer: true }], { limit: 1 });
		h.runner(killedOnAbort);
		const abort = new AbortController();
		const launch = h.launch("parallel", {}, abort.signal);
		await settle();
		abort.abort();
		await assert.rejects(launch, /Subagent was aborted/);
		assert.deepEqual(h.started, [0]);
		assertClean(h);
	});

	it("an already-aborted signal starts nothing", async () => {
		const h = rig([{ writer: true }]);
		const abort = new AbortController();
		abort.abort();
		const { details } = await h.launch("single", { tolerateAbort: true }, abort.signal);
		assert.deepEqual(h.started, []);
		assert.equal(details.results[0].cancelled, true);
		assertClean(h);
	});

	it("shares one cap across tasks: the fifth waits for a slot", async () => {
		const h = rig([{}, {}, {}, {}, {}]);
		const gates = Array.from({ length: 5 }, manual);
		let peak = 0;
		h.runner((call) => {
			peak = Math.max(peak, h.slots.active);
			return gates[call.index].promise;
		});
		const launch = h.launch("parallel");
		await settle();
		assert.deepEqual(h.started, [0, 1, 2, 3]);
		assert.equal(h.slots.waiting, 1);
		gates[0].resolve(reply("task 0", "a"));
		await settle();
		assert.deepEqual(h.started, [0, 1, 2, 3, 4]);
		gates.slice(1).forEach((g, i) => g.resolve(reply(`task ${i + 1}`, "x")));
		await launch;
		assert.equal(peak, 4);
		assertClean(h);
	});

	it("fallback chain: the slot is held across attempts, the model is cooled, and it is released at the end", async () => {
		const h = rig([{ writer: true }], { chain: () => [{ model: "m1" }, { model: "m2" }, { model: "m3", thinking: "high" }] });
		const seen: Array<{ model?: string; active: number; writers: number }> = [];
		h.runner(async (call) => {
			seen.push({ model: call.route.model, active: h.slots.active, writers: h.active.length });
			return call.route.model === "m3" ? reply("task 0", "third time lucky") : errored("task 0", "429 rate limit");
		});
		const { details } = await h.launch("single");
		assert.deepEqual(seen, [
			{ model: "m1", active: 1, writers: 1 },
			{ model: "m2", active: 1, writers: 1 },
			{ model: "m3", active: 1, writers: 1 },
		]);
		assert.deepEqual(h.labels, ["definition", "definition ↪ fallback", "definition ↪ fallback"]);
		assert.deepEqual(h.cooled, ["m1:rate_limit", "m2:rate_limit"]);
		assert.deepEqual(h.notices, ["m1->m2:rate_limit", "m2->m3:rate_limit"]);
		assert.deepEqual(details.results[0].fallbacks, ["m1 (rate_limit)", "m2 (rate_limit)"]);
		assert.equal(details.results[0].model, "m3");
		assert.equal(details.results[0].thinking, "high");
		assertClean(h);
	});

	it("fallback chain: an error that no other model fixes ends the chain, an exhausted chain ends it too", async () => {
		const h = rig([{}, {}], { chain: () => [{ model: "m1" }, { model: "m2" }] });
		h.runner(async (call) => errored(`task ${call.index}`, call.index === 0 ? "prompt is too long" : "429 rate limit"));
		const { details } = await h.launch("parallel");
		assert.equal(details.results[0].fallbacks, undefined);
		assert.deepEqual(details.results[1].fallbacks, ["m1 (rate_limit)", "m2 (rate_limit)"]);
		assert.equal(h.started.filter((i) => i === 0).length, 1);
		assert.equal(h.started.filter((i) => i === 1).length, 2);
		assertClean(h);
	});

	it("fallback chain: an abort during the second attempt releases everything", async () => {
		const h = rig([{ writer: true }], { chain: () => [{ model: "m1" }, { model: "m2" }] });
		const abort = new AbortController();
		h.runner((call) => (call.route.model === "m1" ? Promise.resolve(errored("task 0", "overloaded")) : killedOnAbort(call)));
		const launch = h.launch("single", { tolerateAbort: true }, abort.signal);
		await settle();
		assert.equal(h.slots.active, 1);
		abort.abort();
		const { details } = await launch;
		assert.equal(details.results[0].stopReason, "aborted");
		assert.deepEqual(details.results[0].fallbacks, ["m1 (provider_unavailable)"]);
		assertClean(h);
	});
});

describe("runLaunch: a throwing view.start leaks nothing (A6)", () => {
	it("the task that could not start settles, so the running count (derived from launch state) returns to zero", async () => {
		const h = rig([{ writer: true }, {}]);
		h.startError = (i) => (i === 0 ? new Error("stale ctx") : undefined);
		const placeholders = h.placeholders();
		assert.equal(activeTasks([placeholders]), 2, "both tasks are queued, so both count");
		const sibling = manual();
		h.runner(() => sibling.promise);
		const launch = h.launch("parallel", {}, undefined, placeholders);
		const outcome = launch.catch((error: Error) => error);
		await settle();
		// The launch is still waiting for the sibling, but the task that could not start is no longer running.
		assert.equal(activeTasks([placeholders]), 1, "only the sibling is still counted");
		sibling.resolve(reply("task 1", "ok"));
		assert.match(String(await outcome), /stale ctx/);
		assert.deepEqual(h.started, [1], "the sibling still ran");
		assert.equal(activeTasks([placeholders]), 0, "no task is left counted as running");
		assert.ok(placeholders[0].endedAt !== undefined, "the placeholder that never started is settled");
		assert.equal(placeholders[0].stopReason, "error");
		assert.equal(placeholders[0].errorMessage, "stale ctx");
		assert.notEqual(placeholders[0].cancelled, true, "a start failure is not a cancellation");
		assertClean(h);
	});

	it("async mode (abort tolerated) rethrows too and leaves nothing running", async () => {
		const h = rig([{}]);
		h.startError = () => new Error("stale ctx");
		const placeholders = h.placeholders();
		await assert.rejects(h.launch("single", { tolerateAbort: true, async: true }, new AbortController().signal, placeholders), /stale ctx/);
		assert.equal(activeTasks([placeholders]), 0);
		assertClean(h);
	});
});

describe("runLaunch: a rejection waits for every sibling (A3)", () => {
	/** 5 tasks over a cap of 4: task 0 is the writer and runs, tasks 1-3 run, task 4 queues. */
	function fiveTasks(tolerateAbort: boolean) {
		const h = rig([{ writer: true }, {}, {}, {}, {}]);
		const writerTask = manual();
		h.runner((call) => (call.index === 0 ? writerTask.promise : killedOnAbort(call)));
		const abort = new AbortController();
		const log: string[] = [];
		const launch = h.launch("parallel", { tolerateAbort }, abort.signal).then(
			() => log.push("launch resolved"),
			() => log.push("launch rejected"),
		);
		return { h, writerTask, abort, log, launch };
	}

	it("an aborted launch keeps the writer registered until the writer's task settles, and settles only after all tasks", async () => {
		const { h, writerTask, abort, log, launch } = fiveTasks(false);
		await settle();
		assert.deepEqual(h.started, [0, 1, 2, 3]);
		assert.equal(h.slots.waiting, 1);
		abort.abort();
		await settle();
		// The queued task and three children are gone; the writer's child is still running.
		assert.equal(h.active.length, 1, "the writer stays registered");
		assert.equal(h.slots.active, 1, "its slot is still held");
		assert.deepEqual(log, [], "the launch has not settled");
		writerTask.resolve(reply("task 0", "writer done"));
		await launch;
		assert.deepEqual(log, ["launch rejected"]);
		assertClean(h);
	});

	it("async mode (abort tolerated) also settles only after the writer's task", async () => {
		const { h, writerTask, abort, log, launch } = fiveTasks(true);
		await settle();
		abort.abort();
		await settle();
		assert.equal(h.active.length, 1);
		assert.deepEqual(log, []);
		writerTask.reject(new Error("Subagent was aborted"));
		await launch;
		assert.deepEqual(log, ["launch resolved"]);
		assertClean(h);
	});

	it("one task throwing does not release the sibling writer's registration", async () => {
		const h = rig([{ writer: true }, {}]);
		const writerTask = manual();
		h.runner((call) => (call.index === 0 ? writerTask.promise : Promise.reject(new Error("scout crashed"))));
		const log: string[] = [];
		const launch = h.launch("parallel").catch((error: Error) => log.push(`rejected: ${error.message}`));
		await settle();
		assert.equal(h.active.length, 1);
		assert.deepEqual(log, []);
		writerTask.resolve(reply("task 0", "ok"));
		await launch;
		assert.deepEqual(log, ["rejected: scout crashed"]);
		assertClean(h);
	});

	it("a queued task keeps its place: after a sibling throws it still runs before the launch settles", async () => {
		const h = rig([{}, {}], { limit: 1 });
		h.runner(async (call) => {
			if (call.index === 0) throw new Error("first crashed");
			return reply("task 1", "second ran");
		});
		await assert.rejects(h.launch("parallel"), /first crashed/);
		assert.deepEqual(h.started, [0, 1]);
		assertClean(h);
	});
});

const WARNING = "files changed outside the writers' allowed edit surfaces";
const before = new Map([["src/w0/a.ts", "1"]]);

describe("runLaunch: the async writer backstop ignores other writers' surfaces (A1)", () => {
	const other: ActiveWriter = { id: "o1", agent: "builder", surfaces: ["docs/**"] };

	it("a writer already active when the launch starts is excluded", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["docs/guide.md", "x"], ["README.md", "y"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		h.registerOther(other);
		const launched = await h.launch("single", { async: true, tolerateAbort: true });
		assert.deepEqual(launched.details.outsideSurfaces, ["README.md"]);
		h.unregisterOther(other);
		assertClean(h);
	});

	it("a writer that registers during the launch, even if it is gone before the end, is excluded", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["docs/guide.md", "x"], ["README.md", "y"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		const run = manual();
		h.runner(() => run.promise);
		const launch = h.launch("single", { async: true, tolerateAbort: true });
		await settle();
		h.registerOther(other);
		h.unregisterOther(other);
		run.resolve(reply("task 0", "done"));
		assert.deepEqual((await launch).details.outsideSurfaces, ["README.md"]);
		assertClean(h);
	});

	it("the launch's own surfaces and unrelated files are still handled as before", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["src/other/b.ts", "x"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		h.registerOther(other);
		const launched = await h.launch("single", { async: true, tolerateAbort: true });
		assert.deepEqual(launched.details.outsideSurfaces, ["src/other/b.ts"]);
		h.unregisterOther(other);
		assertClean(h);
	});

	it("a writer registered after the launch settled does not affect it", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["docs/guide.md", "x"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		const launched = await h.launch("single", { async: true, tolerateAbort: true });
		h.registerOther(other);
		assert.deepEqual(launched.details.outsideSurfaces, ["docs/guide.md"]);
		h.unregisterOther(other);
	});

	it("the async warning says the list may include edits the parent made meanwhile", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["README.md", "y"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		const launched = await h.launch("single", { async: true, tolerateAbort: true });
		assert.deepEqual(launched.warnings, [`${WARNING} (may include edits the parent made meanwhile): README.md`]);
		assert.equal(toResult("single", launched).content[0].text, `answer 0\n\nWarnings: ${WARNING} (may include edits the parent made meanwhile): README.md`);
	});

	it("sync mode is unchanged: other writers' files are still reported, with the original wording", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["docs/guide.md", "x"], ["README.md", "y"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		h.registerOther(other);
		const launched = await h.launch("single");
		assert.deepEqual(launched.details.outsideSurfaces, ["README.md", "docs/guide.md"]);
		assert.deepEqual(launched.warnings, [`${WARNING}: README.md, docs/guide.md`]);
		h.unregisterOther(other);
	});
});

describe("toResult: a task cancelled while queued (A5)", () => {
	const cancelled = (agent: string): RunResult => ({ agent, task: "t", exitCode: -1, messages: [], stderr: "", usage: emptyTally(), queued: true, cancelled: true, endedAt: 5 });

	it("parallel: counts as failed and renders as cancelled, not completed", () => {
		const done = reply("t", "answer");
		const result = toResult("parallel", { details: { mode: "parallel", results: [done, cancelled("builder")] }, warnings: [] });
		assert.equal(result.content[0].text, "Parallel: 1/2 succeeded\n\n### [scout] completed\n\nanswer\n\n---\n\n### [builder] cancelled\n\nCancelled before it started.");
	});

	it("single: reads as a cancelled error", () => {
		const result = toResult("single", { details: { mode: "single", results: [cancelled("builder")] }, warnings: [] });
		assert.equal(result.content[0].text, "Agent cancelled: Cancelled before it started.");
		assert.equal(result.isError, true);
	});

	it("end to end: an async launch aborted while a task is queued", async () => {
		const h = rig([{}, { writer: true }], { limit: 1 });
		h.runner(killedOnAbort);
		const abort = new AbortController();
		const launch = h.launch("parallel", { async: true, tolerateAbort: true }, abort.signal);
		await settle();
		abort.abort();
		const text = toResult("parallel", await launch).content[0].text;
		assert.equal(text, "Parallel: 0/2 succeeded\n\n### [scout] failed\n\nSubagent was aborted\n\n---\n\n### [builder] cancelled\n\nCancelled before it started.");
	});

	it("sync text is unchanged: a placeholder-free result still says completed/failed", async () => {
		const h = rig([{}, {}]);
		h.runner(async (call) => (call.index === 1 ? errored("task 1", "no luck") : reply("task 0", "fine")));
		const text = toResult("parallel", await h.launch("parallel")).content[0].text;
		assert.equal(text, "Parallel: 1/2 succeeded\n\n### [scout] completed\n\nfine\n\n---\n\n### [scout] failed\n\nno luck");
	});
});

describe("toResult: the sync content text", () => {
	it("single success is the child's final text", async () => {
		const h = rig([{}]);
		h.runner(async () => reply("task 0", "the answer"));
		const result = toResult("single", await h.launch("single"));
		assert.deepEqual(result.content, [{ type: "text", text: "the answer" }]);
		assert.equal(result.isError, false);
	});

	it("single failure starts with `Agent <stopReason>:`", async () => {
		const h = rig([{}]);
		h.runner(async () => errored("task 0", "boom"));
		const result = toResult("single", await h.launch("single"));
		assert.equal(result.content[0].text, "Agent error: boom");
		assert.equal(result.isError, true);
	});

	it("single failure without a stop reason says `Agent failed:` and uses stderr", async () => {
		const h = rig([{}]);
		h.runner(async () => reply("task 0", "", { exitCode: 3, stderr: "exploded\n", stopReason: undefined, messages: [] }));
		assert.equal(toResult("single", await h.launch("single")).content[0].text, "Agent failed: exploded");
	});

	it("parallel: a summary line and one `### [agent] completed|failed` section per task", async () => {
		const h = rig([{}, {}, { writer: true }]);
		h.runner(async (call) => (call.index === 1 ? errored("task 1", "no luck") : reply(`task ${call.index}`, `answer ${call.index}`)));
		const result = toResult("parallel", await h.launch("parallel"));
		const sections = ["### [scout] completed\n\nanswer 0", "### [scout] failed\n\nno luck", "### [builder] completed\n\nanswer 2"];
		assert.equal(result.content[0].text, `Parallel: 2/3 succeeded\n\n${sections.join("\n\n---\n\n")}`);
		assert.equal(result.isError, undefined);
	});

	it("appends warnings: unknown skills", async () => {
		const h = rig([{ skills: ["nope"] }]);
		const launched = await h.launch("single");
		assert.deepEqual(launched.warnings, ["scout: unknown skills nope"]);
		assert.equal(toResult("single", launched).content[0].text, "answer 0\n\nWarnings: scout: unknown skills nope");
		assert.ok(toResult("parallel", launched).content[0].text.endsWith("\n\nWarnings: scout: unknown skills nope"));
	});

	it("appends warnings: files changed outside the writers' surfaces", async () => {
		const before = new Map([["src/w0/a.ts", "1"]]);
		const after = new Map([["src/w0/a.ts", "2"], ["README.md", "x"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		const launched = await h.launch("single");
		assert.deepEqual(launched.details.outsideSurfaces, ["README.md"]);
		assert.equal(toResult("single", launched).content[0].text, "answer 0\n\nWarnings: files changed outside the writers' allowed edit surfaces: README.md");
		assertClean(h);
	});

	it("streams progress: `done/total` for parallel, the child's text for single", async () => {
		const h = rig([{}, {}]);
		const texts: string[] = [];
		const progress: string[] = [];
		await h.launch("parallel", { onUpdate: (r) => void texts.push(r.content[0].text), onProgress: (d, t) => void progress.push(`${d}/${t}`) });
		assert.ok(texts.includes("2/2 done"));
		assert.equal(progress.at(-1), "2/2");
	});
});
