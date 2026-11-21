// B1 / C1: the user's credentials belong to the runner. Every process that runs worker-authored code or worker commands gets the contained environment
// (src/contain.ts): the worker's bash, the ticket's `done` command, the `check` tool's suite, and the PR loop's final-check suite. Only the PR loop's own
// git/gh calls keep the real environment.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PrDeps } from "../src/pr.ts";
import { containedEnv, hardenGitEnv } from "../src/contain.ts";
import { bash, check, commitFile, docText, fakeClock, GIT_COMMIT, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";
import { addRemote, FakeGh, prDepsOf, until } from "./pr-fixture.ts";

const SECRETS: Record<string, string> = {
	GH_TOKEN: "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0001",
	GITHUB_TOKEN: "ghs_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE0002",
	ANTHROPIC_API_KEY: "sk-ant-FAKE-0003",
	SSH_AUTH_SOCK: "/tmp/fake-agent.sock",
	DEPLOY_SECRET: "fake-secret-0004",
	MY_DB_PASSWORD: "fake-password-0005",
};

let isolation: Isolation;
let saved: Record<string, string | undefined>;
before(() => {
	isolation = isolateEnv();
});
after(() => isolation.restore());

let ws: Workspace;
let runner: FixtureRunner | undefined;
beforeEach(() => {
	saved = Object.fromEntries(Object.keys(SECRETS).map((key) => [key, process.env[key]]));
	Object.assign(process.env, SECRETS);
	isolation.settings({ check: { test: "true" } });
	rmSync(isolation.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
});
afterEach(async () => {
	await runner?.close();
	runner = undefined;
	for (const [key, value] of Object.entries(saved)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	ws.cleanup();
});

/** What an `env` dump must not show, and what it must. */
function assertContained(dump: string, where: string) {
	for (const [name, value] of Object.entries(SECRETS)) {
		assert.ok(!dump.includes(`${name}=`), `${where}: ${name} is set`);
		assert.ok(!dump.includes(value), `${where}: the value of ${name} leaks`);
	}
	assert.match(dump, /^GH_CONFIG_DIR=.*\/brigadev-contain-[^/\n]+\/gh$/m, `${where}: GH_CONFIG_DIR is the runner's scratch`);
	assert.match(dump, /^GH_PROMPT_DISABLED=1$/m, where);
	assert.match(dump, /^GIT_TERMINAL_PROMPT=0$/m, where);
	assert.match(dump, /^GIT_ASKPASS=\/usr\/bin\/false$/m, where);
	assert.match(dump, /^GIT_CONFIG_NOSYSTEM=1$/m, where);
	assert.match(dump, /^GIT_SSH_COMMAND=ssh -o BatchMode=yes .*IdentityAgent=none$/m, where);
}

describe("containedEnv", () => {
	it("removes the credential variables and every secret-looking name, sets the containment variables, and keeps the rest", () => {
		const base = { PATH: "/bin", HOME: "/home/u", GH_TOKEN: "a", GITHUB_ENTERPRISE_TOKEN: "b", SSH_AGENT_PID: "1", Npm_Config_Authtoken: "c", AWS_PRIVATE_KEY_FILE: "d", my_apikey: "e", DB_PASSWD: "f", GIT_CONFIG_GLOBAL: "/home/u/.gitconfig" };
		const env = containedEnv(base, "/scratch");
		for (const name of ["GH_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "SSH_AGENT_PID", "Npm_Config_Authtoken", "AWS_PRIVATE_KEY_FILE", "my_apikey", "DB_PASSWD"]) {
			assert.ok(name in env && env[name] === undefined, `${name} removed (present as undefined, so it overrides process.env)`);
		}
		assert.equal(env.PATH, "/bin");
		assert.equal(env.HOME, "/home/u");
		assert.equal(env.GIT_CONFIG_GLOBAL, "/home/u/.gitconfig", "user.name and user.email keep working");
		assert.equal(env.GH_CONFIG_DIR, "/scratch/gh");
		assert.equal(env.GIT_SSH_COMMAND, "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none");
		assert.equal(env.GCM_INTERACTIVE, "never");
		assert.equal(env.SSH_ASKPASS, "/usr/bin/false");
		assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_0, env.GIT_CONFIG_VALUE_0, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2], ["3", "credential.helper", "", "core.hooksPath", "/dev/null", "core.fsmonitor", "false"]);
		assert.equal(base.GH_TOKEN, "a", "the base is not modified");
	});

	it("appends to the git config entries the base already has", () => {
		const env = containedEnv({ GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "user.name", GIT_CONFIG_VALUE_0: "U" }, "/s");
		assert.equal(env.GIT_CONFIG_COUNT, "4");
		assert.equal(env.GIT_CONFIG_KEY_0, "user.name");
		assert.equal(env.GIT_CONFIG_KEY_1, "credential.helper");
		assert.equal(env.GIT_CONFIG_KEY_3, "core.fsmonitor");
	});

	it("a child spawned with it over process.env has none of the secrets (Node's spawn skips undefined values)", () => {
		const env = containedEnv(process.env, "/scratch");
		const result = spawnSync("env", [], { env: { ...process.env, ...env }, encoding: "utf8" });
		assert.equal(result.status, 0);
		assert.ok(!/GH_TOKEN|ANTHROPIC_API_KEY|DEPLOY_SECRET|SSH_AUTH_SOCK/.test(result.stdout), result.stdout);
		assert.match(result.stdout, /^GH_CONFIG_DIR=\/scratch\/gh$/m);
	});

	it("git sees the forced config: no credential helper, no hooks, no fsmonitor, and still user.name", () => {
		const env = { ...process.env, ...containedEnv(process.env, "/scratch") };
		const list = spawnSync("git", ["config", "--show-scope", "--list"], { cwd: ws.repo, env, encoding: "utf8" }).stdout;
		assert.match(list, /command\s+core\.hookspath=\/dev\/null/i);
		assert.match(list, /command\s+core\.fsmonitor=false/);
		assert.match(list, /command\s+credential\.helper=$/m);
	});

	it("hardenGitEnv adds only the hook and fsmonitor entries, after the existing ones", () => {
		const env: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "a.b", GIT_CONFIG_VALUE_0: "c" };
		hardenGitEnv(env);
		assert.deepEqual([env.GIT_CONFIG_COUNT, env.GIT_CONFIG_KEY_1, env.GIT_CONFIG_VALUE_1, env.GIT_CONFIG_KEY_2, env.GIT_CONFIG_VALUE_2], ["3", "core.hooksPath", "/dev/null", "core.fsmonitor", "false"]);
	});
});

describe("the processes that run the agent's code (B1)", () => {
	it("the worker's bash, the ticket's done command, and the check tool's suite all see the contained environment", async () => {
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: a deps: none done: `env > done-env.txt && test -f t1.txt` — pending"]));
		const worker = makeWorker({ T1: [bash("env"), check({ command: "env > check-env.txt; true" }), ...commitFile("t1.txt")] });
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		const outcome = await runner.settle(id);
		assert.equal(outcome.status, "completed", JSON.stringify(outcome));

		const bashDump = worker.results.find((result) => /^PATH=/m.test(result.text))?.text;
		assert.ok(bashDump, "the worker's `env` ran");
		assertContained(bashDump, "worker bash");
		assert.ok(existsSync(join(ws.repo, "check-env.txt")), "the check tool ran the command");
		assertContained(readFileSync(join(ws.repo, "check-env.txt"), "utf8"), "check tool");
		assertContained(readFileSync(join(ws.repo, "done-env.txt"), "utf8"), "done command");

		// The scratch directory is the runner's own, and it is gone when the runner closes.
		const scratch = dirname(/^GH_CONFIG_DIR=(.*)$/m.exec(bashDump)![1]);
		assert.ok(existsSync(join(scratch, "gh")), "the empty gh config dir exists while the runner is open");
		await runner.close();
		runner = undefined;
		assert.ok(!existsSync(scratch), "removed on close");
	});

	it("the PR loop's final-check suite is contained, and its own git and gh calls keep the real environment", async () => {
		// The suite writes its environment outside the tree (the tree must not change while the suite runs); the ticket commits a doc only, which needs no test evidence.
		isolation.settings({ check: { test: "env > ../suite-env.txt" } });
		const gh = new FakeGh(addRemote(ws));
		const seen: Array<{ command: string; env: unknown }> = [];
		const prDeps: PrDeps = { ...prDepsOf(gh), exec: (command, args, options) => (seen.push({ command, env: (options as { env?: unknown }).env }), gh.exec(command, args, options)) };
		const clock = fakeClock();
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: a deps: none done: `test -f t1.md` — pending"]));
		const worker = makeWorker({ T1: [bash("echo x >> t1.md"), bash(`git add -A && ${GIT_COMMIT} -m docs`)] });
		runner = await openFixtureRunner(ws, worker, { clock, prDeps });
		const id = await runner.start(ws.docPath, { pr: true });
		await until(() => (existsSync(join(ws.root, "suite-env.txt")) ? true : undefined), "the final-check suite");
		await until(async () => ((await runner!.status(id)).pr?.phase === "wait-ci" ? true : undefined), "the PR loop at wait-ci");
		assertContained(readFileSync(join(ws.root, "suite-env.txt"), "utf8"), "final-check suite");
		assert.ok(seen.some((call) => call.command === "git") && seen.some((call) => call.command === "gh"), "the PR loop ran git and gh");
		assert.ok(seen.every((call) => call.env === undefined), "git and gh calls pass no environment: they inherit the runner's own (the real one)");
	});
});
