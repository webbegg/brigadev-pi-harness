import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { newRunId, pruneRunFolders } from "../lib/run-artifacts.ts";

// S8: a run folder named more than 1 day after `now` takes its age from its mtime (lstat); S3 safety still holds.
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY = 86_400_000;
const id = (t: number, name: string, hex: string) => newRunId(name, t, () => hex);
const tmpDocs = () => {
	const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-future-"));
	fs.mkdirSync(path.join(docs, "runs"));
	return docs;
};
const mkRun = (docs: string, name: string, mtime?: number) => {
	const p = path.join(docs, "runs", name);
	fs.mkdirSync(p);
	fs.writeFileSync(path.join(p, "result.json"), "{}");
	if (mtime !== undefined) fs.utimesSync(p, new Date(mtime), new Date(mtime));
	return p;
};

describe("pruneRunFolders: future-dated names (S8)", () => {
	it("exactly 1 day ahead keeps its name's age; 1 day + 1 s ahead ages by its mtime", () => {
		const docs = tmpDocs();
		const old = NOW - 30 * DAY;
		const exact = id(NOW + DAY, "exact", "000001");
		const over = id(NOW + DAY + 1000, "over", "000002");
		mkRun(docs, exact, old);
		mkRun(docs, over, old);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }), { removed: [over], errors: [] });
		assert.deepEqual(fs.readdirSync(path.join(docs, "runs")), [exact]);
	});

	it("a future-named symlink is never removed, nor its target, even when the link's own mtime is old", () => {
		const docs = tmpDocs();
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-future-out-"));
		fs.writeFileSync(path.join(outside, "keep.txt"), "x");
		const old = new Date(NOW - 100 * DAY);
		fs.utimesSync(outside, old, old);
		const link = path.join(docs, "runs", id(NOW + 30 * DAY, "link", "000003"));
		fs.symlinkSync(outside, link);
		fs.lutimesSync(link, old, old);
		const calls: string[] = [];
		const out = pruneRunFolders(docs, { now: () => NOW, maxFolders: 0, remove: (d) => void calls.push(d) });
		assert.deepEqual(out, { removed: [], errors: [] });
		assert.deepEqual(calls, []);
		assert.ok(fs.lstatSync(link).isSymbolicLink());
		assert.ok(fs.existsSync(path.join(outside, "keep.txt")));
	});

	it("a future-named folder with a fresh mtime is kept by the age rule and ranked by that mtime in the count rule", () => {
		const docs = tmpDocs();
		const fut = id(NOW + 300 * DAY, "fut", "000004");
		const older = id(NOW - 2 * 3_600_000, "older", "000005");
		const newer = id(NOW - 10 * 60_000, "newer", "000006");
		mkRun(docs, fut, NOW - 30 * 60_000);
		mkRun(docs, older);
		mkRun(docs, newer);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, []);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW, maxFolders: 2 }).removed, [older]);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW, maxFolders: 1 }).removed, [fut]);
		assert.deepEqual(fs.readdirSync(path.join(docs, "runs")), [newer]);
	});

	it("mtime-aged future folders respect the 50-removal cap, oldest mtime first", () => {
		const docs = tmpDocs();
		const names: string[] = [];
		for (let i = 0; i < 60; i++) {
			const name = id(NOW + (10 + i) * DAY, `f${i}`, (i + 16).toString(16).padStart(6, "0"));
			mkRun(docs, name, NOW - 30 * DAY - i * 1000);
			names.push(name);
		}
		const out = pruneRunFolders(docs, { now: () => NOW });
		assert.equal(out.removed.length, 50);
		assert.deepEqual(out.errors, []);
		assert.deepEqual(fs.readdirSync(path.join(docs, "runs")).sort(), names.slice(0, 10).sort());
	});

	it("a throwing clock removes nothing and does not throw", () => {
		const docs = tmpDocs();
		const fut = id(NOW + 10 * DAY, "fut", "000007");
		mkRun(docs, fut, NOW - 30 * DAY);
		const out = pruneRunFolders(docs, {
			now: () => {
				throw new Error("clock boom");
			},
		});
		assert.deepEqual(out, { removed: [], errors: ["clock boom"] });
		assert.deepEqual(fs.readdirSync(path.join(docs, "runs")), [fut]);
	});
});
