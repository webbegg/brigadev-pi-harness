// Verifier round 3 (S4, S6a/b): close variants of B1–B9 that still run a push unasked in DSP.
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

describe("DSP round 3: remote forms behind wrappers the classifier still allows", () => {
	let dir: string;
	let repo: string;
	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-verify3-")));
		repo = join(dir, "repo");
		const bare = join(dir, "origin.git");
		mkdirSync(repo);
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
		g("init", "-q", "-b", "main");
		g("config", "user.name", "t");
		g("config", "user.email", "t@t");
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "push.js"), "require('child_process').execSync('git push')\n");
		g("add", "-A");
		g("commit", "-qm", "init");
		g("remote", "add", "origin", bare);
		g("push", "-q", "origin", "main");
		g("remote", "set-head", "origin", "main");
		g("checkout", "-qb", "feat/x");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const cases = [
		// B (git options that run a command string): bisect run through a shell
		"git bisect run sh -c 'git push'",
		"git bisect run bash -c 'git push'",
		// B (inline code that starts processes): editors
		"vim -es -c '!git push' -c q",
		"ex -c '!git push' -c q",
		// B (package runners / preloads)
		"pnpx git push",
		"bun --preload ./push.js -e 1",
		"mise x -- git push",
		"mise exec -- git push",
		"direnv exec . git push",
		"nix-shell --run 'git push'",
		"nix develop -c git push",
		"conda run git push",
		"devbox run git push",
		"pixi run git push",
		"asdf exec git push",
		// B (wrappers)
		"at now <<< 'git push'",
		"batch <<< 'git push'",
		"chrt 1 git push",
		"systemd-run git push",
		"firejail git push",
		"numactl -C 0 git push",
		// B (HTTP clients)
		"curlie -X POST https://api.github.com/repos/a/b/issues",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}
});
