// DSP: a test runner that loads files with remote-looking text (fixtures, string literals) runs locked without asking;
// a remote action typed in the command line, or loaded by anything that is not a test runner, still asks.
import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { auditKind, decideDspCommand, isAutoAllowedForAudit } from "../lib/dsp-policy.ts";
import { fakeExec, realTmp, writeTree } from "./dsp-fixtures.test.ts";

const home = realTmp("dsp-runner-home-");
const temp = realTmp("dsp-runner-temp-");

/** A fixture project: a test file that mentions pushes as text, an import that does too, a package.json, and two plain scripts. */
function project(extra: Record<string, string> = {}): string {
	const root = realTmp("dsp-runner-project-");
	writeTree(root, {
		"tests/a.test.ts": ['import { execSync } from "node:child_process";', 'import { helper } from "./lib/helper.ts";', 'execSync("git push origin main");', 'const text = "gh pr create --title t";', ""].join("\n"),
		"lib/helper.ts": 'export const helper = () => "git push --force origin main";\n',
		"tests/clean.test.ts": 'import { it } from "node:test";\nit("x", () => {});\n',
		"deploy.sh": "#!/bin/sh\ngit push origin main\n",
		"x.js": 'require("child_process").execSync("git push");\n',
		"package.json": JSON.stringify({ scripts: { test: "node --test tests/a.test.ts", deploy: "git push" } }),
		...extra,
	});
	return root;
}

async function run(command: string, root: string) {
	const result = await decideDspCommand({ command, cwd: root, projectRoot: root, home, tempRoots: [temp], exec: fakeExec({ branch: "feat/x" }) });
	return result;
}

const lockedWithoutAsking = (result: Awaited<ReturnType<typeof run>>, command: string) => {
	assert.equal(result.decision.action, "allow", command);
	assert.ok("testRunner" in result.decision && result.decision.testRunner === true, `${command}: marked as a test runner`);
	assert.equal(isAutoAllowedForAudit(result), true, `${command}: goes to the audit log`);
	assert.equal(auditKind(result), "test-runner-locked", command);
};

const asksForRemote = (result: Awaited<ReturnType<typeof run>>, command: string) => {
	assert.equal(result.decision.action, "confirm-remote", command);
	assert.equal(isAutoAllowedForAudit(result), false, command);
	assert.notEqual(auditKind(result), "test-runner-locked", command);
};

