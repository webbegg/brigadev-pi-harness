import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { execFile } from "node:child_process";
import { repoDocsDir } from "../lib/repo-docs.ts";
import {
	evaluateCommitGate,
	pipefailCommand,
	appendEvidence,
	branchSlug,
	buildRunRecord,
	buildVerifyRecord,
	checkKind,
	checkOutcome,
	decideCommitGate,
	evidenceFile,
	isSourcePath,
	outputTail,
	readEvidence,
	type EvidenceRecord,
} from "../lib/evidence.ts";
import { worktreeTree, worktreeTreeResult } from "../lib/worktree-tree.ts";

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

	it("GATE R1-002: a later `set` (turning pipefail or errexit off) makes the run untrusted", () => {
		for (const command of [
			"set -o pipefail && set +o pipefail && npm test | tail",
			"set -o pipefail; set +o pipefail; npm test | tail",
			"set -o pipefail; set +e; npm test | tail",
			"set -o pipefail; npm test | tail && set +o pipefail",
			"set -o pipefail; echo x && set +o pipefail && npm test | tail",
		]) {
			assert.equal(checkOutcome(command, 0), "unknown", command);
			assert.equal(checkOutcome(command, 1), "unknown", command);
		}
		assert.equal(checkOutcome("set -o pipefail; npm test | tail", 0), "pass", "the leading setter still counts");
	});

	it("GATE R3-001: exit 141 (SIGPIPE from a consumer that closed early) under pipefail is unknown, not a failure", () => {
		assert.equal(checkOutcome("set -o pipefail; node --test | head -5", 141), "unknown");
		assert.equal(checkOutcome("set -o pipefail; npm test 2>&1 | head", 141), "unknown");
		assert.equal(checkOutcome("set -o pipefail; node --test | head -5", 1), "fail");
		assert.equal(checkOutcome("set -o pipefail; node --test | head -5", 0), "pass");
		assert.equal(checkOutcome("node --test", 141), "fail", "without a pipe 141 is the runner's own code");
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
		for (const path of ["README.md", "docs/guide.markdown", "CHANGELOG.md", "CHANGELOG", "docs/a.rst", "docs/a.adoc", "LICENSE", "LICENSE.txt", "NOTICE", "COPYING", "AUTHORS", "sub/LICENSE"]) assert.equal(isSourcePath(path), false, path);
		for (const path of ["lib/a.ts", "package.json", "tests/a.test.ts", "assets/agents/x.schema.json", "Makefile", "requirements.txt", "CMakeLists.txt", "src/component.mdx", "src/docs/a.ts", "docs/guide.mdx", "docs/conf.py", "docs/helper.js", "LICENSE-MIT"]) assert.equal(isSourcePath(path), true, path);
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

	it("blocks when the tree could not be computed, naming the failure (fails closed)", () => {
		for (const records of [[], [run({})], [run({ tree: undefined })]]) {
			const gate = decideCommitGate({ ...base, tree: undefined, treeError: "timed out after 10s", records });
			assert.equal(gate.action, "block");
			assert.match(gate.action === "block" ? gate.reason : "", /timed out after 10s/);
		}
	});

	it("does not let an undefined forced tree match an undefined tree", () => {
		const gate = decideCommitGate({ ...base, tree: undefined, treeError: "git failed", records: [], forcedTree: undefined });
		assert.equal(gate.action, "block");
		assert.equal(decideCommitGate({ ...base, tree: undefined, treeError: "git failed", records: [], forcedTree: "T" }).action, "block");
	});

	it("blocks a commit that runs in another directory, even with evidence here", () => {
		assert.equal(decideCommitGate({ ...base, elsewhere: true }).action, "block");
	});

	it("S8c: a passing run still vouches when only docs changed since (same source tree)", () => {
		const passed = run({ tree: "OLD", srcTree: "S" });
		assert.equal(decideCommitGate({ ...base, sourceTree: "S", records: [passed] }).action, "allow");
		assert.equal(decideCommitGate({ ...base, sourceTree: "S2", records: [passed] }).action, "block", "a source change invalidates it");
		assert.equal(decideCommitGate({ ...base, records: [passed] }).action, "block", "without a source tree only the full tree counts");
		assert.equal(decideCommitGate({ ...base, sourceTree: "S", records: [run({ tree: undefined, srcTree: "S", outcome: "fail", exitCode: 1 })] }).action, "block");
	});

	it("S8b: a run recorded in another repository does not vouch", () => {
		const elsewhere = run({ root: "/other" });
		assert.equal(decideCommitGate({ ...base, root: "/repo", records: [elsewhere] }).action, "block");
		assert.equal(decideCommitGate({ ...base, root: "/other", records: [elsewhere] }).action, "allow");
		assert.equal(decideCommitGate({ ...base, root: "/repo", records: [run({})] }).action, "allow", "a record without a root still matches by tree");
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

	it("tells a missing repository from a failure", async () => {
		assert.deepEqual(await worktreeTreeResult(realpathSync(mkdtempSync(join(tmpdir(), "brigadev-nogit-")))), { kind: "no-git" });

		const repo = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-tree-")));
		git(repo, "init", "-q");
		writeFileSync(join(repo, "a.ts"), "1");
		const ok = await worktreeTreeResult(repo);
		assert.equal(ok.kind, "tree");
		assert.match(ok.kind === "tree" ? ok.tree : "", /^[0-9a-f]{40,64}$/);

		const expired = await worktreeTreeResult(repo, { timeoutMs: 0 });
		assert.equal(expired.kind, "error");
		assert.match(expired.kind === "error" ? expired.reason : "", /timed out/);
		assert.equal(await worktreeTree(repo, { timeoutMs: 0 }), undefined);

		writeFileSync(join(repo, ".git", "index"), "not an index");
		const broken = await worktreeTreeResult(repo);
		assert.equal(broken.kind, "error", "a git failure is not 'no git'");
	});

	it("writes no objects into the real object store", async () => {
		const repo = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-tree-")));
		git(repo, "init", "-q");
		git(repo, "config", "user.email", "t@t");
		git(repo, "config", "user.name", "t");
		writeFileSync(join(repo, "a.ts"), "1");
		git(repo, "add", "a.ts");
		git(repo, "commit", "-qm", "init");
		const objects = () => git(repo, "count-objects", "-v").split("\n").filter((line) => /^(count|in-pack):/.test(line)).join(",");
		const before = objects();

		writeFileSync(join(repo, "untracked.ts"), "content never hashed before\n");
		const first = await worktreeTree(repo);
		assert.match(first ?? "", /^[0-9a-f]{40}$/);
		assert.equal(objects(), before, "hashing an untracked file leaves the real .git/objects as it was");
		assert.equal(await worktreeTree(repo), first, "the key is stable");

		writeFileSync(join(repo, "untracked.ts"), "changed\n");
		assert.notEqual(await worktreeTree(repo), first, "an edit changes the key");
		assert.equal(objects(), before);
	});
});

describe("pipefailCommand (S8a: a piped test run gets the runner's exit code)", () => {
	const context = { cwd: "/repo", topLevel: "/repo" };

	it("prefixes pipefail when that is all a recognized, piped test run lacked", () => {
		for (const command of ["node --test tests/a.test.ts | tail -20", "npm test 2>&1 | tail -5", "cd sub && npm test | grep -v ok", "npm run build && npm test | tee out.log"]) {
			const prefixed = pipefailCommand(command, context);
			assert.equal(prefixed, `set -o pipefail; ${command}`, command);
			assert.equal(checkOutcome(command, 0, context), "unknown", `${command} was untrusted`);
			assert.equal(checkOutcome(prefixed ?? "", 0, context), "pass", `${command} is trusted once prefixed`);
			assert.equal(checkOutcome(prefixed ?? "", 1, context), "fail");
		}
	});

	it("leaves alone what is already trusted, not a test, or untrustworthy for another reason", () => {
		for (const command of [
			"npm test",
			"set -o pipefail; npm test | tail",
			"tsc --noEmit | head",
			"echo hi | tail",
			"npm test; echo done | tail",
			"npm test | tail || true",
			"npm test --help | tail",
			"npm test | tail\necho done",
			"cd .. && npm test | tail",
		]) assert.equal(pipefailCommand(command, context), undefined, command);
	});
});

describe("evaluateCommitGate (S8b/S8c: the gate judges the repository the commit runs in)", () => {
	const run = promisify(execFile);
	const exec = async (command: string, args: string[], options: { cwd: string }) => {
		try {
			const { stdout, stderr } = await run(command, args, { cwd: options.cwd });
			return { stdout, stderr, code: 0 };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; code?: number };
			return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
		}
	};
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

	const base = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-gate-")));
	const saved = process.env.BRIGADEV_HOME;
	process.env.BRIGADEV_HOME = join(base, "home");
	after(() => {
		if (saved === undefined) delete process.env.BRIGADEV_HOME;
		else process.env.BRIGADEV_HOME = saved;
		rmSync(base, { recursive: true, force: true });
	});

	// A session folder that is no repository, holding a nested repository on a feature branch.
	const parent = join(base, "parent");
	let count = 0;
	function nestedRepo() {
		const repo = join(parent, `repo${++count}`);
		mkdirSync(repo, { recursive: true });
		git(repo, "init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "src.ts"), "1");
		writeFileSync(join(repo, "README.md"), "# r\n");
		git(repo, "add", "-A");
		git(repo, "commit", "-qm", "init");
		writeFileSync(join(repo, "src.ts"), "2");
		return repo;
	}
	/** Records a test run the way the recorder does, against `repo`'s current tree. */
	async function recordPass(repo: string, outcome: "pass" | "fail" = "pass") {
		const result = await worktreeTreeResult(repo, { sourceTree: true });
		assert.equal(result.kind, "tree");
		if (result.kind !== "tree") return;
		const record = buildRunRecord({ ts: "t", branch: "feat/x", tree: result.tree, srcTree: result.sourceTree, root: result.root, cwd: parent, agent: "parent", command: "npm test", exitCode: outcome === "pass" ? 0 : 1, output: "", topLevel: result.root });
		appendEvidence(evidenceFile(repoDocsDir(repo), "feat/x"), record);
	}
	const gate = async (command: string, cwd: string, forcedTree?: string) => {
		const evaluation = await evaluateCommitGate({ exec, command, cwd, forcedTree });
		assert.ok(evaluation, command);
		return evaluation;
	};

	it("has nothing to say about a command without a commit", async () => {
		assert.equal(await evaluateCommitGate({ exec, command: "npm test", cwd: parent, forcedTree: undefined }), undefined);
	});

	it("allows `git -C <repo> commit` and `cd <repo> && git commit` from the parent folder when the repository has a passing run", async () => {
		const repo = nestedRepo();
		const name = repo.slice(parent.length + 1);
		assert.equal((await gate(`git -C ${name} commit -am x`, parent)).decision.action, "block", "no run yet");
		await recordPass(repo);
		for (const command of [`git -C ${name} commit -am x`, `cd ${name} && git commit -am x`, `cd ${name} && git add -A && git commit -m x`, `git -C ${repo} commit -am x`]) {
			const evaluation = await gate(command, parent);
			assert.deepEqual(evaluation.decision, { action: "allow", why: "passing test on this tree" }, command);
			assert.equal(evaluation.branch, "feat/x");
		}
	});

	it("blocks the nested repository when its last run failed, or the source changed since", async () => {
		const failing = nestedRepo();
		await recordPass(failing, "fail");
		assert.equal((await gate(`git -C ${failing} commit -am x`, parent)).decision.action, "block");

		const edited = nestedRepo();
		await recordPass(edited);
		writeFileSync(join(edited, "src.ts"), "3");
		assert.equal((await gate(`cd ${edited} && git commit -am x`, parent)).decision.action, "block");
	});

	it("S8c: edits to docs after a passing run do not invalidate it; a source edit does", async () => {
		const repo = nestedRepo();
		await recordPass(repo);
		writeFileSync(join(repo, "README.md"), "# changed\n");
		writeFileSync(join(repo, "CHANGELOG.md"), "new\n");
		mkdirSync(join(repo, "docs"), { recursive: true });
		writeFileSync(join(repo, "docs", "guide.md"), "g\n");
		assert.deepEqual((await gate(`git -C ${repo} commit -am x`, parent)).decision, { action: "allow", why: "passing test on this tree" });
		writeFileSync(join(repo, "src.ts"), "4");
		assert.equal((await gate(`git -C ${repo} commit -am x`, parent)).decision.action, "block");
	});

	it("does not mix up repositories: a run recorded in one does not vouch for another", async () => {
		const a = nestedRepo();
		const b = nestedRepo();
		await recordPass(a);
		assert.equal((await gate(`git -C ${a} commit -am x`, parent)).decision.action, "allow");
		assert.equal((await gate(`git -C ${b} commit -am x`, parent)).decision.action, "block");
	});

	it("still blocks as elsewhere when the target cannot be resolved", async () => {
		const repo = nestedRepo();
		await recordPass(repo);
		for (const command of [`GIT_DIR=${repo}/.git git commit -am x`, `cd ${repo}; git commit -am x`, `git -C $REPO commit -am x`]) {
			const decision = (await gate(command, parent)).decision;
			assert.equal(decision.action, "block", command);
			assert.match(decision.action === "block" ? decision.reason : "", /cannot be resolved/, command);
		}
	});

	it("reads only the current branch, never the default or protected branches", async () => {
		const repo = nestedRepo();
		await recordPass(repo);
		const calls: string[] = [];
		await evaluateCommitGate({ exec: async (command, args, options) => (calls.push(args.join(" ")), exec(command, args, options)), command: `git -C ${repo} commit -am x`, cwd: parent, forcedTree: undefined });
		assert.deepEqual(calls.filter((call) => call.startsWith("symbolic-ref") || call.includes("refs/heads")), ["symbolic-ref --short -q HEAD"]);
	});
});

describe("verify records (S6)", () => {
	const context = { ts: "2026-11-19T10:00:00.000Z", branch: "feat/x", tree: "T", srcTree: "S", root: "/repo", runId: "run-1", scope: "branch" as const, categories: ["security"] };
	const verdict = (spec: string, v: string) => ({ spec, verdict: v, evidence: "e" });
	const blocker = (summary: string) => ({ summary, reproduction: "r" });
	const structured = (over: Record<string, unknown> = {}) => ({ verdicts: [verdict("S1", "met")], blockers: [], advisories: [], regressionTests: [], scratch: [], unverified: [], ...over });

	it("a clean result is outcome clean with no blockers", () => {
		assert.deepEqual(buildVerifyRecord({ ...context, result: { failed: false, structured: structured() } }), {
			v: 1,
			type: "verify",
			ts: context.ts,
			branch: "feat/x",
			tree: "T",
			srcTree: "S",
			root: "/repo",
			runId: "run-1",
			scope: "branch",
			categories: ["security"],
			blockers: [],
			outcome: "clean",
		});
	});

	it("blockers are listed by the ids the parent reads (B1, B2, ...)", () => {
		const record = buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ blockers: [blocker("a"), blocker("b")] }) } });
		assert.deepEqual([record.outcome, record.blockers], ["blockers", ["B1", "B2"]]);
	});

	it("an unmet or not implemented verdict is outcome blockers even without a blocker entry", () => {
		for (const v of ["unmet", "not implemented"]) {
			const record = buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ verdicts: [verdict("S1", "met"), verdict("S2", v)] }) } });
			assert.deepEqual([record.outcome, record.blockers], ["blockers", ["S2"]], v);
		}
	});

	it("W2: unmet verdicts without blocker entries list the unmet spec ids, never an empty list; blocker entries keep their B ids", () => {
		const record = buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ verdicts: [verdict("S7", "Unmet"), verdict("S2", "met"), verdict("S9", " NOT IMPLEMENTED ")] }) } });
		assert.deepEqual([record.outcome, record.blockers], ["blockers", ["S7", "S9"]]);
		const withBlocker = buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ verdicts: [verdict("S7", "unmet")], blockers: [blocker("a")] }) } });
		assert.deepEqual([withBlocker.outcome, withBlocker.blockers], ["blockers", ["B1"]]);
	});

	it("W2: a payload that is not a complete clean result is unverified, never clean", () => {
		const outcome = (structuredValue: unknown) => buildVerifyRecord({ ...context, result: { failed: false, structured: structuredValue } }).outcome;
		const degenerate: Array<[string, unknown]> = [
			["empty object", {}],
			["empty verdicts, no blockers", { verdicts: [] }],
			["empty verdicts", structured({ verdicts: [] })],
			["verdicts missing", { blockers: [], unverified: [] }],
			["blockers missing", { verdicts: [verdict("S1", "met")] }],
			["blockers not an array", structured({ blockers: "none" })],
			["blockers an object", structured({ blockers: {} })],
			["unverified not an array", structured({ unverified: "x" })],
			["an array payload", [structured()]],
			["unknown verdict", structured({ verdicts: [verdict("S1", "mostly")] })],
			["verdict not a string", structured({ verdicts: [{ spec: "S1", verdict: 1 }] })],
			["verdict entry not an object", structured({ verdicts: ["met"] })],
		];
		for (const [name, value] of degenerate) assert.equal(outcome(value), "unverified", name);
		assert.equal(outcome(structured({ verdicts: [verdict("S1", "MET"), verdict("S2", "Out of scope")] })), "clean", "case-insensitive met and out of scope");
		assert.equal(outcome({ verdicts: [verdict("S1", "met")], blockers: [] }), "clean", "an absent unverified list is nothing unverified");
	});

	it("an unverified verdict or unverified check is outcome unverified; blockers win over it", () => {
		assert.equal(buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ verdicts: [verdict("S1", "unverified")] }) } }).outcome, "unverified");
		assert.equal(buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ unverified: ["tsc: missing"] }) } }).outcome, "unverified");
		assert.equal(buildVerifyRecord({ ...context, result: { failed: false, structured: structured({ unverified: ["x"], blockers: [blocker("a")] }) } }).outcome, "blockers");
	});

	it("a failed run, or a finished run without a payload, never reads as clean", () => {
		assert.deepEqual(buildVerifyRecord({ ...context, result: { failed: true, structured: structured() } }).outcome, "failed");
		assert.equal(buildVerifyRecord({ ...context, result: { failed: true } }).blockers.length, 0);
		assert.equal(buildVerifyRecord({ ...context, result: { failed: false } }).outcome, "unverified");
		assert.equal(buildVerifyRecord({ ...context, result: { failed: false, structured: "junk" } }).outcome, "unverified");
	});

	it("is appended and read back, and an unknown record type is still dropped", () => {
		const dir = mkdtempSync(join(tmpdir(), "brigadev-ev-"));
		const file = join(dir, "evidence", "b.jsonl");
		const record = buildVerifyRecord({ ...context, scope: "recheck", result: { failed: false, structured: structured() } });
		appendEvidence(file, record);
		writeFileSync(file, `${readFileSync(file, "utf8")}${JSON.stringify({ v: 1, type: "mystery", ts: "t" })}\n`);
		assert.deepEqual(readEvidence(file), [record]);
	});

	it("never satisfies the commit gate", () => {
		const record = buildVerifyRecord({ ...context, result: { failed: false, structured: structured() } });
		const input = { dirtyPaths: ["lib/a.ts"], tree: "T", sourceTree: "S", elsewhere: false, records: [record], forcedTree: undefined };
		const gate = decideCommitGate(input);
		assert.equal(gate.action, "block");
		assert.match(gate.action === "block" ? gate.reason : "", /no passing test/);
	});
});
