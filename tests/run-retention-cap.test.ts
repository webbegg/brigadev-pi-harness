import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { newRunId, pruneRunFolders } from "../lib/run-artifacts.ts";

// S3: the per-call removal cap (default 50) works oldest first across the age and count rules.
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY = 86_400_000;
let seq = 0;
const mk = () => {
	const d = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-prune-cap-"));
	fs.mkdirSync(path.join(d, "runs"));
	return d;
};
const add = (docs: string, ageMs: number) => {
	const n = newRunId("scout", NOW - ageMs, () => (seq++).toString(16).padStart(6, "0"));
	fs.mkdirSync(path.join(docs, "runs", n));
	return n;
};
const ls = (docs: string) => fs.readdirSync(path.join(docs, "runs")).sort();

it("a backlog of aged folders goes 50 per call, oldest first", () => {
	const docs = mk();
	const names = Array.from({ length: 120 }, (_, i) => add(docs, 15 * DAY + (120 - i) * 1000)).sort();
	let next = 0;
	const counts: number[] = [];
	for (let call = 0; call < 4; call++) {
		const r = pruneRunFolders(docs, { now: () => NOW });
		assert.deepEqual(r.removed, names.slice(next, next + r.removed.length));
		next += r.removed.length;
		counts.push(r.removed.length);
	}
	assert.deepEqual(counts, [50, 50, 20, 0]);
	assert.deepEqual(ls(docs), []);
});

it("the count rule gets what the age rule left of the cap", () => {
	const docs = mk();
	const aged = Array.from({ length: 30 }, (_, i) => add(docs, 20 * DAY - i * 1000)).sort();
	const young = Array.from({ length: 230 }, (_, i) => add(docs, (230 - i) * 60_000)).sort();
	assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, [...aged, ...young.slice(0, 20)]);
	assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, young.slice(20, 30));
	assert.deepEqual(ls(docs), young.slice(30));
});

it("maxRemovals 0 or negative removes nothing; failed removals spend the budget and never throw", () => {
	const docs = mk();
	for (let i = 0; i < 60; i++) add(docs, 30 * DAY + i);
	assert.equal(pruneRunFolders(docs, { now: () => NOW, maxRemovals: 0 }).removed.length, 0);
	assert.equal(pruneRunFolders(docs, { now: () => NOW, maxRemovals: -5 }).removed.length, 0);
	let calls = 0;
	const r = pruneRunFolders(docs, {
		now: () => NOW,
		remove: () => {
			calls++;
			throw new Error("EPERM");
		},
	});
	assert.equal(calls, 50);
	assert.equal(r.errors.length, 50);
	assert.equal(ls(docs).length, 60);
});
