// Verifier regression (S6a): package runners and launchers that run git or an interpreter carrying a remote form.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { decideDspCommand } from "../lib/dsp-policy.ts";

const exec = async (command: string, args: string[], options: { cwd: string }) => {
	try {
		return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 };
	} catch (e: any) {
		return { stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? ""), code: typeof e.status === "number" ? e.status : 1 };
	}
};

describe("DSP asks for remote forms behind package runners", () => {
	let dir: string;
	let repo: string;
	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-verify2-")));
		repo = join(dir, "repo");
		const bare = join(dir, "origin.git");
		mkdirSync(repo);
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
		g("init", "-q", "-b", "main");
		g("config", "user.name", "t");
		g("config", "user.email", "t@t");
		writeFileSync(join(repo, "a.txt"), "a\n");
		
		g("add", "-A");
		g("commit", "-qm", "init");
		g("remote", "add", "origin", bare);
		g("push", "-q", "origin", "main");
		g("remote", "set-head", "origin", "main");
		g("checkout", "-qb", "feat/x");
		
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const cases = [
		"npx git push",
		"npx bash -c 'git push'",
		"npx node -e 'require(\"child_process\").execSync(\"git push\")'",
		"pnpm exec git push",
		"pnpm exec bash -c 'git push'",
		"pnpm dlx bash -c 'git push'",
		"yarn exec git push",
		"npm exec -- git push",
		"npm exec -c 'git push'",
		"bunx git push",
		"bun x git push",
		"uv run git push",
		"uv run bash -c 'git push'",
		"uv run python -c 'import os; os.system(\"git push\")'",
		"poetry run git push",
		"bundle exec git push",
		"bundle exec ruby -e 'system(\"git push\")'",
		"npx gh pr merge 1",
		"uv run gh pr merge 1",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}
});
