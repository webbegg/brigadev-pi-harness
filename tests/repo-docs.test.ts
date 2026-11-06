import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { loadOrchestratorPrompt } from "../extensions/orchestrator.ts";
import { brigadevHome, isRepoDocsPath, repoDocsDir, repoName } from "../lib/repo-docs.ts";

// Real git must not inherit the caller's GIT_* variables or global signing and hook settings.
const cleanEnv = (): NodeJS.ProcessEnv => Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")));
const ISOLATED_GIT = ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "init.defaultBranch=main"];
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...ISOLATED_GIT, ...args], { cwd, stdio: "pipe", env: cleanEnv() });

describe("repo docs folder", () => {
	let scratch: string;
	let main: string;
	let worktree: string;
	let plain: string;
	const home = "/tmp/brigadev-home-for-tests";
	// The resolver runs git with the process environment, so the GIT_* variables are removed from it for these tests.
	const inheritedGitEnv = Object.entries(process.env).filter(([name]) => name.startsWith("GIT_"));

	before(() => {
		for (const [name] of inheritedGitEnv) delete process.env[name];
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "repo-docs-")));
		main = join(scratch, "my-repo");
		worktree = join(scratch, "my-repo-feature");
		plain = join(scratch, "not-a-repo");
		mkdirSync(join(main, "src"), { recursive: true });
		mkdirSync(plain);
		git(main, "init", "-q");
		git(main, "commit", "-q", "--allow-empty", "-m", "init");
		git(main, "worktree", "add", "-q", worktree, "-b", "feat/x");
	});

	after(() => {
		rmSync(scratch, { recursive: true, force: true });
		for (const [name, value] of inheritedGitEnv) process.env[name] = value;
	});

	it("names the folder after the main worktree root", () => {
		assert.equal(repoName(main), "my-repo");
		assert.equal(repoName(join(main, "src")), "my-repo");
	});

	it("shares one folder between a repository and its worktrees", () => {
		assert.equal(repoName(worktree), "my-repo");
		assert.equal(repoDocsDir(worktree, { BRIGADEV_HOME: home }), repoDocsDir(main, { BRIGADEV_HOME: home }));
		assert.equal(repoDocsDir(worktree, { BRIGADEV_HOME: home }), join(home, "my-repo"));
	});

	it("falls back to the directory name outside git", () => {
		assert.equal(repoName(plain), "not-a-repo");
		assert.equal(repoDocsDir(plain, { BRIGADEV_HOME: home }), join(home, "not-a-repo"));
	});

	it("falls back to the directory name when the directory does not exist", () => {
		assert.equal(repoName(join(scratch, "missing-dir")), "missing-dir");
	});

	it("is named in the orchestrator prompt, resolved for the session's directory", () => {
		const saved = process.env.BRIGADEV_HOME;
		process.env.BRIGADEV_HOME = home;
		try {
			const prompt = loadOrchestratorPrompt(worktree);
			assert.ok(prompt.includes(join(home, "my-repo")), "prompt names the repo docs folder");
			assert.ok(!prompt.includes("{{"), "no placeholder is left unresolved");
			assert.ok(!prompt.includes("odd/tasks"));
		} finally {
			if (saved === undefined) delete process.env.BRIGADEV_HOME;
			else process.env.BRIGADEV_HOME = saved;
		}
	});

	it("honors BRIGADEV_HOME and defaults to ~/.brigadev", () => {
		assert.equal(brigadevHome({ BRIGADEV_HOME: home }), home);
		assert.equal(brigadevHome({ BRIGADEV_HOME: "~/custom" }), join(homedir(), "custom"));
		assert.equal(brigadevHome({}), join(homedir(), ".brigadev"));
		assert.equal(brigadevHome({ BRIGADEV_HOME: "" }), join(homedir(), ".brigadev"));
	});
});

describe("isRepoDocsPath", () => {
	const docs = join(tmpdir(), "brigadev-docs-rule", "my-repo");

	it("accepts the folder and anything inside it", () => {
		assert.equal(isRepoDocsPath(docs, docs), true);
		assert.equal(isRepoDocsPath(docs, join(docs, "tasks", "feature.md")), true);
		assert.equal(isRepoDocsPath(docs, join(docs, "reviews", "r1.md")), true);
	});

	it("rejects other repositories' folders, look-alike names, and traversal", () => {
		assert.equal(isRepoDocsPath(docs, join(docs, "..", "other-repo", "tasks", "x.md")), false);
		assert.equal(isRepoDocsPath(docs, `${docs}-evil/tasks/x.md`), false);
		assert.equal(isRepoDocsPath(docs, join(docs, "..", "x.md")), false);
		assert.equal(isRepoDocsPath(docs, join(tmpdir(), "elsewhere.md")), false);
	});
});
