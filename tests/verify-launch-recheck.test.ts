import assert from "node:assert/strict";
import { it } from "node:test";
import { emptyTally } from "../lib/cost.ts";
import { writerConflicts, type ActiveWriter } from "../lib/delegation.ts";
import { createSemaphore } from "../lib/semaphore.ts";
import { runLaunch, toResult, type AgentCall, type LaunchTask } from "../lib/subagent-launch.ts";
import { createSubagentRegistry } from "../lib/subagent-registry.ts";

const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => {
	for (let i = 0; i < 10; i++) await tick();
};
const reply = (text: string) => ({ agent: "x", task: "t", exitCode: 0, messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" } as any], stderr: "", usage: emptyTally(), stopReason: "stop" });
const killedOnAbort = (call: AgentCall) =>
	new Promise<any>((_, rej) => {
		const k = () => rej(new Error("Subagent was aborted"));
		if (call.signal?.aborted) k();
		else call.signal?.addEventListener("abort", k, { once: true });
	});
const builder = { name: "builder", description: "d", writer: true, systemPrompt: "", source: "package", filePath: "/b.md" } as any;
const scout = { name: "scout", description: "d", writer: false, systemPrompt: "", source: "package", filePath: "/s.md" } as any;
const timers = { setTimer: (f: () => void, ms: number) => setTimeout(f, ms), clearTimer: (x: unknown) => clearTimeout(x as NodeJS.Timeout) };

function rig(agents: any[], over: any = {}) {
	const slots = createSemaphore(4);
	const active: ActiveWriter[] = [];
	const tasks: LaunchTask[] = agents.map((agent, i) => ({ request: { agent: agent.name, task: `task ${i}`, reason: "r", allowedEditSurfaces: agent.writer ? ["src/a/**"] : undefined }, agent, route: { model: "m1", modelSource: "definition", thinkingSource: "definition" } as any, routeLabel: "definition" }));
	const results = tasks.map((t) => ({ agent: t.agent.name, task: t.request.task, exitCode: -1, messages: [], stderr: "", usage: emptyTally(), queued: true }) as any);
	const deps: any = {
		slots,
		runAgent: over.runAgent,
		skills: () => [],
		chain: () => [{ model: "m1" }],
		coolModel: () => {},
		fallbackNotice: () => {},
		writers: {
			add: (ws: ActiveWriter[]) => void active.push(...ws),
			remove: (w: ActiveWriter) => {
				const at = active.indexOf(w);
				if (at >= 0) active.splice(at, 1);
			},
		},
		view: { start: over.start ?? (() => {}), attempt: () => {}, update: () => {}, finish: over.finish ?? (() => {}) },
		snapshot: over.snapshot ?? (async () => undefined),
	};
	return { slots, active, tasks, results, deps };
}
const overlapping = (active: ActiveWriter[]) => writerConflicts([{ agent: builder, surfaces: ["src/a/x.ts"] }], active);

for (const tolerateAbort of [false, true]) {
	it(`A3: 5 tasks over cap 4, abort; the writer blocks overlapping admission until its own task ends (tolerateAbort=${tolerateAbort})`, async () => {
		let finishWriter!: (r: any) => void;
		const gate = new Promise<any>((r) => (finishWriter = r));
		const h = rig([builder, scout, scout, scout, scout], { runAgent: (c: AgentCall) => (c.index === 0 ? gate : killedOnAbort(c)) });
		const abort = new AbortController();
		const log: string[] = [];
		const launch = runLaunch({ mode: "parallel", tasks: h.tasks, results: h.results, signal: abort.signal, hooks: { tolerateAbort } }, h.deps).then(
			() => log.push("resolved"),
			(e: Error) => log.push(`rejected:${e.message}`),
		);
		await settle();
		assert.equal(h.slots.active, 4);
		assert.equal(h.slots.waiting, 1);
		abort.abort();
		await settle();
		assert.equal(h.active.length, 1);
		assert.equal(h.slots.active, 1);
		assert.deepEqual(log, []);
		assert.equal(overlapping(h.active).length, 1, "overlapping writer refused while the writer still runs");
		finishWriter(reply("w"));
		await launch;
		assert.deepEqual(log, [tolerateAbort ? "resolved" : "rejected:Subagent was aborted"]);
		assert.deepEqual(h.active, []);
		assert.equal(h.slots.active, 0);
		assert.equal(h.slots.waiting, 0);
		assert.deepEqual(overlapping(h.active), []);
	});
}

it("A3 through the registry: cancel resolves only after the writer's task ends", async () => {
	let finishWriter!: (r: any) => void;
	const gate = new Promise<any>((r) => (finishWriter = r));
	const h = rig([builder, scout, scout, scout, scout], { runAgent: (c: AgentCall) => (c.index === 0 ? gate : killedOnAbort(c)) });
	const reg = createSubagentRegistry<any>({ ...timers, newId: () => "L1" });
	const id = reg.start({ total: 5, run: async (sig) => toResult("parallel", await runLaunch({ mode: "parallel", tasks: h.tasks, results: h.results, signal: sig, hooks: { tolerateAbort: true } }, h.deps)) });
	assert.equal(h.active.length, 1, "registered synchronously inside start");
	await settle();
	let cancelled = false;
	const c = reg.cancel(id).then((o) => ((cancelled = true), o));
	await settle();
	assert.equal(cancelled, false);
	assert.equal(overlapping(h.active).length, 1);
	finishWriter(reply("w"));
	assert.equal((await c).status, "settled");
	assert.deepEqual(h.active, []);
});

it("snapshot throwing before any slot: rejects, writer unregistered, no slot held", async () => {
	const h = rig([builder], {
		runAgent: async () => reply("x"),
		snapshot: async () => {
			throw new Error("git exploded");
		},
	});
	await assert.rejects(runLaunch({ mode: "single", tasks: h.tasks, results: h.results, hooks: { tolerateAbort: false } }, h.deps), /git exploded/);
	assert.deepEqual(h.active, []);
	assert.equal(h.slots.active, 0);
});

it("view.start throwing: slot and writer released, launch waits for the sibling", async () => {
	let finishSib!: (r: any) => void;
	const gate = new Promise<any>((r) => (finishSib = r));
	const h = rig([builder, builder], {
		runAgent: () => gate,
		start: (i: number) => {
			if (i === 0) throw new Error("stale ctx");
		},
	});
	h.tasks[1].request.allowedEditSurfaces = ["src/b/**"];
	const log: string[] = [];
	const p = runLaunch({ mode: "parallel", tasks: h.tasks, results: h.results, hooks: { tolerateAbort: false } }, h.deps).catch((e: Error) => log.push(e.message));
	await settle();
	assert.deepEqual(h.active.map((w) => w.surfaces[0]), ["src/b/**"]);
	assert.deepEqual(log, []);
	finishSib(reply("ok"));
	await p;
	assert.deepEqual(log, ["stale ctx"]);
	assert.deepEqual(h.active, []);
	assert.equal(h.slots.active, 0);
});

it("view.finish throwing: slot and writer released", async () => {
	const h = rig([builder], {
		runAgent: async () => reply("x"),
		finish: () => {
			throw new Error("finish boom");
		},
	});
	await assert.rejects(runLaunch({ mode: "single", tasks: h.tasks, results: h.results, hooks: { tolerateAbort: true } }, h.deps), /finish boom/);
	assert.deepEqual(h.active, []);
	assert.equal(h.slots.active, 0);
});

it("async: a non-abort error is recorded as the launch error after siblings end", async () => {
	const h = rig([scout, builder], {
		runAgent: async (c: AgentCall) => {
			if (c.index === 0) throw new Error("ENOMEM");
			return reply("ok");
		},
	});
	const reg = createSubagentRegistry<any>({ ...timers, newId: () => "L2" });
	const id = reg.start({ total: 2, run: async (sig) => toResult("parallel", await runLaunch({ mode: "parallel", tasks: h.tasks, results: h.results, signal: sig, hooks: { tolerateAbort: true } }, h.deps)) });
	const o: any = await reg.wait(id, 1000);
	assert.equal(o.error, "ENOMEM");
	assert.deepEqual(h.active, []);
	assert.equal(h.slots.active, 0);
});

it("A4: start precedes synchronous progress; a synchronously throwing body settles with its error", async () => {
	const reg = createSubagentRegistry<any>({ ...timers, newId: () => "L3" });
	const ev: string[] = [];
	reg.subscribe((e) => ev.push(e.type));
	let ran = false;
	const id = reg.start({
		total: 2,
		run: (_s, c) => {
			ran = true;
			c.progress(1, 2);
			return Promise.resolve("r");
		},
	});
	assert.equal(ran, true);
	assert.deepEqual(ev, ["start", "progress"]);
	await reg.wait(id, 100);
	assert.deepEqual(ev, ["start", "progress", "settle"]);
	const id2 = reg.start({
		total: 1,
		run: () => {
			throw new Error("sync boom");
		},
	});
	assert.equal(((await reg.wait(id2, 100)) as any).error, "sync boom");
});