describe("a test runner that loads files with remote text runs locked, without asking", () => {
	it("control: the same test file run as a plain script asks", async () => {
		const root = project();
		asksForRemote(await run("node tests/a.test.ts", root), "node tests/a.test.ts");
	});

	it("node --test over a file and its imports", async () => {
		const root = project();
		for (const command of [
			"node --test tests/a.test.ts",
			"node --test tests/a.test.ts tests/clean.test.ts",
			"node --test --test-name-pattern foo tests/a.test.ts",
			"node --test-only --test tests/a.test.ts",
			"node --experimental-test-coverage --test tests/a.test.ts",
			"node --import ./lib/helper.ts --test tests/a.test.ts",
			"nodejs --test tests/a.test.ts",
			"cd tests && node --test a.test.ts",
			"env FOO=1 node --test tests/a.test.ts",
		]) {
			lockedWithoutAsking(await run(command, root), command);
		}
	});

	it("the command the user saw: four test files and the output redirected", async () => {
		const root = project({ "tests/b.test.ts": 'execSync("gh pr create");\n', "tests/c.test.ts": 'const f = "git push";\n' });
		const command = "node --test tests/a.test.ts tests/b.test.ts tests/c.test.ts > /tmp/brigadev-focused.log 2>&1";
		lockedWithoutAsking(await run(command, root), command);
	});

	it("npm test and its spellings, through the package.json test script", async () => {
		const root = project();
		for (const command of ["npm test", "npm t", "npm run test", "npm test -- --watch", "pnpm test", "pnpm run test", "yarn test", "bun run test"]) {
			lockedWithoutAsking(await run(command, root), command);
		}
	});

	it("python -m pytest, and a runner binary whose own text is the command", async () => {
		const root = project({
			"tests/test_a.py": 'import subprocess\nsubprocess.run(["git", "push"])\n',
			"node_modules/.bin/vitest": '#!/usr/bin/env node\nrequire("child_process").execSync("git push");\n',
		});
		lockedWithoutAsking(await run("python -m pytest tests/test_a.py", root), "python -m pytest");
		lockedWithoutAsking(await run("python3 -m pytest tests/test_a.py", root), "python3 -m pytest");
		// The runner binary is the command, not a file the runner loads: its own text asks.
		asksForRemote(await run("./node_modules/.bin/vitest run", root), "./node_modules/.bin/vitest run");
		asksForRemote(await run("python tests/test_a.py", root), "python tests/test_a.py");
	});

	it("text in a loaded file the scan cannot read (a variable, a file written in a fixture) does not ask either", async () => {
		const root = project({ "tests/vars.test.ts": 'const cmd = "git $SUB";\nrun("bash $SCRIPT");\n' });
		const command = "node --test tests/vars.test.ts";
		lockedWithoutAsking(await run(command, root), command);
		assert.equal((await run("node tests/vars.test.ts", root)).decision.action, "confirm", "control: as a plain script it asks");
		assert.equal((await run("node --test tests/vars.test.ts && bash $SCRIPT", root)).decision.action, "confirm", "typed in the command line it still asks");
	});

	it("runners that read nothing stay plain allows", async () => {
		const root = project();
		for (const command of ["npx vitest run", "vitest", "jest --ci", "mocha", "pytest -q", "go test ./...", "cargo test", "npx tap", "npx ava"]) {
			const result = await run(command, root);
			assert.equal(result.decision.action, "allow", command);
			assert.equal(auditKind(result) === "test-runner-locked", false, command);
		}
	});
});

describe("a remote action in the command line, or run by anything else, still asks", () => {
	it("a push or a PR typed next to the runner", async () => {
		const root = project();
		for (const command of [
			"node --test tests/a.test.ts && git push",
			"node --test tests/a.test.ts; gh pr create",
			"npm test; gh pr create",
			"npm test && git push origin feat/x",
			"git push && npm test",
			"node --test tests/clean.test.ts && git push",
			"node --test tests/a.test.ts | git push",
		]) {
			asksForRemote(await run(command, root), command);
		}
	});

	it("a script that is not a test runner", async () => {
		const root = project();
		for (const command of ["bash deploy.sh", "./deploy.sh", "node x.js", "node tests/a.test.ts", "npm run deploy", "node --test tests/a.test.ts && bash deploy.sh", "bash deploy.sh && npm test"]) {
			asksForRemote(await run(command, root), command);
		}
	});

	it("--test passed to the script, not to node", async () => {
		const root = project();
		asksForRemote(await run("node x.js --test", root), "node x.js --test");
		asksForRemote(await run("node tests/a.test.ts --test", root), "node tests/a.test.ts --test");
	});

	it("other DSP rules keep their say", async () => {
		const root = project();
		const outside = await run(`node --test tests/a.test.ts && rm -rf ${join(home, "important")}`, root);
		assert.equal(outside.decision.action, "confirm");
		assert.equal(isAutoAllowedForAudit(outside), false);
		const clean = await run("node --test tests/clean.test.ts", root);
		assert.equal(clean.decision.action, "allow");
		assert.equal(auditKind(clean) === "test-runner-locked", false, "nothing was found: nothing to log as locked");
	});

	it("a runner on the default branch still asks about what it would commit there", async () => {
		const root = project();
		const result = await decideDspCommand({ command: "node --test tests/a.test.ts && git commit -m x", cwd: root, projectRoot: root, home, tempRoots: [temp], exec: fakeExec({ branch: "main", originHead: "main" }) });
		assert.equal(result.decision.action, "confirm-remote");
	});
});
