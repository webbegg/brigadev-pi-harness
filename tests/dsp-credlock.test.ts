// S10 credential lock: the pure environment builder and the inline prelude (lib/dsp-credlock.ts). No process is spawned here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	credLockLine,
	isLockedVariable,
	lockEnvironment,
	lockPlaces,
	lockPrelude,
	markCredLock,
	SSH_LOCKED_COMMAND,
	takeCredLock,
	type LockPlaces,
} from "../lib/dsp-credlock.ts";

const HOME = "/home/user";
const PLACES: LockPlaces = { configDir: "/var/empty/brigadev", deny: "/usr/bin/false" };

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
		const locked = lockEnvironment({ PATH: "/usr/bin", HOME, SSH_AUTH_SOCK: "/s", SSH_AGENT_PID: "1", GH_TOKEN: "x", TOKENIZERS_PARALLELISM: "false", AUTHOR_NAME: "a" }, PLACES);
		assert.equal(locked.env.SSH_AUTH_SOCK, undefined);
		assert.equal(locked.env.SSH_AGENT_PID, undefined);
		assert.equal(locked.env.GH_TOKEN, undefined);
		assert.equal(locked.env.PATH, "/usr/bin");
		assert.equal(locked.env.HOME, HOME, "HOME is unchanged");
		assert.equal(locked.env.TOKENIZERS_PARALLELISM, "false");
		assert.equal(locked.env.AUTHOR_NAME, "a");
		assert.deepEqual([...locked.removed].sort(), ["GH_TOKEN", "SSH_AGENT_PID", "SSH_AUTH_SOCK"]);
	});

	it("an environment without any lockable variable removes nothing", () => {
		assert.deepEqual(lockEnvironment({ PATH: "/usr/bin", HOME }, PLACES).removed, []);
	});

	it("does not mutate the input environment", () => {
		const env = { GH_TOKEN: "x", PATH: "/bin" };
		lockEnvironment(env, PLACES);
		assert.deepEqual(env, { GH_TOKEN: "x", PATH: "/bin" });
	});

	it("also drops differently-cased copies of an overridden variable (npm_config_userconfig)", () => {
		const locked = lockEnvironment({ npm_config_userconfig: "/home/user/.npmrc", docker_config: "/d" }, PLACES);
		assert.equal(locked.env.npm_config_userconfig, undefined);
		assert.equal(locked.env.docker_config, undefined);
		assert.equal(locked.env.NPM_CONFIG_USERCONFIG, "/dev/null");
	});
});

