import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { repoDocsDir } from "../lib/repo-docs.ts";

const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, stdio: "pipe" });

describe("repo docs folder through a symlinked checkout", () => {
	const scratch = realpathSync(mkdtempSync(join(tmpdir(), "repo-docs-link-")));
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("shares one folder between the checkout and its worktrees", () => {
		const real = join(scratch, "data", "app");
		mkdirSync(real, { recursive: true });
		git(real, "init", "-q");
		git(real, "commit", "-q", "--allow-empty", "-m", "init");
		const link = join(scratch, "app-link");
		symlinkSync(real, link);
		git(link, "worktree", "add", "-q", ".worktrees/feature", "-b", "feat/x");
		const env = { BRIGADEV_HOME: "/tmp/brigadev-home-for-tests" };
		assert.equal(repoDocsDir(link, env), repoDocsDir(join(link, ".worktrees/feature"), env));
		assert.equal(repoDocsDir(link, env), repoDocsDir(real, env));
	});
});
