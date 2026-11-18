// S13: the `check` tool runs a real test command through the fake pi, returns the compact summary, and records evidence the commit gate trusts.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { decideCommitGate, evidenceFile, readEvidence, type RunRecord } from "../lib/evidence.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { createFakeCtx, createFakePi, type FakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, plain: string;
let uninstall: () => void;
let pi: FakePi;

const PASSING = `import { test } from "node:test";\ntest("adds", () => {});\ntest("adds more", () => {});\n`;
const FAILING = `import { test } from "node:test";\nimport assert from "node:assert";\ntest("breaks", () => { assert.equal(1, 2); });\n`;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
const run = (params: Record<string, unknown>, options: { cwd?: string; signal?: AbortSignal } = {}) => pi.tool("check").execute("call-1", params, options.signal, undefined, createFakeCtx({ cwd: options.cwd ?? repo }));
const text = (result: any): string => result.content.map((part: any) => part.text).join("\n");
const records = (): RunRecord[] => readEvidence(evidenceFile(repoDocsDir(repo), "main")).filter((r): r is RunRecord => r.type === "run");

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "check-extension-")));
	repo = join(dir, "repo");
	plain = join(dir, "plain");
	mkdirSync(repo, { recursive: true });
	mkdirSync(plain, { recursive: true });
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
	process.env.BRIGADEV_HOME = join(dir, "home", ".brigadev");
	process.env.PI_CODING_AGENT_DIR = join(dir, "home", ".pi", "agent");
	// Output files and tree scratch folders land under the test's own folder and go with it.
	process.env.TMPDIR = join(dir, "tmp");
	mkdirSync(process.env.TMPDIR, { recursive: true });
	mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "pass.test.js"), PASSING.replace('import { test } from "node:test";', 'const { test } = require("node:test");'));
	writeFileSync(join(repo, "fail.test.js"), FAILING.replace('import { test } from "node:test";\nimport assert from "node:assert";', 'const { test } = require("node:test");\nconst assert = require("node:assert");'));
	uninstall = installPiStubs();
	const extension = (await import("../extensions/check.ts")).default;
	pi = createFakePi();
	pi.exec = async (command, args, options: any) => {
		try {
			return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0, killed: false };
		} catch (error: any) {
			return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: error.status ?? 1, killed: false };
		}
	};
	extension(pi);
});