describe("S10 which variables are set (only places nobody can write)", () => {
	const locked = lockEnvironment({ PATH: "/usr/bin" }, PLACES);

	it("points gh and docker at an unreachable dir, npm and aws at /dev/null, and makes the askpass programs fail", () => {
		assert.equal(locked.env.GH_CONFIG_DIR, "/var/empty/brigadev");
		assert.equal(locked.env.DOCKER_CONFIG, "/var/empty/brigadev");
		assert.equal(locked.env.NPM_CONFIG_USERCONFIG, "/dev/null");
		assert.equal(locked.env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
		assert.equal(locked.env.GIT_ASKPASS, "/usr/bin/false");
		assert.equal(locked.env.SSH_ASKPASS, "/usr/bin/false");
		assert.equal(locked.env.GIT_TERMINAL_PROMPT, "0");
		assert.equal(locked.env.GCM_INTERACTIVE, "never");
	});

	it("no assigned value is a path the agent could write: only /dev/null, the system false and the unreachable dir", () => {
		const allowed = new Set(["/var/empty/brigadev", "/dev/null", "/usr/bin/false", "0", "never", "2", "credential.helper", "core.sshCommand", "", SSH_LOCKED_COMMAND]);
		for (const [key, value] of Object.entries(locked.set)) assert.ok(allowed.has(value), `${key}=${value}`);
	});

	it("overrides a parent's value of an overridden variable", () => {
		const parent = lockEnvironment({ GH_CONFIG_DIR: "/home/user/.config/gh", GIT_ASKPASS: "/usr/bin/real-askpass", AWS_SHARED_CREDENTIALS_FILE: "/home/user/.aws/credentials", GIT_SSH_COMMAND: "ssh -i /k" }, PLACES);
		assert.equal(parent.env.GH_CONFIG_DIR, "/var/empty/brigadev");
		assert.equal(parent.env.GIT_ASKPASS, "/usr/bin/false");
		assert.equal(parent.env.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
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
		const parent = lockEnvironment({ GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x", GIT_CONFIG_KEY_1: "credential.helper", GIT_CONFIG_VALUE_1: "store" }, PLACES);
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
			const parent = lockEnvironment({ GIT_CONFIG_COUNT: bad }, PLACES);
			assert.equal(parent.env.GIT_CONFIG_COUNT, "2", JSON.stringify(bad));
			assert.equal(parent.env.GIT_CONFIG_KEY_0, "credential.helper");
		}
	});

	it("`set` lists exactly what was assigned, and `removed` never lists an assigned name", () => {
		const parent = lockEnvironment({ AWS_SHARED_CREDENTIALS_FILE: "/x", GH_TOKEN: "t" }, PLACES);
		assert.equal(parent.set.AWS_SHARED_CREDENTIALS_FILE, "/dev/null");
		assert.deepEqual(parent.removed, ["GH_TOKEN"]);
		for (const [key, value] of Object.entries(parent.set)) assert.equal(parent.env[key], value);
	});
});

describe("S10 where the lock points", () => {
	it("an empty system dir that nobody can write gives /var/empty/brigadev", () => {
		const places = lockPlaces({ readOnlyDirectory: (path) => path === "/var/empty", exists: (path) => path === "/bin/false" });
		assert.deepEqual(places, { configDir: "/var/empty/brigadev", deny: "/bin/false" });
	});

	it("without one (missing, or writable) it falls back to a path that cannot exist: /dev/null/brigadev", () => {
		assert.equal(lockPlaces({ readOnlyDirectory: () => false, exists: () => true }).configDir, "/dev/null/brigadev");
	});

	it("prefers /usr/bin/false, and still names it when neither exists", () => {
		assert.equal(lockPlaces({ readOnlyDirectory: () => true, exists: () => true }).deny, "/usr/bin/false");
		assert.equal(lockPlaces({ readOnlyDirectory: () => true, exists: () => false }).deny, "/usr/bin/false");
	});

	it("the real probe returns an absolute askpass program and one of the two config dirs", () => {
		const places = lockPlaces();
		assert.match(places.deny, /^\/(usr\/)?bin\/false$/);
		assert.match(places.configDir, /^\/(var\/empty|dev\/null)\/brigadev$/);
	});
});

describe("S10 the shell prelude (inline, static, no file)", () => {
	const locked = lockEnvironment({ GH_TOKEN: "t", SSH_AUTH_SOCK: "/s", "weird-name": "x", FOO_TOKEN: "f", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "x" }, PLACES);
	const prelude = lockPrelude(locked);

	it("unsets what was removed and exports what was set, in one line that fails closed", () => {
		assert.ok(!prelude.includes("\n"));
		assert.match(prelude, /^unset -v /);
		assert.match(prelude, /\bGH_TOKEN\b/);
		assert.match(prelude, /\bSSH_AUTH_SOCK\b/);
		assert.match(prelude, /\bFOO_TOKEN\b/);
		assert.match(prelude, /export [^&]*GH_CONFIG_DIR=\/var\/empty\/brigadev\b/);
		assert.match(prelude, /\|\| exit 1$/);
	});

	it("chains every step with && so one failure exits", () => {
		const steps = prelude.replace(/ \|\| exit 1$/, "").split("&&");
		assert.ok(steps.length >= 3);
		for (const step of steps) assert.match(step, /^(unset -v|export) /);
	});

	it("reads no file and names no private path: only read-only targets", () => {
		assert.match(prelude, /NPM_CONFIG_USERCONFIG=\/dev\/null\b/);
		assert.match(prelude, /AWS_SHARED_CREDENTIALS_FILE=\/dev\/null\b/);
		assert.match(prelude, /GIT_ASKPASS=\/usr\/bin\/false\b/);
		assert.match(prelude, /SSH_ASKPASS=\/usr\/bin\/false\b/);
		assert.match(prelude, /DOCKER_CONFIG=\/var\/empty\/brigadev\b/);
		assert.match(prelude, /GIT_TERMINAL_PROMPT=0\b/);
		assert.match(prelude, /GCM_INTERACTIVE=never\b/);
		assert.doesNotMatch(prelude, /brigadev-lock|lock\.sh|askpass|\. '/);
	});

	it("appends its git config entries after the parent's", () => {
		assert.match(prelude, /GIT_CONFIG_COUNT=3\b/);
		assert.match(prelude, /GIT_CONFIG_KEY_1=credential\.helper GIT_CONFIG_VALUE_1= GIT_CONFIG_KEY_2=core\.sshCommand GIT_CONFIG_VALUE_2="\$GIT_SSH_COMMAND"/);
		assert.doesNotMatch(prelude, /GIT_CONFIG_KEY_0/);
	});

	it("writes the ssh command once (the other use refers to it)", () => {
		assert.equal(prelude.split("IdentityAgent=none").length - 1, 1);
		assert.match(prelude, /export GIT_SSH_COMMAND='ssh -F \/dev\/null /);
	});

	it("quotes only what the shell would change", () => {
		assert.doesNotMatch(prelude.replace(/GIT_SSH_COMMAND='[^']*'/, ""), /'/);
	});

	it("never mentions a value of a removed variable", () => {
		assert.doesNotMatch(prelude, /'t'|=t\b|\/s\b/);
	});

	it("an environment with nothing to remove starts at `export` (no empty unset)", () => {
		const clean = lockPrelude(lockEnvironment({ PATH: "/bin" }, PLACES));
		assert.match(clean, /^export GIT_SSH_COMMAND=/);
		assert.doesNotMatch(clean, /unset/);
	});

	it("quotes a value with spaces, escaping embedded single quotes", () => {
		const odd = lockPrelude(lockEnvironment({}, { configDir: "/tmp/it's here", deny: "/usr/bin/false" }));
		assert.match(odd, /GH_CONFIG_DIR='\/tmp\/it'\\''s here'/);
	});

	it("skips names a shell cannot unset", () => {
		const bad = lockEnvironment({ "BASH_FUNC_x%%_TOKEN": "() { :; }" }, PLACES);
		assert.deepEqual(bad.removed, ["BASH_FUNC_x%%_TOKEN"]);
		assert.doesNotMatch(lockPrelude(bad), /BASH_FUNC/);
	});

	it("stays short for a typical environment", () => {
		const typical = lockPrelude(lockEnvironment({ PATH: "/usr/bin", HOME, SSH_AUTH_SOCK: "/tmp/agent.sock", GH_TOKEN: "x" }, PLACES));
		assert.ok(typical.length < 700, `${typical.length}`);
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
		assert.match(line, /no file on disk/);
		assert.match(line, /npm private-registry auth and docker plugins\/contexts/);
	});
});
