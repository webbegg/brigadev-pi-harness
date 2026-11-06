import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { type BranchFacts, decideWithBranchRule, parseOriginHead, pickDefaultBranch, readBranchFacts } from "../lib/commit-branch.ts";
import { PERMISSION_MODE, type PermissionMode } from "../lib/permission-policy.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";

const FEATURE: BranchFacts = { currentBranch: "feat/x", defaultBranch: "main" };

async function decide(command: string, facts: BranchFacts = FEATURE, mode: PermissionMode = PERMISSION_MODE.NORMAL, isChild = false) {
	let reads = 0;
	const decision = await decideWithBranchRule(classifyCommand(command), mode, isChild, async () => {
		reads++;
		return facts;
	});
	return { action: decision.action, reason: "reason" in decision ? decision.reason : "", reads };
}

describe("commits on feature branches", () => {
	it("run without asking in normal mode, amend included", async () => {
		assert.equal((await decide("git commit -m 'feat: x'")).action, "allow");
		assert.equal((await decide("git commit --amend --no-edit")).action, "allow");
		assert.equal((await decide("git add -A && git commit -m x")).action, "allow");
	});

	it("still ask on the default branch", async () => {
		assert.equal((await decide("git commit -m x", { currentBranch: "main", defaultBranch: "main" })).action, "confirm");
	});

	it("still ask on a detached HEAD", async () => {
		assert.equal((await decide("git commit -m x", { currentBranch: null, defaultBranch: "main" })).action, "confirm");
	});

	it("still ask when the default branch is unknown", async () => {
		assert.equal((await decide("git commit -m x", { currentBranch: "feat/x", defaultBranch: null })).action, "confirm");
	});

	it("still ask when the commit runs in another directory", async () => {
		for (const command of [
			"cd ../other && git commit -m x",
			"cd /tmp/x; git commit -m x",
			"git -C ../other commit -m x",
			"git --git-dir=../other/.git commit -m x",
			"git --work-tree ../other commit -m x",
			"GIT_DIR=../other/.git git commit -m x",
			"export GIT_WORK_TREE=../other && git commit -m x",
			"env GIT_DIR=../other/.git git commit -m x",
			"git -c core.worktree=../other commit -m x",
			"pushd ../other && git commit -m x",
			"cd ../other && bash -c 'git commit -m x'",
		]) {
			assert.equal((await decide(command)).action, "confirm", command);
		}
	});

	it("still ask when a git-location variable redirects the commit", async () => {
		for (const command of [
			"GIT_COMMON_DIR=../other/.git git commit -m x",
			"GIT_INDEX_FILE=../other/index git commit -m x",
			"env GIT_COMMON_DIR=../other/.git git commit -m x",
			"export GIT_DIR=../other/.git && git commit -m x",
			"export GIT_COMMON_DIR=../other/.git; git commit -m x",
			"export GIT_INDEX_FILE=../other/index && git commit -m x",
			"GIT_DIR=../other/.git; git commit -m x",
			"declare -x GIT_WORK_TREE=../other && git commit -m x",
			"GIT_COMMON_DIR=../other/.git bash -c 'git commit -m x'",
			"GIT_INDEX_FILE=../other/index sh -c 'git add -A && git commit -m x'",
			"env GIT_DIR=../other/.git GIT_WORK_TREE=../other bash -c 'git commit -m x'",
			"export GIT_DIR=../other/.git && bash -c 'git commit -m x'",
			"bash -c 'export GIT_DIR=../other/.git && git commit -m x'",
		]) {
			assert.equal((await decide(command)).action, "confirm", command);
		}
	});

	it("still ask when an earlier step can switch the branch", async () => {
		for (const command of [
			"git checkout main && git commit -m x",
			"git switch main && git commit -m x",
			"git branch -m main && git commit -m x",
			"git reset --soft main && git commit -m x",
			"bash -c 'git checkout main' && git commit -m x",
			"gh pr checkout 5 && git commit -m x",
		]) {
			assert.equal((await decide(command)).action, "confirm", command);
		}
	});

	it("still ask for a push chained after the commit", async () => {
		const result = await decide("git commit -m x && git push");
		assert.equal(result.action, "confirm");
		assert.match(result.reason, /git push/);
		assert.doesNotMatch(result.reason, /git commit/);
	});

	it("still ask for other kinds chained with the commit", async () => {
		assert.equal((await decide("git commit -m x && npm install")).action, "confirm");
		assert.equal((await decide("git commit -m x && gh pr create --fill")).action, "confirm");
		assert.equal((await decide("rm -rf build && git commit -m x")).action, "confirm");
	});

	it("do not read branch facts unless a plain commit is present", async () => {
		assert.equal((await decide("npm test")).reads, 0);
		assert.equal((await decide("git push")).reads, 0);
		assert.equal((await decide("cd ../other && git commit -m x")).reads, 0);
		assert.equal((await decide("git commit -m x", FEATURE, PERMISSION_MODE.YOLO)).reads, 0);
		assert.equal((await decide("git commit -m x", FEATURE, PERMISSION_MODE.NORMAL, true)).reads, 0);
		assert.equal((await decide("git commit -m x")).reads, 1);
	});
});

