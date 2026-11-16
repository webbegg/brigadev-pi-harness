// S10 credential lock: the pure environment builder (lib/dsp-credlock.ts). No process is spawned here.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
	buildCredLock,
	credLockLine,
	isLockedVariable,
	lockEnvironment,
	lockPaths,
	lockPrelude,
	lockScriptPath,
	lockSourceLine,
	markCredLock,
	sanitizeDockerConfig,
	sanitizeNpmrc,
	SSH_LOCKED_COMMAND,
	takeCredLock,
	writeLockScript,
} from "../lib/dsp-credlock.ts";

const DIR = "/tmp/brigadev-lock-test";
const HOME = "/home/user";

describe("S10 which variables are removed", () => {
	it("removes the ssh agent variables and every token-like name from the spec", () => {
		for (const name of [
			"SSH_AUTH_SOCK",
			"SSH_AGENT_PID",
			"GH_TOKEN",
			"GITHUB_TOKEN",
			"NPM_TOKEN",
			"NODE_AUTH_TOKEN",
			"CARGO_REGISTRY_TOKEN",
			"TWINE_PASSWORD",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_ACCESS_KEY_ID",
			"AWS_SESSION_TOKEN",
			"OPENAI_API_KEY",
			"MY_PRIVATE_KEY",
			"GOOGLE_APPLICATION_CREDENTIALS",
			"DB_PASSWD",
			"CLIENT_SECRET",
			"AUTH",
			"auth_header",
			"npm_token",
		]) {
			assert.equal(isLockedVariable(name), true, name);
		}
	});

	it("keeps look-alikes: the pattern needs the word between underscores or at an edge", () => {
		for (const name of ["PATH", "HOME", "TOKENIZERS_PARALLELISM", "AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "SECRETS_DIR", "PASSWORDLESS", "SSH_KEY_PATH", "GIT_ASKPASS", "KEYBOARD", "MONKEY", "PI_SESSION_ID", "LC_ALL"]) {
			assert.equal(isLockedVariable(name), false, name);
		}
	});

	it("documents the edges: AWS_ACCESS_KEY matches (the _ID is optional), a bare *_KEY does not", () => {
		assert.equal(isLockedVariable("AWS_ACCESS_KEY"), true);
		assert.equal(isLockedVariable("SSH_KEY"), false);
		assert.equal(isLockedVariable("GITHUB_TOKEN_FILE"), true); // TOKEN followed by `_`
		assert.equal(isLockedVariable("NOTOKEN"), false); // TOKEN not preceded by `_` or the start
	});

	it("drops them from the spawn environment and lists them in `removed`", () => {
		const locked = lockEnvironment({ PATH: "/usr/bin", HOME, SSH_AUTH_SOCK: "/s", SSH_AGENT_PID: "1", GH_TOKEN: "x", TOKENIZERS_PARALLELISM: "false", AUTHOR_NAME: "a" }, DIR);
		assert.equal(locked.env.SSH_AUTH_SOCK, undefined);
		assert.equal(locked.env.SSH_AGENT_PID, undefined);
		assert.equal(locked.env.GH_TOKEN, undefined);
		assert.equal(locked.env.PATH, "/usr/bin");
		assert.equal(locked.env.HOME, HOME, "HOME is unchanged");
		assert.equal(locked.env.TOKENIZERS_PARALLELISM, "false");
		assert.equal(locked.env.AUTHOR_NAME, "a");
		assert.deepEqual([...locked.removed].sort(), ["GH_TOKEN", "SSH_AGENT_PID", "SSH_AUTH_SOCK"]);
	});

	it("does not mutate the input environment", () => {
		const env = { GH_TOKEN: "x", PATH: "/bin" };
		lockEnvironment(env, DIR);
		assert.deepEqual(env, { GH_TOKEN: "x", PATH: "/bin" });
	});

	it("also drops differently-cased copies of an overridden variable (npm_config_userconfig)", () => {
		const locked = lockEnvironment({ npm_config_userconfig: "/home/user/.npmrc", docker_config: "/d" }, DIR);
		assert.equal(locked.env.npm_config_userconfig, undefined);
		assert.equal(locked.env.docker_config, undefined);
		assert.equal(locked.env.NPM_CONFIG_USERCONFIG, lockPaths(DIR).npmrc);
	});
});

describe("S10 which variables are set", () => {
	const locked = lockEnvironment({ PATH: "/usr/bin" }, DIR);
	const paths = lockPaths(DIR);

	it("points gh, aws, npm and docker at private copies and makes the askpass programs fail", () => {
		assert.equal(locked.env.GH_CONFIG_DIR, paths.gh);
		assert.equal(locked.env.GIT_TERMINAL_PROMPT, "0");
		assert.equal(locked.env.GCM_INTERACTIVE, "never");
		assert.equal(locked.env.GIT_ASKPASS, paths.askpass);
		assert.equal(locked.env.SSH_ASKPASS, paths.askpass);
		assert.equal(locked.env.AWS_SHARED_CREDENTIALS_FILE, paths.awsCredentials);
		assert.equal(locked.env.NPM_CONFIG_USERCONFIG, paths.npmrc);
		assert.equal(locked.env.DOCKER_CONFIG, paths.docker);
	});

	it("overrides a parent's value of an overridden variable", () => {
		const parent = lockEnvironment({ GH_CONFIG_DIR: "/home/user/.config/gh", GIT_ASKPASS: "/usr/bin/real-askpass", AWS_SHARED_CREDENTIALS_FILE: "/home/user/.aws/credentials", GIT_SSH_COMMAND: "ssh -i /k" }, DIR);
		assert.equal(parent.env.GH_CONFIG_DIR, paths.gh);
		assert.equal(parent.env.GIT_ASKPASS, paths.askpass);
		assert.equal(parent.env.AWS_SHARED_CREDENTIALS_FILE, paths.awsCredentials);
		assert.equal(parent.env.GIT_SSH_COMMAND, SSH_LOCKED_COMMAND, "GIT_SSH_COMMAND would win over core.sshCommand");
	});

	it("resets git credential helpers and the ssh command through GIT_CONFIG_COUNT", () => {
		assert.equal(locked.env.GIT_CONFIG_COUNT, "2");
		assert.equal(locked.env.GIT_CONFIG_KEY_0, "credential.helper");
		assert.equal(locked.env.GIT_CONFIG_VALUE_0, "");
		assert.equal(locked.env.GIT_CONFIG_KEY_1, "core.sshCommand");
		assert.equal(locked.env.GIT_CONFIG_VALUE_1, "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes");
		assert.equal(SSH_LOCKED_COMMAND, locked.env.GIT_CONFIG_VALUE_1);
	});

	it("appends to GIT_CONFIG_COUNT entries the parent already has, in order, last", () => {
		const parent = lockEnvironment({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "store" }, DIR);
		assert.equal(parent.env.GIT_CONFIG_COUNT, "4");
		assert.equal(parent.env.GIT_CONFIG_KEY_0, "user.name");
		assert.equal(parent.env.GIT_CONFIG_VALUE_0, "x");
		assert.equal(parent.env.GIT_CONFIG_KEY_1, "credential.helper");
		assert.equal(parent.env.GIT_CONFIG_VALUE_1, "store");
		assert.equal(parent.env.GIT_CONFIG_KEY_2, "credential.helper");
		assert.equal(parent.env.GIT_CONFIG_VALUE_2, "");
		assert.equal(parent.env.GIT_CONFIG_KEY_3, "core.sshCommand");
	});

	it("treats an invalid GIT_CONFIG_COUNT as none (git would refuse to run with it)", () => {
		for (const bad of ["", "abc", "-1", "1.5"]) {
			const parent = lockEnvironment({ GIT_CONFIG_COUNT: bad }, DIR);
			assert.equal(parent.env.GIT_CONFIG_COUNT, "2", JSON.stringify(bad));
			assert.equal(parent.env.GIT_CONFIG_KEY_0, "credential.helper");
		}
	});

	it("`set` lists exactly what was assigned, and `removed` never lists an assigned name", () => {
		const parent = lockEnvironment({ AWS_SHARED_CREDENTIALS_FILE: "/x", GH_TOKEN: "t" }, DIR);
		assert.equal(parent.set.AWS_SHARED_CREDENTIALS_FILE, paths.awsCredentials);
		assert.deepEqual(parent.removed, ["GH_TOKEN"]);
		for (const [key, value] of Object.entries(parent.set)) assert.equal(parent.env[key], value);
	});
});

describe("S10 npmrc sanitizing", () => {
	it("drops auth lines (global and scoped) and keeps registry and other settings", () => {
		const text = [
			"# my config",
			"registry=https://registry.npmjs.org/",
			"@acme:registry=https://npm.acme.test/",
			"//registry.npmjs.org/:_authToken=npm_secret",
			"//npm.acme.test/:_auth=Zm9vOmJhcg==",
			"//npm.acme.test/:_password=cGFzcw==",
			"//npm.acme.test/:username=bob",
			"_authToken=${NPM_TOKEN}",
			"email=bob@example.com",
			"certfile=/home/user/cert.pem",
			"  keyfile = /home/user/key.pem",
			"_AUTH = abc",
			"save-exact=true",
			"",
		].join("\n");
		assert.equal(sanitizeNpmrc(text), ["# my config", "registry=https://registry.npmjs.org/", "@acme:registry=https://npm.acme.test/", "save-exact=true", ""].join("\n"));
	});

	it("drops a line that embeds credentials in a URL", () => {
		const out = sanitizeNpmrc("registry=https://bob:hunter2@npm.acme.test/\nfetch-retries=3\n");
		assert.doesNotMatch(out, /hunter2/);
		assert.match(out, /fetch-retries=3/);
	});

	it("an empty or missing file gives an empty file", () => {
		assert.equal(sanitizeNpmrc(""), "");
	});
});

describe("S10 docker config sanitizing", () => {
	it("removes auths, credsStore and credHelpers and keeps the rest", () => {
		const out = JSON.parse(sanitizeDockerConfig(JSON.stringify({ auths: { "ghcr.io": { auth: "x" } }, credsStore: "osxkeychain", credHelpers: { "gcr.io": "gcloud" }, currentContext: "colima", psFormat: "table" })));
		assert.deepEqual(out, { currentContext: "colima", psFormat: "table" });
	});

	it("an unreadable or non-object config becomes an empty one", () => {
		assert.deepEqual(JSON.parse(sanitizeDockerConfig("not json")), {});
		assert.deepEqual(JSON.parse(sanitizeDockerConfig("[1]")), {});
		assert.deepEqual(JSON.parse(sanitizeDockerConfig("")), {});
	});
});

describe("S10 the plan: files to create", () => {
	const reads: Record<string, string> = {
		[`${HOME}/.npmrc`]: "registry=https://r.test/\n//r.test/:_authToken=secret\n",
		[`${HOME}/.docker/config.json`]: JSON.stringify({ auths: { x: {} }, credsStore: "desktop", currentContext: "c" }),
	};
	const plan = buildCredLock({ env: { GH_TOKEN: "t", PATH: "/bin" }, home: HOME, dir: DIR, readFile: (path) => reads[path], exists: (path) => path === `${HOME}/.docker/cli-plugins` });
	const file = (path: string) => plan.files.find((f) => f.path === path);
	const paths = lockPaths(DIR);

	it("carries the environment too", () => {
		assert.equal(plan.env.GH_TOKEN, undefined);
		assert.equal(plan.env.GH_CONFIG_DIR, paths.gh);
	});

	it("creates the empty gh config dir and the docker dir with mode 0700, under the private dir", () => {
		assert.deepEqual(plan.dirs.map((d) => d.path).sort(), [paths.docker, paths.gh].sort());
		for (const dir of plan.dirs) assert.equal(dir.mode, 0o700);
	});

	it("writes an empty AWS credentials file (0600)", () => {
		assert.deepEqual(file(paths.awsCredentials), { path: paths.awsCredentials, content: "", mode: 0o600 });
	});

	it("writes a failing askpass program (executable by the owner only)", () => {
		const askpass = file(paths.askpass);
		assert.ok(askpass);
		assert.match(askpass.content, /^#!\/bin\/sh\n/);
		assert.match(askpass.content, /exit 1/);
		assert.equal(askpass.mode, 0o700);
	});

	it("writes the sanitized npmrc and docker config copies (0600)", () => {
		const npmrc = file(paths.npmrc);
		assert.equal(npmrc?.mode, 0o600);
		assert.equal(npmrc?.content, "registry=https://r.test/\n");
		const docker = file(`${paths.docker}/config.json`);
		assert.equal(docker?.mode, 0o600);
		assert.deepEqual(JSON.parse(docker?.content ?? ""), { currentContext: "c" });
	});

	it("links the user's docker cli-plugins (so buildx/compose keep working) but only when they exist", () => {
		assert.deepEqual(plan.links, [{ path: `${paths.docker}/cli-plugins`, target: `${HOME}/.docker/cli-plugins` }]);
	});

	it("missing ~/.npmrc and ~/.docker give an empty npmrc and an empty docker config", () => {
		const empty = buildCredLock({ env: {}, home: HOME, dir: DIR, readFile: () => undefined, exists: () => false });
		assert.equal(empty.files.find((f) => f.path === paths.npmrc)?.content, "");
		assert.deepEqual(JSON.parse(empty.files.find((f) => f.path === `${paths.docker}/config.json`)?.content ?? ""), {});
		assert.deepEqual(empty.links, []);
	});

	it("reads the copies from where the parent's NPM_CONFIG_USERCONFIG and DOCKER_CONFIG point", () => {
		const asked: string[] = [];
		buildCredLock({ env: { NPM_CONFIG_USERCONFIG: "/etc/custom.npmrc", DOCKER_CONFIG: "/etc/docker-cfg" }, home: HOME, dir: DIR, readFile: (path) => (asked.push(path), undefined), exists: () => false });
		assert.ok(asked.includes("/etc/custom.npmrc"));
		assert.ok(asked.includes("/etc/docker-cfg/config.json"));
	});

	it("never copies a secret into the plan", () => {
		assert.doesNotMatch(JSON.stringify(plan), /secret/);
	});
});

describe("S10 the shell prelude", () => {
	const locked = lockEnvironment({ GH_TOKEN: "t", SSH_AUTH_SOCK: "/s", "weird-name": "x", FOO_TOKEN: "f" }, DIR);
	const prelude = lockPrelude(locked);

	it("unsets what was removed and exports what was set, in one line that fails closed", () => {
		assert.ok(!prelude.includes("\n"));
		assert.match(prelude, /^unset -v /);
		assert.match(prelude, /\bGH_TOKEN\b/);
		assert.match(prelude, /\bSSH_AUTH_SOCK\b/);
		assert.match(prelude, /\bFOO_TOKEN\b/);
		assert.match(prelude, /export GH_CONFIG_DIR='/);
		assert.match(prelude, /\|\| exit 1$/);
	});

	it("never mentions a value of a removed variable", () => {
		assert.doesNotMatch(prelude, /'t'|\/s\b/);
	});

	it("quotes values with single quotes, escaping embedded ones", () => {
		const odd = lockEnvironment({}, "/tmp/it's here");
		assert.match(lockPrelude(odd), /GH_CONFIG_DIR='\/tmp\/it'\\''s here\/gh'/);
	});

	it("skips names a shell cannot unset", () => {
		const bad = lockEnvironment({ "BASH_FUNC_x%%_TOKEN": "() { :; }" }, DIR);
		assert.deepEqual(bad.removed, ["BASH_FUNC_x%%_TOKEN"]);
		assert.doesNotMatch(lockPrelude(bad), /BASH_FUNC/);
	});
});

describe("S10 the short prefix line and lock.sh", () => {
	it("the line sources lock.sh in the private dir and exits when it cannot", () => {
		assert.equal(lockScriptPath(DIR), `${DIR}/lock.sh`);
		assert.equal(lockSourceLine(DIR), `. '${DIR}/lock.sh' || exit 1`);
	});

	it("quotes a path with single quotes, spaces and shell characters", () => {
		assert.equal(lockSourceLine("/tmp/it's $x `y`"), `. '/tmp/it'\\''s $x \`y\`/lock.sh' || exit 1`);
	});

	it("writeLockScript writes the prelude for the given environment, mode 0600, and again over an edited file", () => {
		const dir = mkdtempSync(join(tmpdir(), "lock-sh-"));
		try {
			const env = { GH_TOKEN: "t", PATH: "/bin" };
			writeLockScript(dir, env);
			const expected = `${lockPrelude(lockEnvironment(env, dir))}\n`;
			assert.equal(readFileSync(lockScriptPath(dir), "utf8"), expected);
			assert.equal(statSync(lockScriptPath(dir)).mode & 0o777, 0o600);
			writeFileSync(lockScriptPath(dir), "# weakened\n");
			writeLockScript(dir, env);
			assert.equal(readFileSync(lockScriptPath(dir), "utf8"), expected);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws when the directory does not exist (the guard blocks the call)", () => {
		assert.throws(() => writeLockScript(join(tmpdir(), "brigadev-no-such-dir", "x"), {}));
	});
});

describe("S10 the per-call registry shared by the guard and bg_start", () => {
	it("hands a lock to the call it was marked for, once", () => {
		const apply = (env: NodeJS.ProcessEnv) => ({ ...env, LOCKED: "1" });
		markCredLock("call-1", apply);
		assert.equal(takeCredLock("call-2"), undefined);
		assert.equal(takeCredLock("call-1"), apply);
		assert.equal(takeCredLock("call-1"), undefined);
	});

	it("marking a call as unlocked clears an earlier mark for the same id", () => {
		markCredLock("call-3", (env) => env);
		markCredLock("call-3", undefined);
		assert.equal(takeCredLock("call-3"), undefined);
	});

	it("the doctor line says what the lock covers and what it does not", () => {
		const line = credLockLine();
		assert.match(line, /credential lock: on/);
		assert.match(line, /SSH agent/);
		assert.match(line, /remote call you approve/);
	});
});
