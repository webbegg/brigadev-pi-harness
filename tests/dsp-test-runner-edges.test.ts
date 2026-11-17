// DSP test runner, edges (verification findings): what counts as a runner, what stays typed in the command line,
// and what a package.json script may hide. A runner exempts only the files IT loads; the command line, the runner's
// own head file and every non-runner segment keep asking.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { auditKind, decideDspCommand, isAutoAllowedForAudit } from "../lib/dsp-policy.ts";
import { fakeExec, realTmp, writeTree } from "./dsp-fixtures.test.ts";

const home = realTmp("dsp-edges-home-");
const temp = realTmp("dsp-edges-temp-");

const PUSHES = 'import { execSync } from "node:child_process";\nexecSync("git push origin main");\n';

function project(extra: Record<string, string> = {}, scripts: Record<string, string> = { test: "node --test tests/a.test.ts" }): string {
	const root = realTmp("dsp-edges-project-");
	writeTree(root, {
		"tests/a.test.ts": ['import { helper } from "./lib/helper.ts";', PUSHES].join("\n"),
		"lib/helper.ts": 'export const helper = () => "git push --force origin main";\n',
		"tests/uses-helper.test.js": 'require("./lib/helper.js");\n',
		"lib/helper.js": 'require("child_process").execSync("git push");\n',
		"tests/clean.test.ts": 'import { it } from "node:test";\nit("x", () => {});\n',
		"tests/test_a.py": 'import subprocess\nsubprocess.run(["git", "push"])\n',
		"deploy.py": 'import subprocess\nsubprocess.run(["git", "push", "origin", "main"])\n',
		"deploy.sh": "#!/bin/sh\ngit push origin main\n",
		"b.js": 'require("child_process").execSync("git push");\n',
		"package.json": JSON.stringify({ scripts }),
		...extra,
	});
	return root;
}

async function run(command: string, root: string, branch = "feat/x") {
	return decideDspCommand({ command, cwd: root, projectRoot: root, home, tempRoots: [temp], exec: fakeExec({ branch }) });
}
type Result = Awaited<ReturnType<typeof run>>;

const isLocked = (result: Result) => (result.decision.action === "allow" || result.decision.action === "allow-with-backup") && result.decision.testRunner === true;
const locked = (result: Result, command: string) => {
	assert.equal(result.decision.action, "allow", command);
	assert.equal(isLocked(result), true, `${command}: marked as a test runner`);
	assert.equal(isAutoAllowedForAudit(result), true, command);
	assert.equal(auditKind(result), "test-runner-locked", command);
};
const notLocked = (result: Result, command: string) => {
	assert.equal(isLocked(result), false, `${command}: must not be a test-runner allow`);
	assert.notEqual(auditKind(result), "test-runner-locked", command);
};
const asks = (result: Result, command: string) => {
	assert.ok(result.decision.action === "confirm-remote" || result.decision.action === "confirm", `${command}: asks (got ${result.decision.action})`);
	notLocked(result, command);
};
const asksForRemote = (result: Result, command: string) => {
	assert.equal(result.decision.action, "confirm-remote", command);
	notLocked(result, command);
};

describe("python: -m pytest counts only before the script", () => {
	it("`-m pytest` after the script word belongs to the script", async () => {
		const root = project();
		for (const command of ["python3 deploy.py -m pytest", "python deploy.py -m pytest tests", "python3 deploy.py -mpytest", "python3 deploy.py --flag -m pytest"]) {
			asksForRemote(await run(command, root), command);
		}
	});

	it("`-m pytest` before the script, in the spellings Python accepts", async () => {
		const root = project();
		for (const command of ["python3 -m pytest tests/test_a.py", "python -m pytest tests/test_a.py", "python3 -mpytest tests/test_a.py", "python3 -W error -m pytest tests/test_a.py", "python3 -X dev -m pytest tests/test_a.py", "python3 -u -m pytest tests/test_a.py"]) {
			locked(await run(command, root), command);
		}
	});

	it("`-c` is inline code, not a runner", async () => {
		const root = project();
		for (const command of ["python3 -c 'import os' -m pytest", `python3 -c 'import subprocess; subprocess.run(["git","push"])' -m pytest`]) {
			notLocked(await run(command, root), command);
		}
		asks(await run(`python3 -c 'import subprocess; subprocess.run(["git","push"])' -m pytest`, root), "inline push");
	});

	it("other modules and other scripts are not pytest", async () => {
		const root = project();
		for (const command of ["python3 -m deploy tests/test_a.py", "python3 -m pytestx tests/test_a.py", "python3 tests/test_a.py"]) {
			notLocked(await run(command, root), command);
		}
		asksForRemote(await run("python3 tests/test_a.py", root), "python3 tests/test_a.py");
	});
});

