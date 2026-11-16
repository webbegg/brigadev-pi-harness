// S10 credential lock, real processes: a shell spawned under the built environment (or under the inline prelude) has no
// agent socket and no tokens, git has no credential helper, gh is logged out. No file is involved in the lock.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { lockEnvironment, lockPlaces, lockPrelude, type LockedEnvironment } from "../lib/dsp-credlock.ts";

const has = (command: string, args = ["--version"]): boolean => spawnSync(command, args, { stdio: "ignore" }).status === 0;
const HAS_GH = has("gh");
const SHELLS = ["sh", "bash", "zsh", "dash"].filter((shell) => has(shell, ["-c", "true"]));

describe("S10 credential lock in real processes", () => {
	let root: string;
	let home: string;
	let work: string;
	let parent: NodeJS.ProcessEnv;
	let locked: LockedEnvironment;
	let prelude: string;

	before(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-credlock-")));
		home = join(root, "home");
		work = join(root, "work");
		mkdirSync(home, { recursive: true });
		mkdirSync(work, { recursive: true });
		// A global git config with a credential helper that would hand out a password.
		writeFileSync(join(home, ".gitconfig"), '[credential]\n\thelper = "!f() { echo username=bob; echo password=leaked-by-helper; }; f"\n');
		// A gh config that is logged in (a token in hosts.yml); the lock must hide it.
		mkdirSync(join(home, "gh-real"), { recursive: true });
		writeFileSync(join(home, "gh-real", "hosts.yml"), "github.com:\n    user: bob\n    oauth_token: ghp_fakefakefakefakefakefakefakefakefake\n    git_protocol: https\n");
		parent = {
			PATH: process.env.PATH,
			HOME: home,
			GIT_CONFIG_NOSYSTEM: "1",
			SSH_AUTH_SOCK: "/tmp/fake-agent.sock",
			SSH_AGENT_PID: "4242",
			GH_TOKEN: "ghp_parenttoken",
			GITHUB_TOKEN: "ghp_parenttoken2",
			NPM_TOKEN: "npm-parent",
			AWS_SECRET_ACCESS_KEY: "aws-parent",
			TOKENIZERS_PARALLELISM: "false",
			GH_CONFIG_DIR: join(home, "gh-real"),
		};
		locked = lockEnvironment(parent, lockPlaces());
		prelude = lockPrelude(locked);
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	const sh = (script: string, env: NodeJS.ProcessEnv, options: { cwd?: string; input?: string; shell?: string } = {}) =>
		spawnSync(options.shell ?? "sh", ["-c", script], { env, cwd: options.cwd ?? work, input: options.input ?? "", encoding: "utf8" });
	/** What the guard does to a locked bash command: the prelude, a newline, the original command. */
	const run = (command: string, options: { cwd?: string; input?: string; shell?: string } = {}) => sh(`${prelude}\n${command}`, parent, options);

	it("the parent environment has the secrets (control)", () => {
		assert.equal(sh('echo "$SSH_AUTH_SOCK $GH_TOKEN"', parent).stdout.trim(), "/tmp/fake-agent.sock ghp_parenttoken");
	});

	it("a shell under the built environment (bg_start) sees no SSH_AUTH_SOCK, GH_TOKEN or other token", () => {
		const out = sh("env", locked.env).stdout;
		for (const name of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY"]) assert.doesNotMatch(out, new RegExp(`^${name}=`, "m"), name);
		assert.match(out, /^TOKENIZERS_PARALLELISM=false$/m);
		assert.match(out, new RegExp(`^HOME=${home}$`, "m"));
	});

	it("git config --get-all credential.helper prints only an empty line (helpers of the user's config are reset), built env and prelude alike", () => {
		const clean = { PATH: process.env.PATH, HOME: join(root, "clean-home"), GIT_CONFIG_NOSYSTEM: "1" };
		mkdirSync(clean.HOME, { recursive: true });
		const cleanLocked = lockEnvironment(clean, lockPlaces());
		const viaEnv = sh("git config --get-all credential.helper", cleanLocked.env);
		assert.equal(viaEnv.stdout, "\n");
		assert.equal(viaEnv.status, 0);
		const viaPrelude = sh(`${lockPrelude(cleanLocked)}\ngit config --get-all credential.helper`, clean);
		assert.equal(viaPrelude.stdout, "\n");
		assert.equal(viaPrelude.status, 0);
	});

	it("git credential fill gets the user's helper without the lock and nothing under it", () => {
		const input = "protocol=https\nhost=example.test\n\n";
		const open = sh("git credential fill", { ...parent, GIT_TERMINAL_PROMPT: "0" }, { input });
		assert.match(open.stdout, /password=leaked-by-helper/, "control: the helper answers without the lock");
		for (const result of [sh("git credential fill", locked.env, { input }), run("git credential fill", { input })]) {
			assert.doesNotMatch(result.stdout, /leaked-by-helper/);
			assert.notEqual(result.status, 0);
		}
	});

	it("git's ssh runs without the agent, identities or prompts (core.sshCommand and GIT_SSH_COMMAND)", () => {
		for (const out of [sh("git config --get core.sshCommand; echo \"$GIT_SSH_COMMAND\"", locked.env).stdout, run("git config --get core.sshCommand; echo \"$GIT_SSH_COMMAND\"").stdout]) {
			assert.equal(out.split("\n").filter(Boolean).length, 2);
			for (const line of out.split("\n").filter(Boolean)) assert.match(line, /^ssh -F \/dev\/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=\/dev\/null -o BatchMode=yes$/);
		}
	});

	it("the askpass programs fail", () => {
		for (const result of [sh('"$GIT_ASKPASS" "Password for x:"; echo "exit=$?"; "$SSH_ASKPASS" p; echo "exit=$?"', locked.env), run('"$GIT_ASKPASS" "Password for x:"; echo "exit=$?"; "$SSH_ASKPASS" p; echo "exit=$?"')]) {
			assert.deepEqual(result.stdout.trim().split("\n"), ["exit=1", "exit=1"]);
		}
	});

	it("gh is not logged in, although the parent's gh config and GH_TOKEN were logged in", { skip: !HAS_GH && "gh is not installed" }, () => {
		const result = run("gh auth status");
		assert.notEqual(result.status, 0);
		const text = `${result.stdout}${result.stderr}`;
		// With /var/empty gh says it is not logged in; with the /dev/null fallback it cannot read its config at all. Neither has a token.
		assert.match(text, /not logged in|failed to read configuration/i);
		assert.doesNotMatch(text, /ghp_|Logged in to/);
		assert.notEqual(sh("gh auth status", locked.env).status, 0);
	});

	it("nothing the lock points at is a file the agent could write", () => {
		const places = lockPlaces();
		assert.equal(readdirSync(work).length, 0);
		// (/dev/null is writable by everyone but is a sink: nothing written there can be read back.)
		assert.equal(spawnSync("test", ["-w", places.deny]).status === 0 && process.getuid?.() !== 0, false, places.deny);
		assert.equal(spawnSync("test", ["-e", places.configDir]).status, 1, "the config dir does not exist");
		assert.equal(spawnSync("mkdir", ["-p", places.configDir], { stdio: "ignore" }).status === 0 && process.getuid?.() !== 0, false, "and cannot be created");
	});

	describe("the prelude the guard puts before a bash command", () => {
		it("is one line that ends with `|| exit 1`, with no file in it", () => {
			assert.ok(!prelude.includes("\n"));
			assert.match(prelude, /\|\| exit 1$/);
			assert.doesNotMatch(prelude, /lock\.sh|\. '|brigadev-lock/);
		});

		for (const shell of SHELLS) {
			it(`${shell}: exit code, working directory, stdin and $? are the command's`, () => {
				assert.equal(run("exit 7", { shell }).status, 7);
				assert.equal(run("false", { shell }).status, 1);
				assert.equal(run("true", { shell }).status, 0);
				assert.equal(run("pwd", { cwd: work, shell }).stdout.trim(), work);
				assert.equal(run("cat", { input: "piped input\n", shell }).stdout, "piped input\n");
				assert.equal(run("echo $?", { shell }).stdout.trim(), "0");
			});

			it(`${shell}: removes the secrets, sets the lock for the command, and children inherit it`, () => {
				const result = run('echo "[$SSH_AUTH_SOCK][$GH_TOKEN][$NPM_TOKEN][$GH_CONFIG_DIR][$GIT_CONFIG_COUNT][$NPM_CONFIG_USERCONFIG]"', { shell });
				assert.equal(result.stdout.trim(), `[][][][${lockPlaces().configDir}][2][/dev/null]`);
				const out = run("env", { shell }).stdout;
				assert.doesNotMatch(out, /^(SSH_AUTH_SOCK|SSH_AGENT_PID|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN|AWS_SECRET_ACCESS_KEY)=/m);
				assert.match(out, /^GIT_CONFIG_KEY_0=credential.helper$/m);
				assert.match(out, /^GIT_CONFIG_VALUE_0=$/m);
				assert.match(out, /^GIT_CONFIG_VALUE_1=ssh -F \/dev\/null -o IdentityAgent=none /m);
				assert.match(out, /^TOKENIZERS_PARALLELISM=false$/m);
			});

			it(`${shell}: a command that cannot be locked does not run (fails closed)`, () => {
				const readonlyName = sh(`readonly GH_TOKEN=x; ${prelude}\necho ran`, parent, { shell });
				assert.notEqual(readonlyName.status, 0);
				assert.doesNotMatch(readonlyName.stdout, /ran/);
			});
		}

		it("multi-line and quoted commands keep their meaning after the prelude", () => {
			assert.equal(run("echo 'a b'\necho \"$HOME\" | cat").stdout, `a b\n${home}\n`);
			assert.equal(run("cat <<'EOF'\nline $x\nEOF").stdout, "line $x\n");
		});

		it("a parent with git config entries of its own keeps them and appends the lock's", () => {
			const env = { ...parent, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "Parent Entry" };
			const own = lockPrelude(lockEnvironment(env, lockPlaces()));
			const result = sh(`${own}\ngit config --get user.name; git config --get-all credential.helper`, env);
			assert.match(result.stdout, /^Parent Entry\n/);
			assert.match(result.stdout, /\n\n$/, "the last credential.helper value is the empty one");
		});
	});
});
