import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	appendEvidence,
	branchSlug,
	buildRunRecord,
	checkKind,
	checkOutcome,
	decideCommitGate,
	evidenceFile,
	isSourcePath,
	outputTail,
	readEvidence,
	type EvidenceRecord,
} from "../lib/evidence.ts";
import { worktreeTree } from "../lib/worktree-tree.ts";

describe("checkKind", () => {
	it("tells test runs from other checks", () => {
		assert.equal(checkKind("npm test"), "test");
		assert.equal(checkKind("cd app && pnpm run test -- --watch=false"), "test");
		assert.equal(checkKind("node --test tests/a.test.ts"), "test");
		assert.equal(checkKind("pytest -q"), "test");
		assert.equal(checkKind("go test ./..."), "test");
		assert.equal(checkKind("npm run lint"), "check");
		assert.equal(checkKind("tsc --noEmit"), "check");
		assert.equal(checkKind("git status"), undefined);
		assert.equal(checkKind("echo npm"), undefined);
	});

	it("reads the runner from the command word, never from an argument", () => {
		for (const command of ["echo npm test", `grep -n "node --test" package.json`, "true # npm test", ": npm test", `echo "npm test"`, "cat vitest.config.ts", "git commit -m 'npm test'"]) {
			assert.equal(checkKind(command), undefined, command);
		}
	});

	it("sees the runner behind assignments, runners, a negation, and a path", () => {
		for (const command of ["CI=1 npm test", "npx vitest run", "pnpm exec jest", "yarn vitest", "yarn test", "./node_modules/.bin/mocha", "! npm test", "npm run build && npm test", "git diff | cat && pytest", "./gradlew test", "python -m pytest"]) {
			assert.equal(checkKind(command), "test", command);
		}
		assert.equal(checkKind("npx tsc --noEmit"), "check");
		assert.equal(checkKind("npm run lint && cargo build"), "check");
	});

	it("ignores a runner name inside quoted text with separators", () => {
		assert.equal(checkKind(`echo "a; npm test | cat"`), undefined);
	});
});

describe("checkOutcome", () => {
	const inRepo = { cwd: "/work/repo", topLevel: "/work/repo", home: "/home/u" };

	it("passes only when the exit code belongs to the check", () => {
		assert.equal(checkOutcome("npm test", 0), "pass");
		assert.equal(checkOutcome("npm test", 1), "fail");
		assert.equal(checkOutcome("cd x && npm test && echo ok", 0, inRepo), "pass");
		assert.equal(checkOutcome("CI=1 npm test 2>&1", 0), "pass");
		assert.equal(checkOutcome("npm run build && npm test", 0), "pass");
		assert.equal(checkOutcome("set -euo pipefail; npm test | tail -5", 0), "pass");
		assert.equal(checkOutcome("set -eo pipefail; npm test | tail -5", 1), "fail");
		assert.equal(checkOutcome(`npm test -- --grep "a;b|c"`, 0), "pass");
		assert.equal(checkOutcome("set -o pipefail; npm test 2>&1 | tail -5", 0), "pass");
		assert.equal(checkOutcome("set -o pipefail; npm test 2>&1 | tail -5", 1), "fail");
	});

	it("is unknown when a later command owns the exit code", () => {
		assert.equal(checkOutcome("npm test 2>&1 | tail -5", 0), "unknown");
		assert.equal(checkOutcome("npm test; echo done", 0), "unknown");
		assert.equal(checkOutcome("npm test || true", 0), "unknown");
		assert.equal(checkOutcome("npm test &", 0), "unknown");
		assert.equal(checkOutcome("npm test\necho done", 0), "unknown");
		assert.equal(checkOutcome("npm test", undefined), "unknown");
	});

	it("is never a pass when the test does not own the exit code (verifier forms)", () => {
		const forms = [
			"echo npm test",
			`grep -n "node --test" package.json`,
			"true # npm test",
			": npm test",
			"! npm test",
			"true || npm test",
			"exit 0 && npm test",
			"echo pipefail; npm test | cat",
			"npm test # all",
			"echo $(npm test)",
			"echo `npm test`",
			"(npm test)",
			"(cd x && npm test)",
			"true && (npm test)",
			"return 0 && npm test",
			"exec true && npm test",
			"trap true EXIT && npm test",
			"eval true && npm test",
			"source ./x.sh && npm test",
			". ./x.sh && npm test",
			"npm test\ntrue",
			"npm test &",
			"true & npm test",
			"npm test | cat",
			"npm test 2>&1 | tail -5",
			"set -o pipefail; true; npm test",
			"set -o nounset; npm test",
			"cat <<EOF\nnpm test\nEOF",
		];
		for (const command of forms) for (const code of [0, 1]) assert.equal(checkOutcome(command, code, inRepo), "unknown", `${command} (exit ${code})`);
	});

	it("keeps a quoted separator inside an argument from hiding the test", () => {
		assert.equal(checkOutcome(`npm test -- -t "x|y; z"`, 0), "pass");
		assert.equal(checkOutcome(`echo "a;b" && npm test`, 0), "pass");
	});

	it("trusts a cd before the test only when it stays inside the repository", () => {
		assert.equal(checkOutcome("cd sub/dir && npm test", 0, inRepo), "pass");
		assert.equal(checkOutcome("cd sub && cd .. && npm test", 0, inRepo), "pass");
		assert.equal(checkOutcome("cd /work/repo/app && npm test", 0, inRepo), "pass");
		assert.equal(checkOutcome("cd ~/app && npm test", 0, { ...inRepo, home: "/work/repo" }), "pass");
		for (const command of ["cd .. && npm test", "cd /tmp && npm test", "cd ~ && npm test", "cd - && npm test", "cd $X && npm test", "cd sub/../../x && npm test", "cd a b && npm test", "popd && npm test"]) {
			assert.equal(checkOutcome(command, 0, inRepo), "unknown", command);
		}
		assert.equal(checkOutcome("cd sub && npm test", 0), "unknown", "no directory context");
	});

	it("does not read || or a pipe before the check as owning the exit code", () => {
		assert.equal(checkOutcome("git diff --stat | cat && npm test", 0), "pass");
	});
});

