// S5: cancelling one task of a launch. A fake runAgent stands in for runChild: it settles when its signal aborts,
// the way a killed child does (a user cancel resolves the run, a launch abort rejects it).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptyTally } from "../lib/cost.ts";
import type { ActiveWriter } from "../lib/delegation.ts";
import { runStatus, USER_CANCEL, type RunResult } from "../lib/run-status.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { runLaunch, toResult, type AgentCall, type LaunchTask } from "../lib/subagent-launch.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const settle = async () => {
	for (let i = 0; i < 5; i++) await tick();
};

const reply = (index: number, text: string, over: Partial<RunResult> = {}): RunResult => ({
	agent: "scout",
	task: `task ${index}`,
	exitCode: 0,
	messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as any],
	stderr: "",
	usage: emptyTally(),
	stopReason: "stop",
	...over,
});

/** A killed child: a user cancel ends the run with what it had (as runChild does); any other abort rejects. */
const killedOnAbort = (call: AgentCall, { rejectOnCancel = false } = {}) =>
	new Promise<RunResult>((resolve, reject) => {
		const kill = () => {
			if (call.signal?.reason === USER_CANCEL && !rejectOnCancel) resolve(reply(call.index, "", { exitCode: 0, stopReason: "aborted", messages: [], cancelled: true }));
			else reject(new Error("Subagent was aborted"));
		};
		if (call.signal?.aborted) kill();
		else call.signal?.addEventListener("abort", kill, { once: true });
	});

const manual = () => {
	let resolve!: (r: RunResult) => void;
	const promise = new Promise<RunResult>((res) => (resolve = res));
	return { promise, resolve };
};

function rig(specs: Array<{ writer?: boolean }>, options: { limit?: number } = {}) {
	const slots = createSemaphore(options.limit ?? 4);
	const active: ActiveWriter[] = [];
	const started: number[] = [];
	const skipped: number[] = [];
	const finished: number[] = [];
	let cancel!: (index: number) => boolean;
	let run: (call: AgentCall) => Promise<RunResult> = async (call) => reply(call.index, `answer ${call.index}`);
	const tasks: LaunchTask[] = specs.map((spec, i) => ({
		request: { agent: "scout", task: `task ${i}`, reason: "Independent units", allowedEditSurfaces: spec.writer ? [`src/w${i}/**`] : undefined },
		agent: { name: "scout", description: "d", writer: Boolean(spec.writer), systemPrompt: "", source: "package", filePath: "/a.md" },
		route: { model: "m1", modelSource: "definition", thinkingSource: "definition" },
		routeLabel: "definition",
	}));
	const placeholders = (): RunResult[] => tasks.map((_, i) => ({ agent: "scout", task: `task ${i}`, exitCode: -1, messages: [], stderr: "", usage: emptyTally(), queued: true }));
	return {
		slots,
		active,
		started,
		skipped,
		finished,
		runner: (fn: typeof run) => void (run = fn),
		cancel: (index: number) => cancel(index),
		launch(signal?: AbortSignal, results = placeholders()) {
			return {
				results,
				done: runLaunch(
					{ mode: "parallel", tasks, results, signal, hooks: {}, exposeCancel: (fn) => void (cancel = fn) },
					{
						slots,
						runAgent: async (call) => {
							started.push(call.index);
							return run(call);
						},
						skills: () => [],
						writers: { add: (ws) => void active.push(...ws), remove: (w) => void (active.includes(w) && active.splice(active.indexOf(w), 1)) },
						view: {
							start: () => {},
							attempt: () => {},
							update: () => {},
							finish: (i) => void finished.push(i),
							skipped: (i) => void skipped.push(i),
						},
						snapshot: async () => undefined,
					},
				),
			};
		},
	};
}

const assertClean = (h: ReturnType<typeof rig>) => {
	assert.equal(h.slots.active, 0, "every slot is released");
	assert.equal(h.slots.waiting, 0, "no acquire is left waiting");
	assert.deepEqual(h.active, [], "every writer is unregistered");
};

