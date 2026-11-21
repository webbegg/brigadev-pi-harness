import assert from "node:assert/strict";
import { test } from "node:test";
import { createWebLog } from "../lib/web-log.ts";

test("web-log: seq is monotonic from 1 and since(n) returns the events after n", () => {
	const log = createWebLog();
	const a = log.append({ type: "message", data: { text: "a" } });
	const b = log.append({ type: "message", data: { text: "b" } });
	const c = log.append({ type: "message", data: { text: "c" } });
	assert.deepEqual([a.seq, b.seq, c.seq], [1, 2, 3]);
	assert.equal(typeof a.at, "number");
	assert.equal(log.lastSeq(), 3);
	assert.deepEqual(log.since(0).map((e) => e.seq), [1, 2, 3]);
	assert.deepEqual(log.since(1).map((e) => (e.data as any).text), ["b", "c"]);
	assert.deepEqual(log.since(3), []);
	assert.deepEqual(log.since(99), []);
	assert.deepEqual(log.since(-5).map((e) => e.seq), [1, 2, 3]);
});

test("web-log: a keyed type keeps only the newest event per key", () => {
	const log = createWebLog();
	log.append({ type: "brigadev_agent", data: { id: "l:0", status: "running" } });
	log.append({ type: "brigadev_agent", data: { id: "l:1", status: "running" } });
	log.append({ type: "brigadev_agent", data: { id: "l:0", status: "done" } });
	const snapshot = log.since(0);
	assert.deepEqual(snapshot.map((e) => e.seq), [2, 3], "seq-ordered, the stale l:0 snapshot is gone");
	assert.deepEqual(snapshot.map((e) => (e.data as any).status), ["running", "done"]);
	assert.equal(snapshot[1].key, "l:0");
});

test("web-log: every CHANNELS keyed type and the core keyed types are keyed", () => {
	const log = createWebLog();
	for (const [type, data] of [
		["brigadev_phase", { scope: "loop" }],
		["brigadev_todo", { scope: "todo" }],
		["brigadev_prompt", { id: "p" }],
		["brigadev_mode", { scope: "mode" }],
		["tool", { id: "t" }],
		["assistant_live", { id: "live" }],
		["run", { id: "run" }],
	] as const) {
		log.append({ type, data });
		log.append({ type, data });
	}
	assert.equal(log.since(0).length, 7);
});

test("web-log: unkeyed types keep the last N overall", () => {
	const log = createWebLog({ maxUnkeyed: 3 });
	for (let i = 1; i <= 5; i++) log.append({ type: "brigadev_check", data: { id: String(i) } });
	assert.deepEqual(log.since(0).map((e) => (e.data as any).id), ["3", "4", "5"]);
});

test("web-log: since(0) interleaves keyed and unkeyed events in seq order", () => {
	const log = createWebLog({ maxUnkeyed: 2 });
	log.append({ type: "message", data: { n: 1 } }); // 1, evicted later
	log.append({ type: "tool", data: { id: "t", status: "running" } }); // 2, replaced
	log.append({ type: "message", data: { n: 2 } }); // 3
	log.append({ type: "tool", data: { id: "t", status: "done" } }); // 4
	log.append({ type: "message", data: { n: 3 } }); // 5
	assert.deepEqual(log.since(0).map((e) => e.seq), [3, 4, 5]);
	assert.deepEqual(log.since(3).map((e) => e.seq), [4, 5]);
});

test("web-log: a keyed event whose payload lacks the key is kept as an unkeyed one", () => {
	const log = createWebLog({ maxUnkeyed: 2 });
	for (let i = 0; i < 4; i++) log.append({ type: "brigadev_agent", data: { nokey: i } });
	assert.equal(log.since(0).length, 2);
});

test("web-log: the number of distinct keys is bounded, oldest first", () => {
	const log = createWebLog({ maxKeyed: 3 });
	for (let i = 1; i <= 5; i++) log.append({ type: "tool", data: { id: `t${i}` } });
	assert.deepEqual(log.since(0).map((e) => e.key), ["t3", "t4", "t5"]);
});

test("web-log: one-per-session snapshots (mode, todo, session, phase, run, live) are never evicted by per-item churn", () => {
	const log = createWebLog();
	log.append({ type: "brigadev_mode", data: { scope: "mode", mode: "yolo" } });
	log.append({ type: "brigadev_todo", data: { scope: "todo", todos: [] } });
	log.append({ type: "brigadev_phase", data: { scope: "loop", phase: "explore" } });
	log.append({ type: "session", data: { id: "session", project: "p", branch: "b" } });
	log.append({ type: "run", data: { id: "run", running: true } });
	log.append({ type: "assistant_live", data: { id: "live", text: "hi", active: true } });
	for (let i = 0; i < 5000; i++) log.append({ type: "tool", data: { id: `t${i}`, status: "done" } });
	const types = log.since(0).map((e) => e.type);
	for (const type of ["brigadev_mode", "brigadev_todo", "brigadev_phase", "session", "run", "assistant_live"]) assert.ok(types.includes(type), `${type} survives a late replay`);
	assert.ok(types.filter((t) => t === "tool").length <= 2000, "the per-item type stays bounded");
});

test("web-log: per-item types have their own caps: churn in one does not evict another", () => {
	const log = createWebLog({ maxKeyed: 4 });
	for (let i = 0; i < 3; i++) log.append({ type: "brigadev_agent", data: { id: `a${i}` } });
	log.append({ type: "brigadev_prompt", data: { id: "p1" } });
	for (let i = 0; i < 50; i++) log.append({ type: "tool", data: { id: `t${i}` } });
	const count = (type: string) => log.since(0).filter((e) => e.type === type).length;
	assert.deepEqual([count("brigadev_agent"), count("brigadev_prompt"), count("tool")], [3, 1, 4]);
});

test("web-log: an explicit key and custom key fields are honored", () => {
	const log = createWebLog({ keyed: { thing: "name" } });
	log.append({ type: "thing", data: { name: "x", v: 1 } });
	log.append({ type: "thing", data: { name: "x", v: 2 } });
	log.append({ type: "other", data: {}, key: "k" });
	log.append({ type: "other", data: { v: 2 }, key: "k" });
	assert.deepEqual(log.since(0).map((e) => (e.data as any).v), [2, 2]);
});

test("web-log: subscribers get each appended event until they unsubscribe; a throwing one does not break append", () => {
	const log = createWebLog();
	const seen: number[] = [];
	log.subscribe(() => {
		throw new Error("boom");
	});
	const off = log.subscribe((e) => seen.push(e.seq));
	log.append({ type: "message", data: {} });
	off();
	log.append({ type: "message", data: {} });
	assert.deepEqual(seen, [1]);
});
