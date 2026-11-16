// S10 text-layer integrity (part of S6): in DSP these ask, so the agent cannot take the credential lock off, read the
// credentials it hides, or reach them through another door. Also the controls: the local forms next to them stay allowed.
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

describe("S10 text-layer integrity", () => {
	let dir: string;
	let repo: string;
	let home: string;
	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-lock-integrity-")));
		repo = join(dir, "repo");
		home = join(dir, "home");
		const bare = join(dir, "origin.git");
		mkdirSync(repo);
		mkdirSync(join(repo, "src"));
		mkdirSync(home);
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
		execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
		g("init", "-q", "-b", "main");
		g("config", "user.name", "t");
		g("config", "user.email", "t@t");
		writeFileSync(join(repo, "a.txt"), "a\n");
		writeFileSync(join(repo, "push.sh"), "#!/bin/sh\ngit push origin HEAD\n");
		writeFileSync(join(repo, "sw.sh"), "#!/bin/sh\ngit switch main\n");
		writeFileSync(join(repo, "push.js"), "require(\"child_process\").execSync(\"git push origin HEAD\")\n");
		writeFileSync(join(repo, "spawn.awk"), "BEGIN { system(\"git push\") }\n");
		writeFileSync(join(repo, "plain.awk"), "{ print $1 }\n");
		writeFileSync(join(repo, ".npmrc"), "registry=https://registry.npmjs.org/\n");
		g("add", "-A");
		g("commit", "-qm", "init");
		g("remote", "add", "origin", bare);
		g("push", "-q", "origin", "main");
		g("remote", "set-head", "origin", "main");
		g("checkout", "-qb", "feat/x");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const decide = (command: string) => decideDspCommand({ command, cwd: repo, projectRoot: repo, home, exec: exec as any });
	const asks = (action: string) => action === "confirm-remote" || action === "confirm" || action === "block";

	const askCases: Record<string, string[]> = {
		"assigning or exporting a locked variable": [
			"SSH_AUTH_SOCK=/tmp/agent.sock git fetch",
			"export SSH_AUTH_SOCK=/tmp/agent.sock",
			"export SSH_AGENT_PID=1",
			"GH_CONFIG_DIR=~/.config/gh gh pr view 1",
			"env GH_CONFIG_DIR=$HOME/.config/gh gh pr view 1",
			"GIT_CONFIG_COUNT=0 git fetch",
			"GIT_CONFIG_NOSYSTEM=1 git fetch",
			"GIT_CONFIG_GLOBAL=/dev/null git fetch",
			"export GIT_CONFIG_KEY_0=credential.helper",
			"GIT_SSH_COMMAND='ssh -i k' git fetch",
			"GIT_ASKPASS=/tmp/askpass git fetch",
			"SSH_ASKPASS=/tmp/askpass git fetch",
			"NPM_CONFIG_USERCONFIG=$HOME/.npmrc npm view left-pad",
			"DOCKER_CONFIG=~/.docker docker pull alpine",
			"AWS_SHARED_CREDENTIALS_FILE=~/.aws/credentials aws s3 ls",
			"GH_TOKEN=abc gh pr view 1",
			"GITHUB_TOKEN=abc true",
			"export NPM_TOKEN=abc",
			"NODE_AUTH_TOKEN=abc npm ci",
			"CARGO_REGISTRY_TOKEN=abc cargo build",
			"TWINE_PASSWORD=abc true",
			"AWS_SECRET_ACCESS_KEY=abc true",
			"AWS_ACCESS_KEY_ID=abc true",
			"declare -x MY_API_KEY=abc",
			"bash -c 'export GH_TOKEN=abc; gh pr view 1'",
		],
		"unsetting or clearing the overrides": [
			"unset GH_CONFIG_DIR",
			"unset SSH_ASKPASS GIT_ASKPASS",
			"unset GIT_CONFIG_COUNT",
			"unset NPM_CONFIG_USERCONFIG",
			"env -u GH_CONFIG_DIR gh pr view 1",
			"env --unset=DOCKER_CONFIG docker pull alpine",
			"env -i git fetch",
			"env - git fetch",
			"env --ignore-environment git fetch",
			"exec -c git fetch",
		],
		"programs that hand out credentials": [
			"launchctl getenv SSH_AUTH_SOCK",
			"launchctl asuser 501 git fetch",
			"launchctl export",
			"security find-generic-password -s github -w",
			"security find-internet-password -s github.com",
			"security dump-keychain",
			"security export -t certs",
			"ssh-add -l",
			"ssh-add ~/.ssh/id_ed25519",
			"ssh -i ~/.ssh/key git@github.com",
			"ssh -ikey git@github.com",
			"scp -i key a.txt h:b",
			"gh auth token",
			"gh auth login",
			"gh auth switch",
			"gh auth refresh",
			"gh auth setup-git",
			"gh auth status --show-token",
			"git credential fill",
			"git credential approve",
			"git credential-osxkeychain get",
			"/usr/libexec/git-core/git-credential-osxkeychain get",
		],
		"reading credential files": [
			"cat ~/.config/gh/hosts.yml",
			"cat ~/.git-credentials",
			"head -1 ~/.docker/config.json",
			"cp ~/.netrc /tmp/netrc",
			"grep token ~/.npmrc",
			"cat < ~/.netrc",
			"cat <~/.netrc",
			"cat $HOME/.ssh/id_rsa",
			"cat \"${HOME}/.ssh/id_rsa\"",
			"cat ~/.ssh/*",
			"cd ~/.ssh && cat id_rsa",
			"cd ~ && cat .npmrc",
			"tar cf /tmp/x.tar ~/.ssh",
			"base64 ~/.git-credentials",
			"bash -c 'cat ~/.netrc'",
			"python3 -c \"print(open('/home/me/.ssh/id_rsa').read())\"",
			"node -e \"console.log(require('fs').readFileSync(process.env.HOME + '/.npmrc', 'utf8'))\"",
			"rsync -a ~/.ssh/ /tmp/keys/",
			"docker run --rm -v ~/.ssh:/root/.ssh alpine ls",
			"docker run --rm --mount type=bind,source=$HOME/.netrc,target=/x alpine ls",
		],
		"B8 environment and B7/B5 variables": [
			"GIT_EXTERNAL_DIFF='git push' git diff",
			"GIT_PAGER='git push' git log",
			"GIT_EDITOR='git push' git commit",
			"GIT_SEQUENCE_EDITOR='git push' git rebase -i HEAD~1",
			"EDITOR='git push' git commit",
			"GIT_PROXY_COMMAND='git push' git fetch",
			"GIT_SSH='git push' git fetch",
			"export GIT_SSH_COMMAND='sh -c \"git push\"'",
			"NODE_OPTIONS=--import=./push.js node -e 1",
			"export NODE_OPTIONS='--require ./push.js'",
			"BASH_ENV=push.sh bash -c true",
			"CURL_HOME=$X curl https://api.github.com/x",
			"GIT_EXEC_PATH=/tmp/x git status",
		],
		"B4 launchers": ["tmux send-keys 'git push' Enter", "tmux new-session -d -s x 'git push'", "tmux run-shell 'git push'", "screen -dmS x bash -c 'git push'", "screen -S x -X stuff 'git push\\n'", "env -iS 'git push'", "env -C src git push"],
		"B6 awk": ["awk 'BEGIN{\"git push\" | getline}'", "awk '{print | \"git push\"}'", "gawk 'BEGIN{system(\"git push\")}'", "mawk 'BEGIN{system(\"x\")}'", "awk -f spawn.awk a.txt", "awk -e 'BEGIN{system(\"x\")}'", "awk -F: 'BEGIN{system(\"x\")}' a.txt"],
		"B8/B9 git forms": [
			"git config core.editor 'git push'",
			"git config --global core.pager 'git push; cat'",
			"git config --system core.sshCommand ssh",
			"git config --file x.cfg core.fsmonitor 'git push'",
			"git config sequence.editor 'git push'",
			"git config diff.external 'git push'",
			"git config diff.x.textconv 'git push'",
			"git config filter.x.smudge 'git push'",
			"git config protocol.ext.allow always",
			"git config init.templateDir /tmp/t",
			"git config include.path /tmp/x.cfg",
			"git config includeIf.gitdir:/x/.path /tmp/x.cfg",
			"git config core.hooksPath /tmp/hooks",
			"git config credential.helper store",
			"git config alias.p '!git push'",
			"git config url.x.insteadOf y",
			"git config remote.origin.url /tmp/x",
			"git config push.default current",
			"git clone -c core.sshCommand=ssh x y",
			"git clone -u 'git push' x y",
			"git clone --template=/tmp/t x y",
			"git -c core.pager='git push' log",
			"git -c diff.external='git push' diff",
			"git -c core.pager=\"$P\" log",
			"git mergetool",
			"git difftool -t vimdiff",
			"git filter-branch --msg-filter 'git push' HEAD",
			"git grep -O'git push' x",
			"git --exec-path=/tmp/x status",
			"git archive --remote=x --exec='git push' HEAD",
			"git push --receive-pack='git push' origin",
			"git ls-remote --upload-pack='git push' origin",
			"git clone 'ext::git push' x",
			"git remote add x 'ext::sh -c git% push'",
		],
		"B1 scripts that switch branch": ["bash sw.sh && git reset --hard HEAD~0", "bash sw.sh && git revert HEAD", "bash sw.sh; git cherry-pick HEAD", "bash sw.sh; git am x.patch", "bash sw.sh; git pull", "bash sw.sh; git rebase HEAD"],
	};

	for (const [group, commands] of Object.entries(askCases)) {
		describe(`asks: ${group}`, () => {
			for (const command of commands) {
				it(command, async () => {
					const { decision } = await decide(command);
					assert.ok(asks(decision.action), `${command} -> ${decision.action}`);
				});
			}
		});
	}

	describe("controls: local forms stay allowed", () => {
		const allowed = [
			"npx vitest run",
			"npx --yes prettier --check .",
			"uv run pytest",
			"uv run python script.py",
			"pnpm exec tsc --noEmit",
			"pnpm dlx cowsay hi",
			"npm exec -- eslint .",
			"yarn exec jest",
			"bunx tsc",
			"poetry run pytest",
			"bundle exec rspec",
			"env -C src ls",
			"env -C src -u HOME ls",
			"env FOO=bar ls",
			"env -S 'ls -la'",
			"busybox ls",
			"unbuffer ls",
			"taskset 1 ls",
			"taskset -c 0 ls",
			"tmux ls",
			"screen -ls",
			"awk '{print $1}' a.txt",
			"awk -F: '{ if ($1 == \"x\" || $2) print $2 }' a.txt",
			"awk '/git push/ {print}' a.txt",
			"awk -f plain.awk a.txt",
			"git config user.name x",
			"git config --global user.email x@y.z",
			"git config --get core.fsmonitor",
			"git config --list",
			"git -c core.pager=cat log",
			"git -c core.editor=vim status",
			"git -c core.fsmonitor=false status",
			"git submodule foreach git status",
			"git bisect run npm test",
			"git fetch --upload-pack=git-upload-pack origin",
			"git difftool --tool-help",
			"GIT_TERMINAL_PROMPT=0 git fetch",
			"GIT_PAGER=cat git log",
			"PAGER=less git log",
			"EDITOR=vim git status",
			"NODE_ENV=test node -e 1",
			"NODE_OPTIONS=--max-old-space-size=4096 node -e 1",
			"node -r dotenv/config -e 1",
			"docker run -e API_KEY=abc img",
			"unset FOO",
			"env -u HOME ls",
			"ls ~/.ssh",
			"echo ~/.ssh",
			"cat .npmrc",
			"git add .npmrc",
			"curl https://example.com",
			"wget -e robots=off https://example.com",
			"cat README.md",
		];
		for (const command of allowed) {
			it(command, async () => {
				const { decision } = await decide(command);
				assert.equal(decision.action, "allow", `${command} -> ${JSON.stringify(decision)}`);
			});
		}

		it("git rebase main on a feature branch (main is the known default) runs after a backup", async () => {
			const { decision } = await decide("git rebase main");
			assert.equal(decision.action, "allow-with-backup");
		});
		it("git rebase -x with a local command runs after a backup", async () => {
			const { decision } = await decide("git rebase -x 'npm test' HEAD");
			assert.equal(decision.action, "allow-with-backup");
		});
		it("git rebase main feat/x names the feature branch: still allowed after a backup", async () => {
			const { decision } = await decide("git rebase main feat/x");
			assert.equal(decision.action, "allow-with-backup");
		});
	});

	describe("the label says what was recognised", () => {
		it("a credential change is a remote-style question", async () => {
			const { decision } = await decide("GH_TOKEN=abc gh pr view 1");
			assert.equal(decision.action, "confirm-remote");
			if (decision.action === "confirm-remote") assert.ok(decision.items.some((item) => /credential environment change/.test(item.label) && item.ref === "GH_TOKEN"), JSON.stringify(decision.items));
		});
		it("a credential file read names the file", async () => {
			const { decision } = await decide("cat ~/.git-credentials");
			assert.equal(decision.action, "confirm-remote");
			if (decision.action === "confirm-remote") assert.ok(decision.items.some((item) => /credential access/.test(item.label) && item.ref === "~/.git-credentials"), JSON.stringify(decision.items));
		});
	});
});
