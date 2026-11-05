import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { diffSnapshots, outsideSurfaces, parsePorcelain, takeSnapshot, type ExecFn, type Snapshot } from "../lib/worktree-snapshot.ts";

const snap = (entries: Record<string, string>): Snapshot => new Map(Object.entries(entries));

describe("diffSnapshots", () => {
	it("reports a new untracked file", () => {
		assert.deepEqual(diffSnapshots(snap({}), snap({ "src/new.ts": "h1" })), ["src/new.ts"]);
	});

	it("reports a tracked file modified for the first time", () => {
		assert.deepEqual(diffSnapshots(snap({}), snap({ "src/a.ts": "h1" })), ["src/a.ts"]);
	});

	it("reports a further change to an already dirty file", () => {
		assert.deepEqual(diffSnapshots(snap({ "src/a.ts": "h1" }), snap({ "src/a.ts": "h2" })), ["src/a.ts"]);
	});

	it("reports a deletion", () => {
		assert.deepEqual(diffSnapshots(snap({ "src/a.ts": "h1" }), snap({ "src/a.ts": "-" })), ["src/a.ts"]);
		assert.deepEqual(diffSnapshots(snap({ "src/new.ts": "h1" }), snap({})), ["src/new.ts"]);
	});

	it("reports both sides of a rename", () => {
		const before = snap({});
		const after = snap({ "src/new.ts": "h1", "src/old.ts": "-" });
		assert.deepEqual(diffSnapshots(before, after), ["src/new.ts", "src/old.ts"]);
	});

	it("does not report an unchanged dirty file", () => {
		assert.deepEqual(diffSnapshots(snap({ "src/a.ts": "h1", "b.ts": "h2" }), snap({ "src/a.ts": "h1", "b.ts": "h2" })), []);
	});

	it("returns sorted paths", () => {
		assert.deepEqual(diffSnapshots(snap({}), snap({ b: "1", a: "1" })), ["a", "b"]);
	});
});

describe("outsideSurfaces", () => {
	it("keeps only paths outside every surface", () => {
		assert.deepEqual(outsideSurfaces(["src/a.ts", "tests/a.test.ts", "README.md"], ["src", "tests/*.test.ts"]), ["README.md"]);
	});
});

const realExec: ExecFn = (command, args, options) =>
	new Promise((resolve) => {
		execFile(command, args, { cwd: options.cwd, timeout: options.timeout }, (error, stdout, stderr) => {
			resolve({ stdout, stderr, code: error ? (typeof error.code === "number" ? error.code : 1) : 0 });
		});
	});

describe("takeSnapshot", () => {
	const git = (cwd: string, ...args: string[]) =>
		new Promise<void>((resolve, reject) => execFile("git", args, { cwd }, (error) => (error ? reject(error) : resolve())));

	it("detects new, further-modified, deleted and renamed files in a repository", async () => {
		const root = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-snap-")));
		try {
			await git(root, "init", "-q");
			mkdirSync(join(root, "src"));
			writeFileSync(join(root, "src", "a.ts"), "one\n");
			writeFileSync(join(root, "src", "b.ts"), "b\n");
			writeFileSync(join(root, "keep.txt"), "keep\n");
			await git(root, "add", ".");
			await git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

			writeFileSync(join(root, "src", "a.ts"), "two\n");
			writeFileSync(join(root, "keep.txt"), "dirty\n");
			const before = await takeSnapshot(realExec, root);
			assert.ok(before);

			writeFileSync(join(root, "src", "a.ts"), "three\n");
			writeFileSync(join(root, "new.txt"), "new\n");
			rmSync(join(root, "src", "b.ts"));
			const after = await takeSnapshot(realExec, root);
			assert.ok(after);
			assert.deepEqual(diffSnapshots(before, after), ["new.txt", "src/a.ts", "src/b.ts"]);

			renameSync(join(root, "new.txt"), join(root, "moved.txt"));
			const renamed = await takeSnapshot(realExec, root);
			assert.deepEqual(diffSnapshots(after, renamed!), ["moved.txt", "new.txt"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("is limited to the project root inside a larger repository", async () => {
		const top = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-snap-")));
		try {
			await git(top, "init", "-q");
			mkdirSync(join(top, "pkg"));
			const before = await takeSnapshot(realExec, join(top, "pkg"));
			writeFileSync(join(top, "pkg", "x.txt"), "x\n");
			writeFileSync(join(top, "other.txt"), "o\n");
			const after = await takeSnapshot(realExec, join(top, "pkg"));
			assert.deepEqual(diffSnapshots(before!, after!), ["x.txt"]);
		} finally {
			rmSync(top, { recursive: true, force: true });
		}
	});

	it("returns undefined outside a repository", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-snap-")));
		try {
			assert.equal(await takeSnapshot(realExec, dir), undefined);
			assert.equal(await takeSnapshot(async () => { throw new Error("no git"); }, dir), undefined);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parsePorcelain", () => {
	it("parses modified, untracked and deleted entries", () => {
		assert.deepEqual(parsePorcelain(" M src/a.ts\0?? new.ts\0 D gone.ts\0"), ["src/a.ts", "new.ts", "gone.ts"]);
	});

	it("parses a rename with its original path", () => {
		assert.deepEqual(parsePorcelain("R  new.ts\0old.ts\0 M a.ts\0"), ["new.ts", "old.ts", "a.ts"]);
	});

	it("returns nothing for empty output", () => {
		assert.deepEqual(parsePorcelain(""), []);
	});
});