describe("runLaunch: cancel one task", () => {
	it("a queued task never starts and settles as cancelled; the launch and its sibling are fine", async () => {
		const h = rig([{}, {}], { limit: 1 });
		const first = manual();
		h.runner((call) => first.promise.then((r) => Object.assign(r, { task: `task ${call.index}` })));
		const { results, done } = h.launch();
		await settle();
		assert.deepEqual(h.started, [0], "the second task waits for the only slot");
		assert.equal(h.cancel(1), true);
		await settle();
		assert.equal(runStatus(results[1]), "cancelled");
		assert.deepEqual(h.skipped, [1], "the view hears of a task that settled without starting");
		first.resolve(reply(0, "answer 0"));
		const launched = await done;
		assert.deepEqual(h.started, [0], "the cancelled task never started");
		assert.equal(runStatus(launched.details.results[0]), "done");
		assert.equal(runStatus(launched.details.results[1]), "cancelled");
		assert.equal(results[1].endedAt !== undefined, true);
		assert.match(toResult("parallel", launched).content[0].text, /### \[scout\] cancelled\n\nCancelled by the user before it started\./);
		assertClean(h);
	});

	it("a cancel that lands after the child finished keeps its result: the runner, not the request, decides", async () => {
		// The child already exited and its run is draining (close, artifacts): the abort reaches nothing and runChild
		// resolves a normal result, without the cancelled flag.
		const h = rig([{}]);
		const draining = manual();
		h.runner(() => draining.promise);
		const { results, done } = h.launch();
		await settle();
		assert.equal(h.cancel(0), true, "the request is accepted while the run is still open");
		draining.resolve(reply(0, "answer 0"));
		const launched = await done;
		assert.equal(runStatus(results[0]), "done");
		assert.match(toResult("parallel", launched).content[0].text, /### \[scout\] completed\n\nanswer 0/);
		assertClean(h);
	});

	it("a running task is killed through its signal and settles as cancelled while the sibling completes", async () => {
		const h = rig([{}, {}]);
		const sibling = manual();
		const signals: Array<AbortSignal | undefined> = [];
		h.runner((call) => {
			signals[call.index] = call.signal;
			return call.index === 0 ? killedOnAbort(call) : sibling.promise;
		});
		const { results, done } = h.launch();
		await settle();
		assert.equal(h.cancel(0), true);
		await settle();
		assert.equal(signals[0]?.aborted, true, "the child's signal aborted");
		assert.equal(signals[1]?.aborted, false, "the sibling is untouched");
		assert.equal(runStatus(results[0]), "cancelled");
		sibling.resolve(reply(1, "answer 1"));
		const launched = await done;
		assert.deepEqual(launched.details.results.map(runStatus), ["cancelled", "done"]);
		const text = toResult("parallel", launched).content[0].text;
		assert.match(text, /^Parallel: 1\/2 succeeded/);
		assert.match(text, /### \[scout\] cancelled\n\nCancelled by the user\./);
		assert.match(text, /answer 1/);
		assert.deepEqual(h.finished.sort(), [0, 1]);
		assertClean(h);
	});

	it("a child that rejects on the user's cancel still settles as cancelled, without failing the launch", async () => {
		const h = rig([{}]);
		h.runner((call) => killedOnAbort(call, { rejectOnCancel: true }));
		const { done } = h.launch();
		await settle();
		assert.equal(h.cancel(0), true);
		const launched = await done;
		assert.equal(runStatus(launched.details.results[0]), "cancelled");
		const single = toResult("single", launched);
		assert.equal(single.isError, true);
		assert.equal(single.content[0].text, "Agent cancelled: Cancelled by the user.");
		assertClean(h);
	});

	it("aborting the whole launch still throws", async () => {
		const h = rig([{}, {}]);
		h.runner((call) => killedOnAbort(call));
		const controller = new AbortController();
		const { done } = h.launch(controller.signal);
		await settle();
		controller.abort();
		await assert.rejects(done, /Subagent was aborted/);
		assertClean(h);
	});

	it("an abort of the launch after one task was cancelled still throws for the running sibling", async () => {
		const h = rig([{}, {}]);
		h.runner((call) => killedOnAbort(call));
		const controller = new AbortController();
		const { done } = h.launch(controller.signal);
		await settle();
		h.cancel(0);
		await settle();
		controller.abort();
		await assert.rejects(done, /Subagent was aborted/);
		assertClean(h);
	});

	it("an unknown or settled task is ignored", async () => {
		const h = rig([{}, {}]);
		h.runner(async (call) => reply(call.index, `answer ${call.index}`));
		const { results, done } = h.launch();
		const launched = await done;
		assert.equal(h.cancel(0), false, "settled");
		assert.equal(h.cancel(7), false, "unknown");
		assert.equal(h.cancel(-1), false, "unknown");
		assert.deepEqual(launched.details.results.map(runStatus), ["done", "done"]);
		assert.notEqual(results[0].cancelled, true);
		assertClean(h);
	});

	it("a cancel racing a task that just finished does not rewrite its outcome", async () => {
		const h = rig([{}, {}]);
		const slow = manual();
		h.runner((call) => (call.index === 0 ? Promise.resolve(reply(0, "answer 0")) : slow.promise));
		const { done } = h.launch();
		await settle();
		assert.equal(h.cancel(0), false);
		slow.resolve(reply(1, "answer 1"));
		const launched = await done;
		assert.deepEqual(launched.details.results.map(runStatus), ["done", "done"]);
	});

	it("writers and slots are released when a writer is cancelled while running or queued", async () => {
		const h = rig([{ writer: true }, { writer: true }], { limit: 1 });
		h.runner((call) => killedOnAbort(call));
		const { done } = h.launch();
		await settle();
		assert.equal(h.active.length, 2, "both writers are registered, one is still queued");
		assert.equal(h.slots.active, 1);
		assert.equal(h.cancel(1), true, "the queued writer");
		await settle();
		assert.equal(h.active.length, 1, "its surface is free at once");
		assert.equal(h.cancel(0), true, "the running writer");
		const launched = await done;
		assert.deepEqual(launched.details.results.map(runStatus), ["cancelled", "cancelled"]);
		assertClean(h);
	});
});

describe("runStatus: a started task the user stopped", () => {
	it("maps to cancelled once it has a real exit code, whatever its stop reason", () => {
		assert.equal(runStatus({ exitCode: 0, stopReason: "aborted", cancelled: true }), "cancelled");
		assert.equal(runStatus({ exitCode: 143, cancelled: true }), "cancelled");
		assert.equal(runStatus({ exitCode: -1, cancelled: true, endedAt: 5 }), "cancelled");
	});

	it("keeps every other status", () => {
		assert.equal(runStatus({ exitCode: -1, cancelled: true }), "running", "not settled yet");
		assert.equal(runStatus({ exitCode: 0, stopReason: "aborted" }), "failed", "aborted without a user cancel is a failure");
		assert.equal(runStatus({ exitCode: 0, stopReason: "stop" }), "done");
	});
});