describe("a remote action in the command line joined to a runner never becomes test-runner-locked", () => {
	const joined = [
		"node --test tests/a.test.ts $(git push)",
		"node --test tests/a.test.ts `git push`",
		"node --test tests/a.test.ts || git push",
		"node --test tests/a.test.ts & git push",
		"(node --test tests/a.test.ts; git push)",
		"{ node --test tests/a.test.ts; git push; }",
		"node --test tests/a.test.ts > >(git push)",
		"sh -c 'node --test tests/a.test.ts && git push'",
		"env node --test tests/a.test.ts && git push",
		"node --test tests/a.test.ts && git push",
		"node --test tests/a.test.ts; gh pr create",
		"node --test --eval 'require(\"child_process\").execSync(\"git push\")' tests/a.test.ts",
		"node --test -e 'require(\"child_process\").execSync(\"git push\")' tests/a.test.ts",
		"GIT_SSH_COMMAND=ssh node --test tests/a.test.ts",
		"env -u SSH_AUTH_SOCK node --test tests/a.test.ts",
		"npm_config_userconfig=/dev/null npm test",
	];
	for (const command of joined) {
		it(command, async () => {
			const root = project();
			asks(await run(command, root), command);
		});
	}
});

describe("files the same command writes, and --import data:, are not exempt", () => {
	it("a test file written and run in one command asks", async () => {
		const root = project();
		for (const command of [
			`echo 'execSync("git push")' > tests/new.test.ts && node --test tests/new.test.ts`,
			`printf 'x' >> tests/a.test.ts && node --test tests/a.test.ts`,
			`cat > tests/b.test.ts <<'EOF'\nexecSync("git push")\nEOF\nnode --test tests/b.test.ts`,
		]) {
			asks(await run(command, root), command);
		}
	});

	it("--import data: code is typed in the command line", async () => {
		const root = project();
		const command = `node --import 'data:text/javascript,import("node:child_process").then((c)=>c.execSync("git push"))' --test tests/clean.test.ts`;
		asks(await run(command, root), command);
	});
});

describe("marks do not leak between segments", () => {
	it("a runner loading a helper, then a plain script", async () => {
		const root = project();
		locked(await run("node --test tests/uses-helper.test.js", root), "node --test tests/uses-helper.test.js");
		for (const command of ["node --test tests/uses-helper.test.js; node b.js", "node --test tests/uses-helper.test.js && node lib/helper.js", "node b.js; node --test tests/uses-helper.test.js", "node --test tests/uses-helper.test.js && bash deploy.sh", "node --test tests/uses-helper.test.js | node b.js"]) {
			asksForRemote(await run(command, root), command);
		}
	});
});

describe("a runner head counts only as a bare name or node_modules/.bin/<runner>", () => {
	const body = 'require("child_process").execSync("git push origin main");\n';

	it("a file run by path whose name is a runner's is the command, and it asks", async () => {
		const root = project({ jest: body, "scripts/vitest": body, pytest: body, "tools/mocha": body });
		for (const command of ["./jest", "./jest --ci", "scripts/vitest", "./scripts/vitest run", "./pytest", "./pytest -q", "npx ./jest", "npx ./pytest", "./tools/mocha", "../jest"]) {
			const cwd = command === "../jest" ? join(root, "scripts") : root;
			asksForRemote(await run(command, cwd), command);
		}
	});

	it("the head file under node_modules/.bin is the command, not a file the runner loads", async () => {
		const root = project({ "node_modules/.bin/vitest": '#!/usr/bin/env node\n' + body, "node_modules/.bin/jest": "#!/usr/bin/env node\nconsole.log('jest');\n" });
		for (const command of ["./node_modules/.bin/vitest run", "node_modules/.bin/vitest run", "../node_modules/.bin/vitest", "npx ./node_modules/.bin/vitest"]) {
			const cwd = command.startsWith("../") ? join(root, "tests") : root;
			asksForRemote(await run(command, cwd), command);
		}
		// A clean head is a plain run; nothing to log as locked.
		for (const command of ["./node_modules/.bin/jest --ci", "node_modules/.bin/jest"]) {
			const result = await run(command, root);
			assert.equal(result.decision.action, "allow", command);
			notLocked(result, command);
		}
	});

	it("a bare name resolved from PATH still counts", async () => {
		const root = project();
		for (const command of ["vitest run", "jest --ci", "npx vitest", "pytest -q", "mocha"]) {
			const result = await run(command, root);
			assert.equal(result.decision.action, "allow", command);
			notLocked(result, command);
		}
	});

	it("an absolute or odd path to node or python is not a bare runner head", async () => {
		const root = project({ "bin/node": body });
		for (const command of ["./bin/node --test tests/a.test.ts", "bin/node --test tests/a.test.ts"]) {
			asksForRemote(await run(command, root), command);
		}
	});
});

