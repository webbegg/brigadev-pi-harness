import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { isDocPath, worktreeTreeResult } from "../lib/worktree-tree.ts";

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repoWith(files: Record<string, string>): string {
	const repo = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-wt-")));
	git(repo, "init", "-q");
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), content);
	}
	return repo;
}

const treeOf = async (repo: string) => {
	const result = await worktreeTreeResult(repo, { sourceTree: true });
	assert.equal(result.kind, "tree");
	return result.kind === "tree" ? result : assert.fail("no tree");
};

describe("isDocPath (S8c: paths a test run does not depend on)", () => {
	it("treats prose and the legal or changelog files (exact names, optional prose or .txt extension) as docs", () => {
		for (const path of ["README.md", "docs/guide.markdown", "CHANGELOG.md", "CHANGELOG", "LICENSE", "NOTICE", "NOTICE.txt", "COPYING", "AUTHORS", "sub/LICENSE", "sub/notes.md", "a.rst", "a.adoc"]) {
			assert.equal(isDocPath(path), true, path);
		}
	});

	it("treats everything else as source", () => {
		for (const path of ["lib/a.ts", "package.json", "tests/a.test.ts", "Makefile", "requirements.txt", "CMakeLists.txt", "src/docs/a.ts", "documentation.ts", "src/component.mdx", "docs/conf.py", "docs/helper.js", "docs/a/b.png", "LICENSE-MIT", "lib/CHANGELOG.ts"]) {
			assert.equal(isDocPath(path), false, path);
		}
	});
});

describe("worktreeTreeResult sourceTree and root (S8b, S8c)", () => {
	it("reports the repository root", async () => {
		const repo = repoWith({ "a.ts": "1" });
		assert.equal((await treeOf(repo)).root, repo);
	});

	it("keeps the source tree when only docs change, and moves it when source changes", async () => {
		const repo = repoWith({ "a.ts": "1", "README.md": "# r\n", "docs/guide.md": "g" });
		const first = await treeOf(repo);

		writeFileSync(join(repo, "README.md"), "# changed\n");
		writeFileSync(join(repo, "CHANGELOG.md"), "new\n");
		writeFileSync(join(repo, "docs", "more.md"), "more\n");
		const docsEdited = await treeOf(repo);
		assert.notEqual(docsEdited.tree, first.tree, "the full tree sees doc edits");
		assert.equal(docsEdited.sourceTree, first.sourceTree, "the source tree does not");

		writeFileSync(join(repo, "a.ts"), "2");
		assert.notEqual((await treeOf(repo)).sourceTree, first.sourceTree);
	});

	it("is the full tree when there are no docs, and omitted unless asked for", async () => {
		const repo = repoWith({ "a.ts": "1" });
		const result = await treeOf(repo);
		assert.equal(result.sourceTree, result.tree);
		const plain = await worktreeTreeResult(repo);
		assert.equal(plain.kind === "tree" ? plain.sourceTree : "x", undefined);
	});
});

describe("worktreeTreeResult of a commit (the PR evidence check keys HEAD like a test run keys the working tree)", () => {
	const commitAll = (repo: string) => {
		git(repo, "add", "-A");
		git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "x");
	};
	const headOf = async (repo: string) => {
		const result = await worktreeTreeResult(repo, { sourceTree: true, commit: "HEAD" });
		return result.kind === "tree" ? result : assert.fail(`no tree: ${JSON.stringify(result)}`);
	};

	it("equals the working-tree key of a clean checkout, source tree included", async () => {
		const repo = repoWith({ "a.ts": "1", "README.md": "# r\n" });
		commitAll(repo);
		const work = await treeOf(repo);
		const head = await headOf(repo);
		assert.equal(head.tree, work.tree);
		assert.equal(head.sourceTree, work.sourceTree);
		assert.notEqual(head.sourceTree, head.tree, "docs are stripped from the source tree");
		assert.equal(head.root, repo);
		assert.equal(head.tree, git(repo, "rev-parse", "HEAD^{tree}"));
	});

	it("ignores uncommitted edits, which a working-tree key sees", async () => {
		const repo = repoWith({ "a.ts": "1" });
		commitAll(repo);
		const before = await headOf(repo);
		writeFileSync(join(repo, "a.ts"), "2");
		writeFileSync(join(repo, "b.ts"), "new");
		assert.deepEqual(await headOf(repo), before);
		assert.notEqual((await treeOf(repo)).tree, before.tree);
	});

	it("writes nothing to the real object store or index", async () => {
		const repo = repoWith({ "a.ts": "1", "N.md": "n" });
		commitAll(repo);
		const objects = git(repo, "count-objects", "-v");
		const status = git(repo, "status", "--porcelain");
		await headOf(repo);
		assert.equal(git(repo, "count-objects", "-v"), objects);
		assert.equal(git(repo, "status", "--porcelain"), status);
	});

	it("is an error for a commit that does not exist (an unborn branch)", async () => {
		const repo = repoWith({ "a.ts": "1" });
		assert.equal((await worktreeTreeResult(repo, { sourceTree: true, commit: "HEAD" })).kind, "error");
	});
});
