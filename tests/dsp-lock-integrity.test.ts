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
		writeFileSync(join(repo, "justfile"), "build:\n\tnpm run build\n\nship: build\n\t@git push origin HEAD\n");
		writeFileSync(join(repo, "x.sed"), "e git push\n");
		writeFileSync(join(repo, "push.vim"), "set nu\n!git push\n");
		writeFileSync(join(repo, "ok.vim"), "set nu\n%s/a/b/g\n");
		writeFileSync(join(repo, "ok.sed"), "s/a/b/g\n");
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
		// Round 3, rule 1: builtins that assign, unexport or unset a variable, and names the guard cannot read.
		"round 3: builtins that assign": [
			"read -a GIT_CONFIG_COUNT <<< 0; git ls-remote origin",
			"read -r -d '' GH_TOKEN <<< x",
			"read -rp 'x? ' GIT_CONFIG_COUNT",
			"mapfile GIT_CONFIG_COUNT < /dev/null",
			"readarray -t GIT_CONFIG_COUNT < /dev/null",
			"getopts ab GIT_CONFIG_COUNT -a",
			"select GIT_CONFIG_COUNT in 0; do break; done",
			"declare +x GIT_CONFIG_COUNT",
			"declare -g GIT_CONFIG_COUNT",
			"local -g GIT_CONFIG_COUNT",
			"typeset -x GIT_CONFIG_COUNT",
			"readonly GIT_CONFIG_COUNT",
			"declare -n r=GIT_CONFIG_COUNT",
			"let GIT_CONFIG_COUNT=0",
			"((GIT_CONFIG_COUNT=0))",
			": ${GIT_CONFIG_COUNT:=0}",
			"export -n SSH_AUTH_SOCK",
			"unset -v \"$n\"",
			"export \"$v=0\"",
			"declare \"$v=0\"",
			"typeset \"$v\"",
			"readonly \"$v\"",
			"local \"$v\"",
			"export $(echo GIT_CONFIG_COUNT=0)",
			"env \"$v=0\" git ls-remote origin",
			"wait -p GIT_CONFIG_COUNT",
			"bash -c 'read GIT_CONFIG_COUNT <<< 0'",
		],
		// Round 3, rule 2: shells that load startup files.
		"round 3: interactive and login shells, rc loading": [
			"bash -il",
			"sh -lc 'gh pr list'",
			"dash -i",
			"ksh -l -c true",
			"fish -l -c true",
			"fish --interactive -c true",
			"zsh --login -c true",
			"bash --rcfile /tmp/rc -c true",
			"bash --init-file=/tmp/rc -c true",
			"env bash -ic true",
			"exec -l bash",
			"exec -cl bash",
			"ENV=/tmp/rc sh",
			"BASH_ENV=/tmp/rc npm test",
			"export BASH_ENV=/tmp/rc",
			"ZDOTDIR=/tmp/z zsh -c true",
			"xargs -n1 bash -lc <<< true",
		],
		// Round 3, rule 3: reads of credential and startup files by glob, by tree, and by process environment.
		"round 3: glob and recursive reads": [
			"cat ~/.git-cred*",
			"cat $HOME/.git-cred*",
			"cat ${HOME}/.git-cred*",
			"cat ~/.config/g*/hosts.yml",
			"cat ~/.ssh/id_*",
			"cat ~/.aws/cred?ntials",
			"cat ~/.docker/conf*",
			"cat ~/.[bz]*rc",
			"cat <~/.git-cred*",
			"cd ~ && cat .git-cred*",
			"grep -r SECRET ~",
			"grep -rn SECRET ~/",
			"grep -R -e SECRET $HOME",
			"grep --recursive SECRET ${HOME}",
			"grep -r x ~/.config",
			"rg SECRET ~",
			"ag SECRET ~",
			"tar -c ~ | strings",
			"tar czf /tmp/x.tgz ~",
			"tar --create --file=/tmp/x.tar ~/.config",
			"cp -r ~ /tmp/x",
			"cp -a ~/.config /tmp/x",
			"rsync ~/ /tmp/x",
			"rsync -a ~ /tmp/x/",
			"zip -r /tmp/x.zip ~",
			"7z a /tmp/x.7z ~",
			"ditto ~ /tmp/x",
			"find ~ -name '*.pem' -exec cat {} +",
			"find ~ -type f | xargs cat",
			"find ~/.config -type f -print0 | xargs -0 cat",
			"cat ~/.bashrc",
			"cat ~/.bash_profile",
			"cat ~/.profile",
			"cat ~/.zshrc",
			"cat ~/.zprofile",
			"cat ~/.zshenv",
			"cat ~/.config/fish/config.fish",
			"source ~/.bashrc",
			". ~/.zshrc",
			"cat /proc/self/environ",
			"cat /proc/$$/environ",
			"cat /proc/1234/environ",
			"cat /proc/${PPID}/environ",
			"tr '\\0' '\\n' < /proc/$PPID/environ",
			"strings /proc/self/task/1/environ",
			"ps e",
			"ps eww",
			"ps auxe",
			"ps eww -p 1",
		],
		// Round 3, rule 4: launchers, wrappers, editors and clients that run a command or send a request.
		"round 3: git command-string runners": ["git bisect run zsh -c 'git push'", "git -C . bisect run sh -c 'gh pr merge 1'", "git bisect run sh -c \"$X\"", "git rebase -x 'bash -c \"git push\"' HEAD~1", "git submodule foreach 'sh -c \"git push\"'"],
		"round 3: launchers": [
			"rtx exec -- git push",
			"mise x -c 'git push'",
			"mise x node@20 -- git push",
			"mise exec -- bash -c 'git push'",
			"mise exec -- $CMD",
			"direnv exec ~/p gh pr merge 1",
			"nix-shell -p git --run 'git push'",
			"nix-shell --command 'git push'",
			"nix develop --command git push",
			"nix shell nixpkgs#git -c git push",
			"nix run nixpkgs#git -- push",
			"nix run .#deploy",
			"nix run",
			"conda run -n e git push",
			"mamba run git push",
			"micromamba run -n e git push",
			"devbox run -- git push",
			"pixi run -e e git push",
			"asdf exec gh pr merge 1",
			"pipenv run git push",
			"hatch run git push",
			"pdm run git push",
			"rye run git push",
			"pnpx gh pr merge 1",
			"bun -r ./push.js -e 1",
			"bun push.js",
			"bun run push.js",
			"just ship",
			"just --justfile justfile ship",
		],
		"round 3: wrappers": [
			"echo 'git push' | at now",
			"at -f push.sh now",
			"batch -f push.sh",
			"at now <<< \"$CMD\"",
			"chrt -f 1 git push",
			"systemd-run --user -u x git push",
			"systemd-run --user npm test",
			"firejail --net=none git push",
			"numactl --physcpubind=0 git push",
			"cpulimit -l 50 -- git push",
			"trickle -d 10 git push",
			"proxychains4 -q git push",
			"proxychains git push",
			"torsocks git push",
			"torsocks -a 127.0.0.1 gh pr merge 1",
			"sandbox-exec -p '(version 1)(allow default)' git push",
			"sandbox-exec -f profile.sb git push",
		],
		"round 3: editors that run shell commands": [
			"vim -c 'call system(\"git push\")' -c q",
			"vim -c 'call system([\"git\", \"push\"])' -c q",
			"vim '+!git push' +q",
			"vim -c ':!git push' file",
			"vi -c '!git push'",
			"nvim --cmd '!git push' -c q",
			"nvim --headless -c 'silent !git push' -c q",
			"view -c ':silent !git push'",
			"vim -es -c 'r !git push' -c q",
			"vim -c 'call system(g:cmd)'",
			"vim -c 'exe \"!\".g:cmd'",
			"vim -c 'py3 import os'",
			"vim -c 'terminal git push'",
			"vim -S push.vim",
			"ex -s a.txt <<< '!git push'",
			"ex -s a.txt < push.vim",
			"ed a.txt <<< '!git push'",
			"ed a.txt <<< 'e !git push'",
			"printf '!git push\\nq\\n' | ed a.txt",
			"emacs --batch --eval '(shell-command \"git push\")'",
			"emacs --batch --eval '(call-process \"git\" nil nil nil \"push\")'",
			"emacs --batch --eval '(start-process \"p\" nil \"git\" \"push\")'",
			"emacs --batch --eval='(async-shell-command \"git push\")'",
			"emacsclient -e '(shell-command \"git push\")'",
			"emacs --batch --eval \"(shell-command \\\"$CMD\\\")\"",
			"emacs --batch --eval '(shell-command cmd)'",
			"emacs --batch --eval '(load \"x.el\")'",
			"sed 's/x/git push/e' a.txt",
			"sed -e 's|x|y|ge' a.txt",
			"sed '1e git push' a.txt",
			"sed -n '/x/e git push' a.txt",
			"sed '$e git push' a.txt",
			"sed e a.txt",
			"sed '1e' a.txt",
			"sed -f x.sed a.txt",
			"sed --expression='e git push' a.txt",
			"gsed -i 'e git push' a.txt",
		],
		"round 3: HTTP clients": [
			"curlie -X POST https://api.github.com/repos/a/b/issues",
			"curlie https://api.github.com/repos/a/b/issues title=x",
			"curlie -d x https://api.github.com/repos/a/b/issues",
			"aria2c --header='Authorization: x' https://api.github.com/x",
			"aria2c --post-file=x https://api.github.com/x",
			"https POST api.github.com/repos/a/b/issues title=x",
			"lwp-request -m POST https://api.github.com/x",
			"lwp-request -mPUT https://api.github.com/x",
			"lwp-request -m $M https://api.github.com/x",
			"POST https://api.github.com/x",
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
			// Round 3 controls: the local forms next to the closed holes.
			"read -r line < file.txt",
			"read -p 'ok? ' answer",
			"read -rd '' text <<< x",
			"while read -r a b; do echo $a; done < a.txt",
			"for f in *.ts; do echo $f; done",
			"for i in 1 2 3; do echo $i; done",
			"select opt in a b; do break; done",
			"getopts ab opt -a",
			"mapfile -t lines < a.txt",
			"printf -v out '%s' hi",
			"printf '%s\\n' hi",
			"export PATH=\"$HOME/bin:$PATH\"",
			"export FOO=bar",
			"export -n FOO",
			"export -p",
			"declare -a arr",
			"declare -x FOO=bar",
			"local x=1",
			"typeset -i n=3",
			"readonly VERSION=1",
			"unset \"FOO\"",
			"unset -f myfn",
			"let n=1",
			"ENV=production npm test",
			"bash -c 'npm test'",
			"bash -ec 'npm test'",
			"sh -c 'ls -la'",
			"zsh -c 'ls'",
			"bash script.sh -l",
			"bash --norc --noprofile -c true",
			"exec ls",
			"vim -c 'set nu' a.txt",
			"vim -S ok.vim a.txt",
			"ex -s a.txt < ok.vim",
			"vim a.txt",
			"nvim --headless -c 'set nu' -c q",
			"vim -es -c 'g/x/d' -c wq a.txt",
			"vim -c 'normal! gg' a.txt",
			"vim -c 'wq!' a.txt",
			"ed a.txt",
			"emacs --version",
			"emacs --batch --eval '(message \"hi\")'",
			"sed -i 's/a/b/' a.txt",
			"sed -i '' 's/a/b/' a.txt",
			"sed -n '1,5p' a.txt",
			"sed 's/a/b/g;s/c/d/' a.txt",
			"sed -e 's/a/b/' -e '/error/d' a.txt",
			"sed '/start/,/end/p' a.txt",
			"sed -f ok.sed a.txt",
			"mise exec -- npm test",
			"mise x node@20 -- node -v",
			"nix develop -c npm test",
			"nix-shell -p nodejs --run 'npm test'",
			"nix run nixpkgs#hello",
			"conda run -n e python -V",
			"devbox run npm test",
			"pixi run python -V",
			"asdf exec node -v",
			"direnv exec . npm test",
			"pnpx prettier --check .",
			"just build",
			"just",
			"just --list",
			"bun --version",
			"chrt -f 1 ls",
			"numactl -C 0 ls",
			"firejail ls",
			"cpulimit -l 50 -- ls",
			"torsocks curl https://example.com",
			"sandbox-exec -p '(version 1)(allow default)' ls",
			"at -l",
			"curlie https://example.com",
			"aria2c https://example.com/x.tgz",
			"lwp-request https://example.com",
			"GET https://example.com",
			"cat ~/.gitconfig",
			"ls ~/.config",
			"ls ~/.config/*",
			"ls ~/.bashrc",
			"cat ~/projects/*.md",
			"cat src/*.ts",
			"grep -r TODO src",
			"grep -rn TODO .",
			"grep 'a[bc]' a.txt",
			"rg TODO src",
			"tar czf /tmp/x.tgz src",
			"tar xzf /tmp/x.tgz -C ~",
			"cp -r src /tmp/x",
			"cp -r a.txt ~/",
			"cp -r src ~/backup",
			"rsync -a src/ ~/backup/",
			"zip -r /tmp/x.zip src",
			"find ~ -name '*.ts'",
			"find . -name '*.ts' -exec echo {} +",
			"find src -type f | xargs cat",
			"ps aux",
			"ps -ef",
			"ps -p 1 -o comm=",
			"cat /proc/cpuinfo",
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
