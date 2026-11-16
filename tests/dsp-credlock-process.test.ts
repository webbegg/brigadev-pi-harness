// S10 credential lock, real processes: a shell spawned under the built environment (or under the shell prelude)
// has no agent socket and no tokens, git has no credential helper, gh is logged out.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildCredLock, lockSourceLine, writeCredLock, writeLockScript, type CredLockPlan } from "../lib/dsp-credlock.ts";

const has = (command: string): boolean => spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0;
const HAS_GH = has("gh");

describe("S10 credential lock in real processes", () => {
	let root: string;
	let home: string;
	let lockDir: string;
	let work: string;
	let parent: NodeJS.ProcessEnv;
	let plan: CredLockPlan;

	before(() => {
		root = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-credlock-")));
		home = join(root, "home");
		work = join(root, "work");
		mkdirSync(home, { recursive: true });
		mkdirSync(work, { recursive: true });
		mkdirSync(join(home, ".docker"), { recursive: true });
		// A global git config with a credential helper that would hand out a password.
		writeFileSync(join(home, ".gitconfig"), '[credential]\n\thelper = "!f() { echo username=bob; echo password=leaked-by-helper; }; f"\n');
		writeFileSync(join(home, ".npmrc"), "registry=https://registry.npmjs.org/\n//registry.npmjs.org/:_authToken=npm-secret\n");
		writeFileSync(join(home, ".docker", "config.json"), JSON.stringify({ auths: { "ghcr.io": { auth: "docker-secret" } }, credsStore: "osxkeychain" }));
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
		lockDir = join(root, "lock");
		plan = buildCredLock({ env: parent, home, dir: lockDir });
		writeCredLock(plan);
	});

	after(() => rmSync(root, { recursive: true, force: true }));

	const sh = (script: string, env: NodeJS.ProcessEnv, options: { cwd?: string; input?: string; shell?: string } = {}) =>
		spawnSync(options.shell ?? "sh", ["-c", script], { env, cwd: options.cwd ?? work, input: options.input ?? "", encoding: "utf8" });

	it("the parent environment has the secrets (control)", () => {
		assert.equal(sh('echo "$SSH_AUTH_SOCK $GH_TOKEN"', parent).stdout.trim(), "/tmp/fake-agent.sock ghp_parenttoken");
	});

	it("a shell under the built environment sees no SSH_AUTH_SOCK, GH_TOKEN or other token", () => {
		const out = sh("env", plan.env).stdout;
		for (const name of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GH_TOKEN", "GITHUB_TOKEN", "NPM_TOKEN", "AWS_SECRET_ACCESS_KEY"]) assert.doesNotMatch(out, new RegExp(`^${name}=`, "m"), name);
		assert.match(out, /^TOKENIZERS_PARALLELISM=false$/m);
		assert.match(out, new RegExp(`^HOME=${home}$`, "m"));
	});

	it("git config --get-all credential.helper prints only an empty line (helpers of the user's config are reset)", () => {
		const clean = join(root, "clean-home");
		mkdirSync(clean, { recursive: true });
		const cleanPlan = buildCredLock({ env: { PATH: process.env.PATH, HOME: clean, GIT_CONFIG_NOSYSTEM: "1" }, home: clean, dir: join(root, "lock-clean") });
		const result = sh("git config --get-all credential.helper", cleanPlan.env);
		assert.equal(result.stdout, "\n");
		assert.equal(result.status, 0);
	});

	it("git credential fill gets the user's helper without the lock and nothing under it", () => {
		const input = "protocol=https\nhost=example.test\n\n";
		const open = sh("git credential fill", { ...parent, GIT_TERMINAL_PROMPT: "0" }, { input });
		assert.match(open.stdout, /password=leaked-by-helper/, "control: the helper answers without the lock");
		const locked = sh("git credential fill", plan.env, { input });
		assert.doesNotMatch(locked.stdout, /leaked-by-helper/);
		assert.notEqual(locked.status, 0);
	});

	it("git's ssh runs without the agent, identities or prompts", () => {
		const out = sh("git config --get core.sshCommand; echo \"$GIT_SSH_COMMAND\"", plan.env).stdout;
		assert.equal(out.split("\n").filter(Boolean).length, 2);
		for (const line of out.split("\n").filter(Boolean)) assert.match(line, /^ssh -F \/dev\/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=\/dev\/null -o BatchMode=yes$/);
	});

	it("the askpass programs fail", () => {
		const result = sh('"$GIT_ASKPASS" "Password for x:"; echo "exit=$?"; "$SSH_ASKPASS" p; echo "exit=$?"', plan.env);
		assert.deepEqual(result.stdout.trim().split("\n"), ["exit=1", "exit=1"]);
	});

	it("gh reports not logged in, although the parent's gh config and GH_TOKEN were logged in", { skip: !HAS_GH && "gh is not installed" }, () => {
		const result = sh("gh auth status", plan.env);
		assert.notEqual(result.status, 0);
		assert.match(`${result.stdout}${result.stderr}`, /not logged in/i);
	});

	it("the private dir is 0700, its files 0600 (the askpass 0700), and the copies carry no credentials", () => {
		const mode = (path: string) => statSync(path).mode & 0o777;
		assert.equal(mode(lockDir), 0o700);
		assert.equal(mode(join(lockDir, "gh")), 0o700);
		assert.equal(readdirCount(join(lockDir, "gh")), 0, "the gh config dir is empty");
		assert.equal(mode(join(lockDir, "aws-credentials")), 0o600);
		assert.equal(readFileSync(join(lockDir, "aws-credentials"), "utf8"), "");
		assert.equal(mode(join(lockDir, "npmrc")), 0o600);
		assert.equal(mode(join(lockDir, "docker", "config.json")), 0o600);
		assert.equal(mode(join(lockDir, "askpass")), 0o700);
		assert.equal(readFileSync(join(lockDir, "npmrc"), "utf8"), "registry=https://registry.npmjs.org/\n");
		assert.doesNotMatch(readFileSync(join(lockDir, "docker", "config.json"), "utf8"), /docker-secret|osxkeychain/);
		assert.doesNotMatch(readFileSync(join(lockDir, "npmrc"), "utf8"), /npm-secret/);
	});

	it("writing the plan twice keeps the files and modes (a session reuses its dir)", () => {
		writeCredLock(plan);
		assert.equal(statSync(join(lockDir, "npmrc")).mode & 0o777, 0o600);
		assert.ok(existsSync(join(lockDir, "askpass")));
	});

	describe("the one-line prefix the guard puts before a bash command (it sources lock.sh)", () => {
		/** What the guard does before every locked call: rewrite lock.sh, then prefix the command. */
		const prefixed = (command: string, dir = lockDir) => {
			writeLockScript(dir, parent);
			return `${lockSourceLine(dir)}\n${command}`;
		};
		const run = (command: string, options: { cwd?: string; input?: string; shell?: string } = {}) => sh(prefixed(command), parent, options);

		it("is one short line that names lock.sh, quoted", () => {
			writeLockScript(lockDir, parent);
			const line = lockSourceLine(lockDir);
			assert.equal(line, `. '${lockDir}/lock.sh' || exit 1`);
			assert.ok(line.length < lockDir.length + 40);
			assert.equal(statSync(join(lockDir, "lock.sh")).mode & 0o777, 0o600);
		});

		for (const shell of ["sh", "bash"]) {
			it(`${shell}: a lock dir with a space, a single quote, a dollar sign and a backtick still sources`, () => {
				const odd = join(root, "it's $HOME `x` \"q\"");
				mkdirSync(odd, { recursive: true });
				const result = sh(prefixed('echo "[$GH_TOKEN][$GH_CONFIG_DIR]"', odd), parent, { shell });
				assert.equal(result.status, 0, result.stderr);
				assert.equal(result.stdout.trim(), `[][${join(odd, "gh")}]`);
			});

			it(`${shell}: exit code, working directory, stdin and $? are the command's`, () => {
				assert.equal(run("exit 7", { shell }).status, 7);
				assert.equal(run("false", { shell }).status, 1);
				assert.equal(run("true", { shell }).status, 0);
				assert.equal(run("pwd", { cwd: work, shell }).stdout.trim(), work);
				assert.equal(run("cat", { input: "piped input\n", shell }).stdout, "piped input\n");
				assert.equal(run("echo $?", { shell }).stdout.trim(), "0");
			});

			it(`${shell}: fails closed when lock.sh is missing`, () => {
				const empty = join(root, `no-lock-${shell}`);
				mkdirSync(empty, { recursive: true });
				const result = sh(`${lockSourceLine(empty)}\necho ran`, parent, { shell });
				assert.notEqual(result.status, 0);
				assert.equal(result.stdout, "");
			});
		}

		for (const shell of ["sh", "bash"]) {
			it(`${shell}: removes the secrets and sets the lock for the command`, () => {
				const result = run('echo "[$SSH_AUTH_SOCK][$GH_TOKEN][$NPM_TOKEN][$GH_CONFIG_DIR][$GIT_CONFIG_COUNT]"', { shell });
				assert.equal(result.stdout.trim(), `[][][][${join(lockDir, "gh")}][2]`);
			});
		}

		it("children of the command inherit the lock (exported, not just set)", () => {
			const out = run("env").stdout;
			assert.doesNotMatch(out, /^(SSH_AUTH_SOCK|GH_TOKEN|GITHUB_TOKEN|NPM_TOKEN)=/m);
			assert.match(out, /^GIT_CONFIG_KEY_0=credential.helper$/m);
		});

		it("keeps the command's exit code, working directory and stdin", () => {
			assert.equal(run("exit 7").status, 7);
			assert.equal(run("true").status, 0);
			assert.equal(run("false").status, 1);
			assert.equal(run("pwd", { cwd: work }).stdout.trim(), work);
			assert.equal(run("cat", { input: "piped input\n" }).stdout, "piped input\n");
			assert.equal(run("echo $?").stdout.trim(), "0", "$? starts at 0 as in a fresh shell");
		});

		it("git credential fill under the prelude gets nothing from the helper", () => {
			const result = run("git credential fill", { input: "protocol=https\nhost=example.test\n\n" });
			assert.doesNotMatch(result.stdout, /leaked-by-helper/);
			assert.notEqual(result.status, 0);
		});

		it("fails closed: when the prelude cannot run, the command does not", () => {
			const readonly = sh(`readonly GH_TOKEN=x; ${prefixed("echo ran")}`, parent);
			assert.notEqual(readonly.status, 0);
			assert.equal(readonly.stdout, "");
		});
	});
});

function readdirCount(path: string): number {
	return spawnSync("ls", ["-A", path], { encoding: "utf8" }).stdout.split("\n").filter(Boolean).length;
}
