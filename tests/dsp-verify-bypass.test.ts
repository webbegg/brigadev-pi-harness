// Verifier regressions: forms that DSP must never auto-allow (S4 merge to main, push forms; S6 wrappers, inline code, raw network).
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

describe("DSP never auto-allows these remote or default-branch forms", () => {
	let dir: string;
	let repo: string;
	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-verify-")));
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
		// S4: merge to main after a switch in the same command; push forms.
		"git switch main; git merge feat/x",
		"git checkout main && git merge feat/x",
		"git switch main && git cherry-pick abc123",
		"git checkout main && git rebase feat/x",
		"git send-pack origin main",
		"git remote-https origin https://example.com/x.git",
		// S6a: runners that take the command from stdin or an argument.
		"echo push | xargs git",
		"echo push | xargs -I{} git {}",
		"xargs -I{} git {} <<< push",
		"bash <<< 'git push'",
		"sh <<< \"git push\"",
		"script -c 'git push' /dev/null",
		"script -q /dev/null git push",
		"su -c 'git push'",
		"su me -c 'git push'",
		"parallel ::: 'git push'",
		"parallel git push ::: origin",
		"osascript -e 'do shell script \"git push\"'",
		// S6b: inline code that spawns processes cannot be decided textually.
		"python3 -c \"import os; os.system('g'+'it push')\"",
		"node -e 'require(\"child_process\").execSync(\"gi\"+\"t push\")'",
		"perl -e 'system(\"g\".\"it push\")'",
		// Curl config files can carry write options.
		"curl -K cfg https://api.github.com/x",
		// Raw remote access is remote work too.
		"ssh deploy@example.com 'git pull'",
		"scp build.tar deploy@example.com:/srv/",
		"rsync -a dist/ deploy@example.com:/srv/",
		"nc example.com 80 < req.txt",
		"exec 3<>/dev/tcp/example.com/80",
	];
	for (const command of cases) {
		it(`asks for: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.ok(decision.action === "confirm-remote" || decision.action === "confirm" || decision.action === "block", `${command} -> ${decision.action}`);
		});
	}

	const local = ["git merge feat/y", "rsync -a src/ backup/", "python3 -c 'print(1+1)'", "node -e 'console.log(JSON.stringify({a:1}))'", "echo a b | xargs -n1 echo"];
	for (const command of local) {
		it(`still allows local: ${command}`, async () => {
			const { decision } = await decideDspCommand({ command, cwd: repo, projectRoot: repo, exec: exec as any });
			assert.equal(decision.action, "allow", command);
		});
	}
});