after(() => {
	uninstall();
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

describe("check tool", () => {
	it("registers one tool with a small definition", () => {
		const tool = pi.tool("check");
		const size = (tool.description ?? "").length + JSON.stringify(tool.parameters).length;
		assert.ok(size <= 600, `tool definition is ${size} chars`);
		assert.deepEqual(Object.keys((tool.parameters as any).properties).sort(), ["command", "focus", "timeoutSeconds"]);
		assert.deepEqual((tool.parameters as any).required ?? [], []);
	});

	it("reports PASS with the counts and records a passing test run on the current tree", async () => {
		const result = await run({ command: "node --test", focus: "pass.test.js" });
		const out = text(result);
		assert.match(out.split("\n")[0], /^PASS exit=0 \d+\.\d+s: node --test pass\.test\.js$/);
		assert.match(out, /2 passed, 0 failed/);
		assert.notEqual(result.isError, true);

		const [record] = records();
		assert.ok(record, "no evidence record was written");
		assert.equal(record.kind, "test");
		assert.equal(record.outcome, "pass");
		assert.equal(record.exitCode, 0);
		assert.equal(record.command, "node --test pass.test.js");
		assert.equal(record.branch, "main");
		assert.equal(record.agent, "parent");
		assert.equal(record.root, repo);
		assert.match(record.tree ?? "", /^[0-9a-f]{40,}$/);
		assert.ok(record.srcTree);

		// The commit gate trusts it for the tree the run was keyed to.
		const decision = decideCommitGate({ dirtyPaths: ["pass.test.js"], tree: record.tree, sourceTree: record.srcTree, root: repo, elsewhere: false, records: records(), forcedTree: undefined });
		assert.equal(decision.action, "allow");
	});

	it("saves the full output to a file named in the result", async () => {
		const out = text(await run({ command: "node --test", focus: "pass.test.js" }));
		const file = /full output: (\S+)/.exec(out)?.[1];
		assert.ok(file && existsSync(file), `no output file in: ${out}`);
		assert.match(readFileSync(file, "utf8"), /ℹ pass 2/);
	});

	it("reports FAIL with the counts and the failing tail, and records a failing run", async () => {
		const before = records().length;
		const result = await run({ command: "node --test", focus: "fail.test.js" });
		const out = text(result);
		assert.match(out.split("\n")[0], /^FAIL exit=1 \d+\.\d+s: node --test fail\.test\.js$/);
		assert.match(out, /0 passed, 1 failed/);
		assert.match(out, /breaks/);

		const added = records().slice(before);
		assert.equal(added.length, 1);
		assert.equal(added[0].outcome, "fail");
		assert.equal(added[0].exitCode, 1);
		assert.equal(added[0].kind, "test");
		const decision = decideCommitGate({ dirtyPaths: ["fail.test.js"], tree: added[0].tree, sourceTree: added[0].srcTree, root: repo, elsewhere: false, records: [added[0]], forcedTree: undefined });
		assert.equal(decision.action, "block");
	});

	it("records the real exit code of a command no runner pattern recognizes", async () => {
		const before = records().length;
		const out = text(await run({ command: 'node -e "process.exit(3)"' }));
		assert.match(out.split("\n")[0], /^FAIL exit=3 /);
		const record = records()[before];
		assert.equal(record.kind, "test");
		assert.equal(record.outcome, "fail");
		assert.equal(record.exitCode, 3);
	});

	it("takes the runner's exit code through a pipe", async () => {
		const out = text(await run({ command: "node --test fail.test.js | tail -3" }));
		assert.match(out.split("\n")[0], /^FAIL exit=1 /);
	});

	it("asks for `command` when none is configured or detected, and records nothing", async () => {
		const before = records().length;
		const result = await run({});
		assert.equal(result.isError, true);
		assert.match(text(result), /`command`/);
		assert.equal(records().length, before);
	});

	it("uses the configured check.test command", async () => {
		writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "brigadev.json"), JSON.stringify({ check: { test: "node --test pass.test.js" } }));
		try {
			const out = text(await run({}));
			assert.match(out.split("\n")[0], /^PASS exit=0 .*: node --test pass\.test\.js$/);
		} finally {
			rmSync(join(process.env.PI_CODING_AGENT_DIR!, "brigadev.json"));
		}
	});

	it("times out, kills the run, and records it as unknown", async () => {
		const before = records().length;
		const started = Date.now();
		const out = text(await run({ command: 'node -e "setTimeout(() => {}, 60000)"', timeoutSeconds: 1 }));
		assert.ok(Date.now() - started < 15_000);
		assert.match(out.split("\n")[0], /^FAIL exit=timeout /);
		assert.equal(records()[before].outcome, "unknown");
	});

	it("stops when the signal aborts", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const started = Date.now();
		const out = text(await run({ command: 'node -e "setTimeout(() => {}, 60000)"' }, { signal: controller.signal }));
		assert.ok(Date.now() - started < 15_000);
		assert.match(out.split("\n")[0], /^FAIL exit=aborted /);
	});

	it("does not vouch for a tree that changed while the tests ran", async () => {
		const before = records().length;
		await run({ command: `node -e "require('fs').writeFileSync('scratch.txt', String(Date.now()))" && node --test pass.test.js` });
		const record = records()[before];
		assert.equal(record.outcome, "unknown");
		assert.equal(record.tree, undefined);
		assert.match(record.note ?? "", /tree changed/);
	});

	it("still reports a result outside git and writes no evidence", async () => {
		const out = text(await run({ command: "node -e \"console.log('ok')\"" }, { cwd: plain }));
		assert.match(out.split("\n")[0], /^PASS exit=0 /);
		assert.equal(existsSync(evidenceFile(repoDocsDir(plain), null)), false);
	});
});
