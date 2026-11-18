import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../lib/child-run.ts";
import { emptyTally } from "../lib/cost.ts";
import type { ActiveWriter } from "../lib/delegation.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { activeTasks } from "../lib/subagent-status.ts";
import { limitFailed, runLaunch, toResult, type AgentCall, type LaunchHooks, type LaunchTask } from "../lib/subagent-launch.ts";

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

function rig(specs: Spec[], options: { limit?: number; snapshots?: Array<Map<string, string> | undefined> } = {}) {
	const slots = createSemaphore(options.limit ?? 4);
	const active: ActiveWriter[] = [];
	const events: string[] = [];
	const started: number[] = [];
	const labels: string[] = [];
	const snapshots = [...(options.snapshots ?? [])];
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
		labels,
		tasks,
		/** Fresh placeholders, as the extension builds them. */
		placeholders: results,
		/** Makes `view.start` throw for the given task (a stale context after /reload). */
		startError: undefined as ((index: number) => Error | undefined) | undefined,
		/** Makes `view.finish` / the snapshot throw. */
		finishError: undefined as Error | undefined,
		snapshotError: undefined as Error | undefined,
		runner: (fn: typeof run) => void (run = fn),
		/** Another launch's writer registers (as the extension's shared list would report it). */
		registerOther: (writer: ActiveWriter) => void active.push(writer),
		unregisterOther: (writer: ActiveWriter) => void active.splice(active.indexOf(writer), 1),
		launch(mode: "single" | "parallel", hooks: LaunchHooks = {}, signal?: AbortSignal, placeholders = results()) {
			return runLaunch(
				{ mode, tasks, results: placeholders, signal, hooks },
				{
					slots,
					runAgent: async (call) => {
						started.push(call.index);
						labels.push(call.routeLabel);
						const result = await run(call);
						// What the real runner stamps on every run.
						return Object.assign(result, { agent: tasks[call.index].agent.name, model: call.route.model, thinking: call.route.thinking });
					},
					skills: () => [],
					writers: {
						add: (ws) => void active.push(...ws),
						remove: (w) => void (active.includes(w) && active.splice(active.indexOf(w), 1)),
					},
					view: {
						start: (i) => {
							events.push(`start:${i}`);
							const error = h.startError?.(i);
							if (error) throw error;
						},
						attempt: (i) => void events.push(`attempt:${i}`),
						update: (i) => void events.push(`update:${i}`),
						finish: (i) => {
							events.push(`finish:${i}`);
							if (h.finishError) throw h.finishError;
						},
					},
					snapshot: async () => {
						if (h.snapshotError) throw h.snapshotError;
						return snapshots.shift();
					},
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
		assert.deepEqual(h.labels, ["definition"], "one run per task: no fallback chain");
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

	it("abort while running: the launch throws and nothing is left held", async () => {
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

	it("abort while queued: throws, the queued task never starts, and its writer is unregistered", async () => {
		const h = rig([{}, { writer: true }], { limit: 1 });
		h.runner(killedOnAbort);
		const abort = new AbortController();
		const placeholders = h.placeholders();
		const launch = h.launch("parallel", {}, abort.signal, placeholders);
		await settle();
		assert.equal(h.slots.waiting, 1);
		assert.deepEqual(h.active.map((w) => w.agent), ["builder"], "the queued writer is already registered");
		abort.abort();
		await assert.rejects(launch, /Subagent was aborted/);
		assert.deepEqual(h.started, [0]);
		assert.equal(placeholders[1].cancelled, true, "the viewer shows it as cancelled");
		assertClean(h);
	});

	it("an already-aborted signal starts nothing", async () => {
		const h = rig([{ writer: true }]);
		const abort = new AbortController();
		abort.abort();
		await assert.rejects(h.launch("single", {}, abort.signal), /Subagent was aborted/);
		assert.deepEqual(h.started, []);
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
});

describe("runLaunch: one model per agent; a quota or limit failure is reported loudly", () => {
	it("a rate-limited child is not retried, and the result names the failure", async () => {
		const h = rig([{}]);
		h.runner(async () => errored("task 0", "429 rate limit"));
		const launched = await h.launch("single");
		assert.deepEqual(h.started, [0], "no second run on another model");
		assert.equal(launched.warnings.length, 1);
		assert.match(launched.warnings[0], /^scout: m1 hit a quota or rate limit\. No other model was tried/);
		const text = toResult("single", launched).content[0].text;
		assert.match(text, /^Agent error: 429 rate limit\n\nWarnings: scout: m1 hit a quota or rate limit/);
		assert.equal(toResult("single", launched).isError, true);
		assertClean(h);
	});

	it("quota wording is recognised; an ordinary failure, a limit-less error and a success are not", () => {
		const base = { exitCode: 0, stderr: "" };
		assert.equal(limitFailed({ ...base, stopReason: "error", errorMessage: "You exceeded your current quota" }), true);
		assert.equal(limitFailed({ ...base, stopReason: "error", errorMessage: "usage limit reached" }), true);
		assert.equal(limitFailed({ ...base, stopReason: "error", errorMessage: "prompt is too long" }), false);
		assert.equal(limitFailed({ ...base, stopReason: "aborted", errorMessage: "rate limit" }), false);
		assert.equal(limitFailed({ ...base, stopReason: "stop", errorMessage: "rate limit" }), false);
	});
});

describe("runLaunch: a throwing view.start leaks nothing", () => {
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
});

describe("runLaunch: a failing hook or snapshot leaks nothing", () => {
	it("a snapshot that throws before any slot rejects, with the writer unregistered and no slot held", async () => {
		const h = rig([{ writer: true }]);
		h.snapshotError = new Error("git exploded");
		await assert.rejects(h.launch("single"), /git exploded/);
		assertClean(h);
	});

	it("a view.finish that throws still releases the slot and the writer", async () => {
		const h = rig([{ writer: true }]);
		h.finishError = new Error("finish boom");
		await assert.rejects(h.launch("single"), /finish boom/);
		assertClean(h);
	});
});

describe("runLaunch: a rejection waits for every sibling", () => {
	it("an aborted launch keeps the writer registered until the writer's task settles, and settles only after all tasks", async () => {
		// 5 tasks over a cap of 4: task 0 is the writer and runs, tasks 1-3 run, task 4 queues.
		const h = rig([{ writer: true }, {}, {}, {}, {}]);
		const writerTask = manual();
		h.runner((call) => (call.index === 0 ? writerTask.promise : killedOnAbort(call)));
		const abort = new AbortController();
		const log: string[] = [];
		const launch = h.launch("parallel", {}, abort.signal).then(
			() => log.push("launch resolved"),
			() => log.push("launch rejected"),
		);
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

describe("runLaunch: the writer backstop", () => {
	const other: ActiveWriter = { id: "o1", agent: "builder", surfaces: ["docs/**"] };

	it("reports files outside the writers' surfaces, other launches' writers' files included", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["docs/guide.md", "x"], ["README.md", "y"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		h.registerOther(other);
		const launched = await h.launch("single");
		assert.deepEqual(launched.details.outsideSurfaces, ["README.md", "docs/guide.md"]);
		assert.deepEqual(launched.warnings, [`${WARNING}: README.md, docs/guide.md`]);
		h.unregisterOther(other);
	});

	it("the launch's own surfaces are not reported", async () => {
		const after = new Map([["src/w0/a.ts", "2"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		const launched = await h.launch("single");
		assert.deepEqual(launched.details.outsideSurfaces, []);
		assert.deepEqual(launched.warnings, []);
		assertClean(h);
	});

	it("appears in the text the model reads", async () => {
		const after = new Map([["src/w0/a.ts", "2"], ["README.md", "x"]]);
		const h = rig([{ writer: true }], { snapshots: [before, after] });
		const launched = await h.launch("single");
		assert.equal(toResult("single", launched).content[0].text, `answer 0\n\nWarnings: ${WARNING}: README.md`);
		assertClean(h);
	});
});

describe("toResult: a task cancelled while queued", () => {
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
});

describe("toResult: the content text", () => {
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

	it("streams progress: `done/total` for parallel, the child's text for single", async () => {
		const h = rig([{}, {}]);
		const texts: string[] = [];
		await h.launch("parallel", { onUpdate: (r) => void texts.push(r.content[0].text) });
		assert.ok(texts.includes("2/2 done"));
	});
});