describe("records", () => {
	it("builds a bounded record", () => {
		const record = buildRunRecord({ ts: "2026-11-14T10:00:00.000Z", branch: "feat/x", tree: "t1", cwd: "/r", agent: "parent", command: `npm test ${"x".repeat(900)}`, exitCode: 0, output: "line\n".repeat(100) });
		assert.equal(record.kind, "test");
		assert.equal(record.outcome, "pass");
		assert.ok(record.command.length <= 500);
		assert.ok(record.tail.split("\n").length <= 20);
	});

	it("keeps the last lines of output within the byte cap", () => {
		assert.equal(outputTail("a\nb\nc\n", 2), "b\nc");
		assert.ok(outputTail("y".repeat(5000), 20).length <= 2000);
	});

	it("files evidence per branch in the docs folder", () => {
		assert.equal(branchSlug("feat/a/b"), "feat-a-b");
		assert.equal(branchSlug(null), "detached");
		assert.equal(evidenceFile("/docs", "feat/x"), "/docs/evidence/feat-x.jsonl");
	});

	it("appends and reads back, skipping malformed lines", () => {
		const dir = mkdtempSync(join(tmpdir(), "brigadev-ev-"));
		const file = join(dir, "evidence", "b.jsonl");
		const record = buildRunRecord({ ts: "t", branch: "b", tree: "t1", cwd: "/r", agent: "parent", command: "npm test", exitCode: 1, output: "boom" });
		appendEvidence(file, record);
		writeFileSync(file, `${readFileSync(file, "utf8")}{not json\n`);
		appendEvidence(file, { ...record, outcome: "pass" });
		assert.deepEqual(
			readEvidence(file).map((r) => r.outcome),
			["fail", "pass"],
		);
		assert.deepEqual(readEvidence(join(dir, "missing.jsonl")), []);
	});
});

