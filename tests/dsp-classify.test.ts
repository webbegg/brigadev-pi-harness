// S4 (one test per remote form) and S6a/S6b (wrappers and undecidable commands) at the classifier level.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { analyzeDsp, classifyDsp } from "../lib/dsp-classify.ts";
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