describe("the rule leaves other decisions alone", () => {
	it("keeps yolo as it was", async () => {
		assert.equal((await decide("git commit -m x", FEATURE, PERMISSION_MODE.YOLO)).action, "allow");
		assert.equal((await decide("git commit -m x", { currentBranch: "main", defaultBranch: "main" }, PERMISSION_MODE.YOLO)).action, "allow");
		assert.equal((await decide("git push --force", FEATURE, PERMISSION_MODE.YOLO)).action, "confirm");
	});

	it("keeps blocking commits in subagents, on any branch", async () => {
		assert.equal((await decide("git commit -m x", FEATURE, PERMISSION_MODE.NORMAL, true)).action, "block");
		assert.equal((await decide("git commit -m x", FEATURE, PERMISSION_MODE.YOLO, true)).action, "block");
	});

	it("keeps hard-deny forms blocked next to a free commit", async () => {
		assert.equal((await decide("git commit -m x && rm -rf ~")).action, "block");
		assert.equal((await decide("rm -rf ~", FEATURE, PERMISSION_MODE.YOLO)).action, "block");
	});

	it("still asks for destructive commands in normal mode", async () => {
		assert.equal((await decide("git reset --hard")).action, "confirm");
	});
});

describe("classifyCommand commit details", () => {
	it("marks commits and where they may run, without changing kind or reason", () => {
		const [plain] = classifyCommand("git commit -m x");
		assert.deepEqual(plain, { kind: "delivery", reason: "git commit", commit: true });
		const [amend] = classifyCommand("git commit --amend");
		assert.equal(amend.reason, "git commit --amend");
		const [moved] = classifyCommand("git -C ../x commit -m y");
		assert.deepEqual(moved, { kind: "delivery", reason: "git commit", commit: true, elsewhere: true });
	});

	it("leaves other matches without the new fields", () => {
		assert.deepEqual(classifyCommand("git push"), [{ kind: "delivery", reason: "git push" }]);
		assert.deepEqual(classifyCommand("cd x && git push"), [{ kind: "delivery", reason: "git push" }]);
	});
});

describe("default branch", () => {
	it("strips the remote from origin/HEAD", () => {
		assert.equal(parseOriginHead("origin/main\n"), "main");
		assert.equal(parseOriginHead("origin/release/1.x"), "release/1.x");
		assert.equal(parseOriginHead(""), null);
		assert.equal(parseOriginHead("main"), null);
		assert.equal(parseOriginHead("upstream/main"), null);
	});

	it("prefers origin/HEAD, then a lone main or master, else unknown", () => {
		assert.equal(pickDefaultBranch({ originHead: "trunk", hasMain: true, hasMaster: true }), "trunk");
		assert.equal(pickDefaultBranch({ originHead: null, hasMain: true, hasMaster: false }), "main");
		assert.equal(pickDefaultBranch({ originHead: null, hasMain: false, hasMaster: true }), "master");
		assert.equal(pickDefaultBranch({ originHead: null, hasMain: true, hasMaster: true }), null);
		assert.equal(pickDefaultBranch({ originHead: null, hasMain: false, hasMaster: false }), null);
		assert.equal(pickDefaultBranch({ originHead: null, hasMain: null, hasMaster: true }), null);
		assert.equal(pickDefaultBranch({ originHead: null, hasMain: true, hasMaster: null }), null);
	});
});

