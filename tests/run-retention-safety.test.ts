import assert from "node:assert/strict";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { newRunId, pruneRunFolders } from "../lib/run-artifacts.ts";

// S3: retention never touches anything outside `runs/`, never a non-run-id entry, and never throws.
const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
const DAY = 86_400_000;
const id = (t: number, name = "worker", hex = "abcdef") => newRunId(name, t, () => hex);
const OLD = id(NOW - 30 * DAY);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-retention-"));
const mkRun = (dir: string, name: string) => {
	fs.mkdirSync(path.join(dir, name), { recursive: true });
	fs.writeFileSync(path.join(dir, name, "task.md"), "x");
};
function hashTree(dir: string): string {
	const h = crypto.createHash("sha256");
	const walk = (p: string) => {
		const st = fs.lstatSync(p);
		h.update(`${p}:${st.mode}`);
		if (st.isSymbolicLink()) h.update(fs.readlinkSync(p));
		else if (st.isDirectory()) for (const e of fs.readdirSync(p).sort()) walk(path.join(p, e));
		else h.update(fs.readFileSync(p));
	};
	walk(dir);
	return h.digest("hex");
}

describe("pruneRunFolders safety (S3)", () => {
	it("a symlinked runs/ folder is never followed", () => {
		const docs = tmp();
		const outside = tmp();
		mkRun(outside, OLD);
		fs.symlinkSync(outside, path.join(docs, "runs"));
		const before = hashTree(outside);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, []);
		assert.equal(hashTree(outside), before);
	});

	it("a runs/ symlink to its own docs folder (a loop) is never followed", () => {
		const docs = tmp();
		fs.symlinkSync(".", path.join(docs, "runs"));
		mkRun(docs, OLD);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, []);
		assert.ok(fs.existsSync(path.join(docs, OLD)));
	});

	it("a run-id-named symlink or file inside runs/ is left alone", () => {
		const docs = tmp();
		const outside = tmp();
		mkRun(outside, "payload");
		fs.mkdirSync(path.join(docs, "runs"));
		fs.symlinkSync(path.join(outside, "payload"), path.join(docs, "runs", OLD));
		fs.writeFileSync(path.join(docs, "runs", id(NOW - 30 * DAY, "file")), "f");
		const before = hashTree(docs) + hashTree(outside);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, []);
		assert.equal(hashTree(docs) + hashTree(outside), before);
	});

	it("names that only look like run ids are left alone", () => {
		const docs = tmp();
		const runs = path.join(docs, "runs");
		const names = [
			"20261001T120000Z-worker-ABCDEF", "20261001T120000Z-worker-abcde", "20261001T120000Z-worker-abcdef0", "20261001T120000-worker-abcdef",
			"20261001T120000Z-worker-abcdef.bak", "20261001T120000Z-worker-abcdef ", "x20261001T120000Z-worker-abcdef", ".20261001T120000Z-worker-abcdef",
			"20261301T120000Z-worker-abcdef", "20260230T120000Z-worker-abcdef", "20261001T250000Z-worker-abcdef", "20261001T120060Z-worker-abcdef",
			"20261001t120000z-worker-abcdef", "20261001T120000Z-..-abcdef", "20261001T120000Z-wor ker-abcdef", "tasks", "reviews",
		];
		for (const n of names) mkRun(runs, n);
		const before = hashTree(docs);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, []);
		assert.equal(hashTree(docs), before);
	});

	it("removing a run folder does not follow symlinks inside it", () => {
		const docs = tmp();
		const outside = tmp();
		mkRun(outside, "secret");
		mkRun(path.join(docs, "runs"), OLD);
		fs.symlinkSync(path.join(outside, "secret"), path.join(docs, "runs", OLD, "link"));
		fs.symlinkSync(outside, path.join(docs, "runs", OLD, "dirlink"));
		const before = hashTree(outside);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, [OLD]);
		assert.equal(hashTree(outside), before);
	});

	it("siblings of runs/ are never touched", () => {
		const docs = tmp();
		fs.mkdirSync(path.join(docs, "runs"));
		mkRun(docs, OLD);
		mkRun(path.join(docs, "tasks"), OLD);
		const before = hashTree(docs);
		pruneRunFolders(docs, { now: () => NOW });
		assert.equal(hashTree(docs), before);
	});

	it("future-dated folders are kept", () => {
		const docs = tmp();
		const future = id(NOW + 365 * DAY);
		mkRun(path.join(docs, "runs"), future);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, []);
	});

	it("the 14-day boundary: older than 14 days goes, exactly 14 days stays", () => {
		const docs = tmp();
		const exact = id(NOW - 14 * DAY, "exact");
		const over = id(NOW - 14 * DAY - 1000, "over");
		const under = id(NOW - 14 * DAY + 1000, "under");
		for (const n of [exact, over, under]) mkRun(path.join(docs, "runs"), n);
		assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }).removed, [over]);
	});

	it("the 200 rule keeps the newest 200 run folders and ignores other entries", () => {
		const docs = tmp();
		const runs = path.join(docs, "runs");
		const ids = Array.from({ length: 205 }, (_, i) => id(NOW - (i + 1) * 60_000, "w", i.toString(16).padStart(6, "0")));
		for (const n of ids) mkRun(runs, n);
		for (let i = 0; i < 5; i++) mkRun(runs, `other${i}`);
		const r = pruneRunFolders(docs, { now: () => NOW });
		assert.deepEqual([...r.removed].sort(), ids.slice(200).sort());
		assert.equal(fs.readdirSync(runs).length, 205);
	});

	it("never throws: docsDir a file, runs/ a file, missing, unreadable, unremovable, a throwing clock", () => {
		const file = path.join(tmp(), "afile");
		fs.writeFileSync(file, "hi");
		assert.doesNotThrow(() => pruneRunFolders(file));
		const runsFile = tmp();
		fs.writeFileSync(path.join(runsFile, "runs"), "f");
		assert.doesNotThrow(() => pruneRunFolders(runsFile));
		assert.doesNotThrow(() => pruneRunFolders(path.join(tmp(), "missing")));
		assert.doesNotThrow(() => pruneRunFolders(""));
		const locked = tmp();
		mkRun(path.join(locked, "runs"), OLD);
		fs.chmodSync(path.join(locked, "runs"), 0o000);
		try {
			assert.doesNotThrow(() => pruneRunFolders(locked, { now: () => NOW }));
		} finally {
			fs.chmodSync(path.join(locked, "runs"), 0o755);
		}
		const stuck = tmp();
		const a = id(NOW - 30 * DAY, "a");
		const b = id(NOW - 31 * DAY, "b");
		mkRun(path.join(stuck, "runs"), a);
		mkRun(path.join(stuck, "runs"), b);
		const r = pruneRunFolders(stuck, {
			now: () => NOW,
			remove: (dir) => {
				if (dir.endsWith(b)) throw "EPERM";
				fs.rmSync(dir, { recursive: true });
			},
		});
		assert.deepEqual(r.removed, [a]);
		assert.equal(r.errors.length, 1);
		assert.doesNotThrow(() =>
			pruneRunFolders(tmp(), {
				now: () => {
					throw new Error("clock");
				},
			}),
		);
	});
});