describe("package.json scripts are read like a command line", () => {
	const scripts = (extra: Record<string, string>) => ({ test: "node --test tests/a.test.ts", ...extra });

	it("`npm test` whose test script is `node --test <files>` is locked, with pre/post scripts that run tests too", async () => {
		const root = project({}, scripts({ pretest: "node --test tests/clean.test.ts", posttest: "node --test tests/uses-helper.test.js" }));
		for (const command of ["npm test", "npm t", "npm run test", "pnpm test", "yarn test", "bun run test"]) locked(await run(command, root), command);
	});

	it("a script that runs another script that runs the tests", async () => {
		const root = project({}, { test: "npm run unit", unit: "node --test tests/a.test.ts" });
		locked(await run("npm test", root), "npm test");
	});

	it("`npm test` is no longer the runner: what the body says decides", async () => {
		const bodies: Record<string, Record<string, string>> = {
			"pretest pushes": { pretest: "git push origin HEAD:main --force" },
			"posttest publishes": { posttest: "npm publish" },
			"test pushes": { test: "git push" },
			"test runs a script that pushes": { test: "node b.js" },
			"test runs a shell script that pushes": { test: "bash deploy.sh" },
			"test pushes after the runner": { test: "node --test tests/a.test.ts && git push" },
			"test pushes before the runner": { test: "git push; node --test tests/a.test.ts" },
			"test runs a substitution": { test: "node --test tests/a.test.ts $(git push)" },
			"test sets the lock aside": { test: "GIT_SSH_COMMAND=ssh node --test tests/a.test.ts" },
			"pretest runs a plain script, test runs the tests": { pretest: "node b.js", test: "node --test tests/clean.test.ts" },
			"nested script pushes": { test: "npm run deploy", deploy: "git push" },
			"gh pr": { posttest: "gh pr create --fill" },
		};
		for (const [label, extra] of Object.entries(bodies)) {
			const root = project({}, scripts(extra));
			for (const command of ["npm test", "npm run test", "pnpm test"]) asksForRemote(await run(command, root), `${label}: ${command}`);
		}
	});

	it("a body with the push in the command line shows it in the dialog next to what the tests loaded", async () => {
		const root = project({}, scripts({ test: "node --test tests/a.test.ts && git push origin main" }));
		const result = await run("npm test", root);
		assert.equal(result.decision.action, "confirm-remote");
		const labels = result.decision.action === "confirm-remote" ? result.decision.items.map((item) => item.label) : [];
		assert.ok(labels.some((label) => label === "npm script test runs push"), labels.join("\n"));
		assert.ok(labels.some((label) => /script tests\/a\.test\.ts runs/.test(label)), labels.join("\n"));
	});

	it("a script that runs no tests and says nothing remote is a plain allow", async () => {
		const root = project({}, { test: "node --test tests/clean.test.ts" });
		const result = await run("npm test", root);
		assert.equal(result.decision.action, "allow");
		notLocked(result, "npm test");
	});
});

describe("the focused command the user runs against this repository", () => {
	it("node --test with file arguments and the log redirected auto-allows", async () => {
		const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
		const command = "node --test tests/guard-rules.test.ts tests/outside-writes.test.ts tests/guard-outside-writes.test.ts tests/dsp-guard.test.ts > /tmp/brigadev-focused.log 2>&1";
		const result = await decideDspCommand({ command, cwd: repo, projectRoot: repo, home, tempRoots: [temp, "/tmp", "/private/tmp"], exec: fakeExec({ branch: "feat/x" }) });
		assert.equal(result.decision.action, "allow", JSON.stringify(result.decision));
	});
});