describe("readBranchFacts", () => {
	const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
	const fail = (code: number) => ({ stdout: "", stderr: "", code });

	function fakeGit(answers: Record<string, ReturnType<typeof ok> | Error>): ExecFn {
		return async (_command, args) => {
			const answer = answers[args.join(" ")];
			if (answer === undefined) return fail(128);
			if (answer instanceof Error) throw answer;
			return answer;
		};
	}

	const HEAD = "symbolic-ref --short -q HEAD";
	const ORIGIN = "symbolic-ref --short refs/remotes/origin/HEAD";
	const MAIN = "rev-parse --verify --quiet refs/heads/main";
	const MASTER = "rev-parse --verify --quiet refs/heads/master";

	it("reads the branch and origin/HEAD", async () => {
		const facts = await readBranchFacts(fakeGit({ [HEAD]: ok("feat/x\n"), [ORIGIN]: ok("origin/main\n") }), "/repo");
		assert.deepEqual(facts, { currentBranch: "feat/x", defaultBranch: "main" });
	});

	it("falls back to a lone local main when origin/HEAD is not set", async () => {
		const facts = await readBranchFacts(fakeGit({ [HEAD]: ok("feat/x\n"), [MAIN]: ok("abc\n"), [MASTER]: fail(1) }), "/repo");
		assert.deepEqual(facts, { currentBranch: "feat/x", defaultBranch: "main" });
	});

	it("reports a detached HEAD as no branch", async () => {
		const facts = await readBranchFacts(fakeGit({ [HEAD]: fail(1), [ORIGIN]: ok("origin/main") }), "/repo");
		assert.equal(facts.currentBranch, null);
	});

	it("fails closed when git fails or throws", async () => {
		assert.deepEqual(await readBranchFacts(fakeGit({}), "/repo"), { currentBranch: null, defaultBranch: null });
		const boom = fakeGit({ [HEAD]: new Error("spawn git ENOENT"), [ORIGIN]: new Error("spawn git ENOENT"), [MAIN]: new Error("x"), [MASTER]: new Error("x") });
		assert.deepEqual(await readBranchFacts(boom, "/repo"), { currentBranch: null, defaultBranch: null });
	});

	it("does not guess a default branch when a main/master lookup fails", async () => {
		const facts = await readBranchFacts(fakeGit({ [HEAD]: ok("main\n"), [MAIN]: new Error("timeout"), [MASTER]: ok("abc") }), "/repo");
		assert.equal(facts.defaultBranch, null);
	});
});

describe("readBranchFacts against real git", () => {
	const run = promisify(execFile);
	const realExec: ExecFn = async (command, args, options) => {
		try {
			const { stdout, stderr } = await run(command, args, { cwd: options.cwd, timeout: options.timeout });
			return { stdout, stderr, code: 0 };
		} catch (error) {
			const failure = error as { stdout?: string; stderr?: string; code?: number };
			return { stdout: failure.stdout ?? "", stderr: failure.stderr ?? "", code: typeof failure.code === "number" ? failure.code : 1 };
		}
	};
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "commit-branch-")));
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: dir, stdio: "pipe" });
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("tells a feature branch, the default branch, and a detached HEAD apart", async () => {
		git("init", "-q", "-b", "main");
		git("commit", "-q", "--allow-empty", "-m", "init");
		assert.deepEqual(await readBranchFacts(realExec, dir), { currentBranch: "main", defaultBranch: "main" });
		git("switch", "-q", "-c", "feat/x");
		assert.deepEqual(await readBranchFacts(realExec, dir), { currentBranch: "feat/x", defaultBranch: "main" });
		git("switch", "-q", "--detach");
		assert.deepEqual(await readBranchFacts(realExec, dir), { currentBranch: null, defaultBranch: "main" });
	});

	it("does not guess in a directory that is not a repository", async () => {
		const plain = realpathSync(mkdtempSync(join(tmpdir(), "commit-branch-plain-")));
		try {
			assert.deepEqual(await readBranchFacts(realExec, plain), { currentBranch: null, defaultBranch: null });
		} finally {
			rmSync(plain, { recursive: true, force: true });
		}
	});
});
