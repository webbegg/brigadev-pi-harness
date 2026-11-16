// Verifier regression (S6a, S4 merge to main): wrapper spellings that still hide a push or a merge into the default branch.
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

describe("DSP asks for remote forms behind other wrapper spellings", () => {
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
		g("worktree", "add", "-q", "../mainwt", "main");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const cases = [
		"env -S'git push'",
		"env -C ../mainwt git merge feat/x",
		"busybox sh -c 'git push'",
		"busybox git push",
		"toybox sh -c 'git push'",
		"unbuffer git push",
		"chronic git push",
		"taskset 1 git push",
		"tmux new -d 'git push'",
		"screen -dm git push",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}
});
