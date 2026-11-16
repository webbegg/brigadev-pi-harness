// Verifier round 4 (S4, S6, S10): close variants of the round-3 blockers that still run unasked in DSP.
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

describe("DSP round 4: brace reads of credential files and macOS launchers ask", () => {
	const saved = process.env.HOME;
	let dir: string;
	let repo: string;
	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-verify4-")));
		repo = join(dir, "repo");
		const home = join(dir, "home");
		const bare = join(dir, "origin.git");
		mkdirSync(repo);
		mkdirSync(home);
		writeFileSync(join(home, ".git-credentials"), "https://u:p@example.com\n");
		process.env.HOME = home;
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
		g("init", "-q", "-b", "main");
		g("config", "user.name", "t");
		g("config", "user.email", "t@t");
		writeFileSync(join(repo, "a.txt"), "a\n");
		g("add", "-A");
		g("commit", "-qm", "init");
		g("remote", "add", "origin", bare);
		g("checkout", "-qb", "feat/x");
	});
	after(() => {
		saved === undefined ? delete process.env.HOME : (process.env.HOME = saved);
		rmSync(dir, { recursive: true, force: true });
	});

	const cases = [
		// brace expansion of home credential files
		"cat ~/.{git-credentials,npmrc}",
		"cat ~/.{git-credentials,}",
		"cat ~/{.git-credentials,x}",
		// macOS launchers that run their argument as a command
		"arch -x86_64 git push origin feat/x",
		"arch -arm64 git push origin feat/x",
		"taskpolicy git push",
		"taskpolicy -b git push",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}

	for (const command of ["arch", "arch -x86_64 npm test", "taskpolicy -b npm test", "cat {a,b}.txt", "ls ~/{projects,src}"]) {
		it(`still allows local: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.equal(decision.action, "allow", command);
		});
	}
});
