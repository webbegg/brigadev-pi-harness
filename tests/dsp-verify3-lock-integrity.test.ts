// Verifier round 3 (S10 text-layer integrity): shell forms that take the credential lock off, or read a credential
// file, without asking.
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

describe("DSP round 3: the credential lock cannot be taken off unasked", () => {
	const saved = process.env.HOME;
	let dir: string;
	let repo: string;
	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-verify3-lock-")));
		repo = join(dir, "repo");
		const home = join(dir, "home");
		mkdirSync(repo);
		mkdirSync(home);
		writeFileSync(join(home, ".git-credentials"), "https://u:p@example.com\n");
		writeFileSync(join(home, ".npmrc"), "//registry.npmjs.org/:_authToken=t\n");
		writeFileSync(join(home, ".bashrc"), "export GH_TOKEN=t\n");
		process.env.HOME = home;
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
		g("init", "-q", "-b", "main");
		g("config", "user.name", "t");
		g("config", "user.email", "t@t");
		writeFileSync(join(repo, "a.txt"), "a\n");
		g("add", "-A");
		g("commit", "-qm", "init");
		g("checkout", "-qb", "feat/x");
	});
	after(() => {
		saved === undefined ? delete process.env.HOME : (process.env.HOME = saved);
		rmSync(dir, { recursive: true, force: true });
	});

	const cases = [
		// assignment / unexport / unset of an override through builtins other than `=`, export, declare, unset NAME
		"read GIT_CONFIG_COUNT <<< 0; git ls-remote origin",
		"IFS= read -r GIT_CONFIG_COUNT <<< 0; git ls-remote origin",
		"printf -v GIT_CONFIG_COUNT %s 0; git ls-remote origin",
		"for GIT_CONFIG_COUNT in 0; do git ls-remote origin; done",
		"export -n GIT_CONFIG_COUNT; git ls-remote origin",
		"typeset +x GIT_CONFIG_COUNT; git ls-remote origin",
		'n=GIT_CONFIG_COUNT; unset "$n"; git ls-remote origin',
		"unset $(echo GIT_CONFIG_COUNT); git ls-remote origin",
		'v=GIT_CONFIG_COUNT; export "$v=0"; git ls-remote origin',
		// interactive and login shells source rc files that export tokens again
		"bash -i -c 'gh pr list'",
		"bash -ic 'gh pr list'",
		"bash -l -c 'gh pr list'",
		"bash --login -c 'gh pr list'",
		"sh -l -c 'gh pr list'",
		"zsh -i -c 'gh pr list'",
		"zsh -ic 'gh pr list'",
		// credential files read through a glob or a recursive read
		"cat ~/.git-cred*",
		"cat ~/.git-credential?",
		"cat ~/.[g]it-credentials",
		"cat ~/.npm?c",
		"grep -r SECRET ~",
		"tar -cf - ~ | strings",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}
});
