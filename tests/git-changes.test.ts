import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { boundDiff, countLines, diffLineTone, parseNumstat, parseStatus, totals, untrackedAsDiff, withCounts } from "../lib/git-changes.ts";

// Real git output from a scratch repository with every kind of change.
describe("git changes", () => {
	let repo: string;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
	before(() => {
		repo = mkdtempSync(join(tmpdir(), "brigadev-git-"));
		git("init", "-q");
		writeFileSync(join(repo, "keep.txt"), "a\nb\nc\n");
		writeFileSync(join(repo, "gone.txt"), "x\n");
		writeFileSync(join(repo, "old name.txt"), "rename me\n".repeat(5));
		writeFileSync(join(repo, "image.bin"), Buffer.from([0, 1, 2, 0, 255]));
		git("add", "-A");
		git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
		writeFileSync(join(repo, "keep.txt"), "a\nB\nc\nd\n");
		git("rm", "-q", "gone.txt");
		git("mv", "old name.txt", "new name.txt");
		writeFileSync(join(repo, "image.bin"), Buffer.from([0, 9, 9, 0, 255]));
		writeFileSync(join(repo, "fresh.ts"), "export const x = 1;\n");
	});
	after(() => rmSync(repo, { recursive: true, force: true }));

	it("parses every status, including renames and paths with spaces", () => {
		const entries = parseStatus(git("status", "--porcelain=v1", "-z", "--untracked-files=all"));
		assert.deepEqual(
			entries.map((e) => [e.path, e.status, e.origPath]),
			[
				["fresh.ts", "U", undefined],
				["gone.txt", "D", undefined],
				["image.bin", "M", undefined],
				["keep.txt", "M", undefined],
				["new name.txt", "R", "old name.txt"],
			],
		);
	});

	it("attaches line counts, marks binaries, and totals them", () => {
		const entries = withCounts(parseStatus(git("status", "--porcelain=v1", "-z", "--untracked-files=all")), parseNumstat(git("diff", "--numstat", "-z", "-M", "HEAD")));
		const byPath = Object.fromEntries(entries.map((e) => [e.path, e]));
		assert.deepEqual([byPath["keep.txt"].added, byPath["keep.txt"].deleted], [2, 1]);
		assert.deepEqual([byPath["gone.txt"].added, byPath["gone.txt"].deleted], [0, 1]);
		assert.equal(byPath["image.bin"].binary, true);
		assert.deepEqual([byPath["new name.txt"].added, byPath["new name.txt"].deleted], [0, 0]);
		assert.deepEqual(totals(entries), { files: 5, added: 2, deleted: 2 });
	});

	it("colors diff lines", () => {
		assert.equal(diffLineTone("+++ b/x"), "dim");
		assert.equal(diffLineTone("@@ -1 +1 @@"), "accent");
		assert.equal(diffLineTone("+added"), "success");
		assert.equal(diffLineTone("-removed"), "error");
		assert.equal(diffLineTone(" context"), "text");
	});

	it("counts lines the way git does", () => {
		assert.equal(countLines(""), 0);
		assert.equal(countLines("a"), 1);
		assert.equal(countLines("a\n"), 1);
		assert.equal(countLines("a\nb\n"), 2);
		assert.equal(countLines("a\n\n"), 2);
	});

	it("shows untracked files as all-added and bounds huge diffs", () => {
		assert.deepEqual(untrackedAsDiff("a.ts", "one\ntwo\n"), ["+++ b/a.ts", "@@ -0,0 +1,2 @@", "+one", "+two"]);
		const huge = boundDiff(Array.from({ length: 20_005 }, () => "x").join("\n"));
		assert.equal(huge.length, 20_001);
		assert.match(huge.at(-1)!, /5 more lines/);
	});
});
