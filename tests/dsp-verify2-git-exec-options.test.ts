// Verifier regression (S6a): git options and subcommands that run a command string (sshCommand, upload-pack, ext::, fsmonitor, rebase -x, submodule foreach, bisect run, difftool -x).
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

describe("DSP asks for git forms that execute a command string", () => {
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
		"git -c core.sshCommand='sh -c \"git push\"' fetch",
		"GIT_SSH_COMMAND='sh -c \"git push\"' git fetch",
		"git fetch --upload-pack='git push' origin",
		"git -c protocol.ext.allow=always fetch 'ext::sh -c git% push'",
		"git -c core.fsmonitor='git push origin HEAD; true' status",
		"git rebase -x 'git push origin HEAD' HEAD",
		"git rebase --exec 'git push' HEAD",
		"git submodule foreach git push",
		"git bisect run git push",
		"git difftool -y -x 'git push'",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}
});
