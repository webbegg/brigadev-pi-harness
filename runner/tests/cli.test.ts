// A5: the CLI's refusal paths. No model is ever called: every case ends before a runner opens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { docText, git, isolateEnv, makeWorkspace, type Workspace } from "./fixture.ts";

let dir: string;
let restoreEnv: () => void;
before(() => {
	restoreEnv = isolateEnv().restore;
});
after(() => restoreEnv());
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-runner-cli-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string | undefined> = {}, cwd = dir) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, env, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, cwd);
	return { code, stdout, stderr };
}

function writeDoc(lines: string[]): string {
	const path = join(dir, "feature.md");
	writeFileSync(path, docText(lines));
	return path;
}

const VALID = "- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending";

/** A main checkout (on a feature branch) plus a linked worktree of it on `branch` (new branch off the current one), or detached. */
function withWorktree(ws: Workspace, branch: string | "detached" | { existing: string }): string {
	const path = join(ws.root, "repo-runner");
	if (branch === "detached") git(ws.repo, "worktree", "add", "-q", "--detach", path);
	else if (typeof branch === "object") git(ws.repo, "worktree", "add", "-q", path, branch.existing);
	else git(ws.repo, "worktree", "add", "-q", "-b", branch, path);
	return realpathSync(path);
}

describe("brigadev-runner start", () => {
	it("exits 1 and prints the errors for an invalid doc (no ticket list)", async () => {
		const path = join(dir, "feature.md");
		writeFileSync(path, "# Feature\n\n## Specs\n- S1: x\n");
		const result = await cli(["start", path]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /no tickets under ## Tasks/);
	});

	it("lists every error, including the runner-only `done: is not a command`", async () => {
		const path = writeDoc([VALID, "- T2 [S1] inline: x deps: none done: it looks right — pending", "- T3 [S1] inline: y deps: T9 — pending"]);
		const result = await cli(["start", path]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /T2 done: is not a command/);
		assert.match(result.stderr, /T3 has no done: check/);
		assert.match(result.stderr, /T3 depends on unknown T9/);
	});

	it("validates the doc before looking at the worktree", async () => {
		const path = writeDoc(["- T1 [S1] inline: x deps: none — pending"]);
		const result = await cli(["start", path]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /T1 has no done: check/);
		assert.doesNotMatch(result.stderr, /worktree/);
	});

	it("no longer knows BRIGADEV_RUNNER_UNGUARDED: the variable neither opens nor closes the gate", async () => {
		const path = writeDoc([VALID]);
		for (const env of [{}, { BRIGADEV_RUNNER_UNGUARDED: "1" }]) {
			const result = await cli(["start", path], env);
			assert.equal(result.code, 1);
			assert.doesNotMatch(result.stderr, /UNGUARDED/);
			assert.match(result.stderr, /not a git repository/);
		}
	});

	describe("Q5: the runner needs its own worktree on a feature branch", () => {
		let ws: Workspace;
		beforeEach(() => {
			ws = makeWorkspace();
		});
		afterEach(() => ws.cleanup());

		it("refuses a directory that is not a git repository", async () => {
			const result = await cli(["start", writeDoc([VALID])], {}, dir);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /not a git repository/);
			assert.equal(result.stdout, "");
		});

		it("refuses the main checkout, even on a feature branch, and says how to create a worktree", async () => {
			const result = await cli(["start", writeDoc([VALID])], {}, ws.repo);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /is not a linked git worktree/);
			assert.match(result.stderr, /git worktree add \.\.\/repo-runner -b <branch>/);
			assert.equal(result.stdout, "");
		});

		it("refuses a linked worktree on the default branch", async () => {
			const worktree = withWorktree(ws, { existing: "main" });
			const result = await cli(["start", writeDoc([VALID])], {}, worktree);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /branch main is the default or a protected branch/);
			assert.match(result.stderr, /git worktree add \.\.\/repo-runner -b <branch>/);
		});

		it("refuses a linked worktree on a protected branch (master, when it exists)", async () => {
			git(ws.repo, "branch", "master");
			const worktree = withWorktree(ws, { existing: "master" });
			const result = await cli(["start", writeDoc([VALID])], {}, worktree);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /branch master is the default or a protected branch/);
		});

		it("refuses a detached HEAD", async () => {
			const worktree = withWorktree(ws, "detached");
			const result = await cli(["start", writeDoc([VALID])], {}, worktree);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /detached HEAD/);
		});

		it("accepts a linked worktree on a feature branch: it gets as far as the API key check", async () => {
			const worktree = withWorktree(ws, "feat/runner-wt");
			const result = await cli(["start", writeDoc([VALID])], { HOME: dir }, worktree);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /ANTHROPIC_API_KEY/);
			assert.doesNotMatch(result.stderr, /worktree|branch/);
		});
	});

	it("exits 1 for a missing doc and 2 for usage errors", async () => {
		assert.equal((await cli(["start", join(dir, "missing.md")])).code, 1);
		const usage = await cli(["start"]);
		assert.equal(usage.code, 2);
		assert.match(usage.stderr, /usage: brigadev-runner start <feature-doc>/);
		assert.equal((await cli(["frobnicate"])).code, 2);
	});

	it("runs as a script: `node runner/src/cli.ts start <doc>` exits 1 for an invalid doc", () => {
		const path = join(dir, "feature.md");
		writeFileSync(path, "# Feature\n");
		const script = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = spawnSync(process.execPath, [script, "start", path], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no tickets under ## Tasks/);
	});
});
