import assert from "node:assert/strict";
import { it } from "node:test";
import { createSemaphore } from "../lib/semaphore.ts";
import { activeTasks } from "../lib/subagent-status.ts";
import { runLaunch, toResult } from "../lib/subagent-launch.ts";

// Verifier T9 (A1 per L6 "Exclude other writers' surfaces + honest wording", A5): async result text.

const tally = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 }) as any;
const result = (over: any = {}) => ({ agent: "scout", task: "t", exitCode: 0, messages: [], stderr: "", usage: tally(), ...over });
const answer = (text: string) => result({ messages: [{ role: "assistant", content: [{ type: "text", text }], stopReason: "stop" }] });
const placeholders = (n: number) => Array.from({ length: n }, () => result({ agent: "b", exitCode: -1, queued: true }));
const task = (writer: boolean, surfaces?: string[]) => ({
	request: { agent: "b", task: "t", reason: "r", allowedEditSurfaces: surfaces },
	agent: { name: "b", description: "d", writer, systemPrompt: "", source: "package", filePath: "/a.md" },
	route: { model: "m1", modelSource: "definition", thinkingSource: "definition" },
	routeLabel: "definition",
});
function deps(active: any[], snapshots: Array<Map<string, string>>, runAgent: () => Promise<any>) {
	const listeners = new Set<(ws: any[]) => void>();
	let i = 0;
	return {
		listeners,
		deps: {
			slots: createSemaphore(4),
			runAgent,
			skills: () => [],
			chain: () => [{ model: "m1" }],
			coolModel: () => {},
			fallbackNotice: () => {},
			writers: {
				add: (ws: any[]) => (active.push(...ws), listeners.forEach((l) => l(ws))),
				remove: (w: any) => void (active.includes(w) && active.splice(active.indexOf(w), 1)),
				list: () => [...active],
				onAdd: (l: any) => (listeners.add(l), () => void listeners.delete(l)),
			},
			view: { start() {}, attempt() {}, update() {}, finish() {} },
			snapshot: async () => snapshots.shift(),
			newWriterId: () => `w${i++}`,
		} as any,
	};
}
const before = new Map([["src/mine/x", "1"], ["other/y", "1"], ["parent/z", "1"]]);
const after = new Map([["src/mine/x", "2"], ["other/y", "2"], ["parent/z", "2"]]);

it("A1 sync: the warning text and attribution are unchanged (other writers are not excluded)", async () => {
	const active: any[] = [{ id: "other", agent: "o", surfaces: ["other/**"] }];
	const { deps: d } = deps(active, [before, after], async () => answer("done"));
	const launched = await runLaunch({ mode: "single", tasks: [task(true, ["src/mine/**"])] as any, results: placeholders(1), hooks: { tolerateAbort: false } }, d);
	assert.equal(toResult("single", launched).content[0].text, "done\n\nWarnings: files changed outside the writers' allowed edit surfaces: other/y, parent/z");
});

it("A1 async: writers active before and during the launch are excluded; the rest is worded as possibly the parent's", async () => {
	const active: any[] = [{ id: "pre", agent: "o", surfaces: ["other/**"] }];
	let release!: () => void;
	const gate = new Promise<void>((resolve) => (release = resolve));
	const { deps: d, listeners } = deps(active, [before, after], async () => (await gate, answer("done")));
	const p = runLaunch({ mode: "single", tasks: [task(true, ["src/mine/**"])] as any, results: placeholders(1), hooks: { tolerateAbort: true, async: true } }, d);
	await new Promise((resolve) => setImmediate(resolve));
	const mid = { id: "mid", agent: "o2", surfaces: ["elsewhere/**"] };
	d.writers.add([mid]);
	d.writers.remove(mid);
	release();
	const launched = await p;
	assert.deepEqual(launched.details.outsideSurfaces, ["parent/z"]);
	assert.equal(toResult("single", launched).content[0].text, "done\n\nWarnings: files changed outside the writers' allowed edit surfaces (may include edits the parent made meanwhile): parent/z");
	assert.equal(listeners.size, 0, "the launch stops listening when it ends");
});

it("A5: tasks cancelled while queued read as cancelled, never as succeeded or (no output)", async () => {
	const slots = createSemaphore(1);
	await slots.acquire();
	const ac = new AbortController();
	const results = placeholders(2);
	const { deps: d } = deps([], [], async () => answer("never"));
	d.slots = slots;
	const p = runLaunch({ mode: "parallel", tasks: [task(false), task(false)] as any, results, signal: ac.signal, hooks: { tolerateAbort: true, async: true } }, d);
	await new Promise((resolve) => setImmediate(resolve));
	ac.abort();
	const text = toResult("parallel", await p).content[0].text;
	assert.equal(text, "Parallel: 0/2 succeeded\n\n### [b] cancelled\n\nCancelled before it started.\n\n---\n\n### [b] cancelled\n\nCancelled before it started.");
	assert.equal(activeTasks([results]), 0);
	const single = toResult("single", { details: { mode: "single", results: [result({ exitCode: -1, queued: true, cancelled: true, endedAt: 1 })] }, warnings: [] });
	assert.deepEqual([single.content[0].text, single.isError], ["Agent cancelled: Cancelled before it started.", true]);
});