describe("isSourcePath", () => {
	it("treats prose files as docs and everything else as source", () => {
		for (const path of ["README.md", "docs/guide.markdown", "CHANGELOG.md", "docs/a.rst", "docs/a.adoc", "LICENSE", "NOTICE", "COPYING", "AUTHORS", "sub/LICENSE"]) assert.equal(isSourcePath(path), false, path);
		for (const path of ["lib/a.ts", "package.json", "tests/a.test.ts", "assets/agents/x.schema.json", "Makefile", "requirements.txt", "CMakeLists.txt", "docs/guide.mdx", "LICENSE.ts"]) assert.equal(isSourcePath(path), true, path);
	});
});

const run = (over: Partial<EvidenceRecord>): EvidenceRecord => ({
	v: 1,
	type: "run",
	ts: "t",
	branch: "b",
	tree: "T",
	cwd: "/r",
	agent: "parent",
	command: "npm test",
	kind: "test",
	exitCode: 0,
	outcome: "pass",
	tail: "",
	...over,
});

describe("decideCommitGate", () => {
	const base = { dirtyPaths: ["lib/a.ts"], tree: "T", elsewhere: false, records: [run({})], forcedTree: undefined };

	it("allows a commit whose current tree has a passing test", () => {
		assert.equal(decideCommitGate(base).action, "allow");
	});

	it("blocks when the only passing test ran on another tree", () => {
		const gate = decideCommitGate({ ...base, records: [run({ tree: "OLD" })] });
		assert.equal(gate.action, "block");
		assert.match(gate.action === "block" ? gate.reason : "", /no passing test/i);
	});

	it("does not count failing, unknown, or non-test runs", () => {
		for (const record of [run({ outcome: "fail", exitCode: 1 }), run({ outcome: "unknown" }), run({ kind: "check", command: "npm run lint" })]) {
			assert.equal(decideCommitGate({ ...base, records: [record] }).action, "block");
		}
	});

	it("lets docs-only changes through", () => {
		assert.equal(decideCommitGate({ ...base, dirtyPaths: ["README.md", "CHANGELOG.md"], records: [] }).action, "allow");
	});

	it("allows when the tree cannot be computed (no git)", () => {
		assert.equal(decideCommitGate({ ...base, tree: undefined, records: [] }).action, "allow");
	});

	it("blocks a commit that runs in another directory, even with evidence here", () => {
		assert.equal(decideCommitGate({ ...base, elsewhere: true }).action, "block");
	});

	it("honours a user force bound to the same tree only", () => {
		assert.equal(decideCommitGate({ ...base, records: [], forcedTree: "T" }).action, "allow");
		assert.equal(decideCommitGate({ ...base, records: [], forcedTree: "OTHER" }).action, "block");
	});

	it("explains how to unblock in the block reason", () => {
		const gate = decideCommitGate({ ...base, records: [run({ outcome: "unknown", command: "npm test | tail" })] });
		assert.match(gate.action === "block" ? gate.reason : "", /pipefail/);
	});
});

describe("worktreeTree", () => {
	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

	it("keys the worktree content, unchanged by commits and changed by edits", async () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-tree-")));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@t");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.ts"), "1");
		git(repo, "add", "a.ts");
		git(repo, "commit", "-qm", "init");
		writeFileSync(join(repo, "a.ts"), "2");
		writeFileSync(join(repo, "new.ts"), "n");
		writeFileSync(join(repo, ".gitignore"), "ignored.log\n");

		const before = await worktreeTree(repo);
		assert.match(before ?? "", /^[0-9a-f]{40}$/);
		const indexBefore = git(repo, "diff", "--cached", "--name-only");

		writeFileSync(join(repo, "ignored.log"), "noise");
		assert.equal(await worktreeTree(repo), before, "ignored files do not change the key");
		assert.equal(git(repo, "diff", "--cached", "--name-only"), indexBefore, "the real index is untouched");

		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "two");
		assert.equal(await worktreeTree(repo), before, "a commit without edits keeps the key");

		writeFileSync(join(repo, "a.ts"), "3");
		assert.notEqual(await worktreeTree(repo), before, "an edit changes the key");
	});

	it("is undefined outside a repository", async () => {
		assert.equal(await worktreeTree(realpathSync(mkdtempSync(join(tmpdir(), "brigadev-nogit-")))), undefined);
	});
});
