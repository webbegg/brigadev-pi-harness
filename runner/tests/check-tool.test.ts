// A3, A4 (S5): the worker's `check` tool records evidence the commit gate trusts, and the gate decides the worker's commits
// end-to-end through the loop (faux model, fixture repo, evidence/docs dirs in a temp BRIGADEV_HOME so ~/.brigadev is never written).
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { evidenceFile, readEvidence, type RunRecord } from "../../lib/evidence.ts";
import { repoDocsDir } from "../../lib/repo-docs.ts";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { createCheckTool } from "../src/check-tool.ts";
import { check, docText, FEATURE_BRANCH, git, GIT_COMMIT, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, writeFile, bash, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";

let env: Isolation;
let ws: Workspace;
let runner: FixtureRunner | undefined;
before(() => {
	env = isolateEnv();
});
after(() => env.restore());
beforeEach(() => {
	env.settings({});
	// Every test starts with no evidence: the log is per repo name and branch, which every fixture workspace shares.
	rmSync(env.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const evidencePath = () => evidenceFile(repoDocsDir(ws.repo), FEATURE_BRANCH);
const runs = () => readEvidence(evidencePath()).filter((record): record is RunRecord => record.type === "run");

function toolFor(settings: object) {
	return createCheckTool({ cwd: ws.repo, settings: () => settings as never });
}
async function call(settings: object, args: Record<string, unknown> = {}) {
	const tool = toolFor(settings);
	// The tool reads the conversation's cwd from `api.agent()` only.
	const api = { agent: async () => ({ cwd: ws.repo }) } as never;
	const result = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
	assert.ok("output" in result, "a result, not a park");
	const text = (result.output ?? []).map((part) => (part.type === "text" ? part.text : "")).join("\n");
	return { text, isError: result.isError === true, details: result.details as { outcome?: string; recorded?: boolean; command?: string } | undefined };
}

describe("check tool (A3)", () => {
	it("has the extension's parameters: command, focus, timeoutSeconds, all optional, and the name `check`", () => {
		const tool = toolFor({});
		assert.equal(tool.name, "check");
		const schema = tool.parameters as { properties: Record<string, unknown>; required?: string[] };
		assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "focus", "timeoutSeconds"]);
		assert.deepEqual(schema.required ?? [], []);
	});

	it("runs the configured test command, shapes a compact PASS result, and records a passing run with agent runner-worker", async () => {
		const result = await call({ check: { test: "true" } });
		assert.match(result.text, /^PASS exit=0 [\d.]+s: true/);
		assert.equal(result.isError, false);
		assert.equal(result.details?.outcome, "pass");
		assert.equal(result.details?.recorded, true);
		const [record, ...rest] = runs();
		assert.equal(rest.length, 0);
		assert.equal(record.agent, "runner-worker");
		assert.equal(record.kind, "test");
		assert.equal(record.outcome, "pass");
		assert.equal(record.branch, FEATURE_BRANCH);
		assert.ok(evidencePath().startsWith(env.brigadevHome), "the evidence lives under the temp BRIGADEV_HOME");
	});

	it("records a failing run as fail, with the failing tail in the result", async () => {
		const result = await call({}, { command: "node --test --test-reporter=tap /nonexistent-dir-for-check" });
		assert.match(result.text, /^FAIL exit=/);
		assert.equal(runs().at(-1)?.outcome, "fail");
	});

	it("appends the focus to the command", async () => {
		const result = await call({ check: { test: "echo" } }, { focus: "hello" });
		assert.match(result.text, /^PASS exit=0 [\d.]+s: echo hello/);
	});

	it("refuses a delivery, destructive, or publish command (the same refusal as the extension) and records nothing", async () => {
		for (const command of ["git push", "git commit -m x", "rm -rf build", "npm publish"]) {
			const result = await call({}, { command });
			assert.equal(result.isError, true, command);
			assert.match(result.text, /^Error: check runs tests; use bash for commits, pushes/, command);
		}
		assert.equal(existsSync(evidencePath()), false);
	});

	it("errors when no test command can be resolved", async () => {
		const result = await call({});
		assert.equal(result.isError, true);
		assert.match(result.text, /No test command found/);
	});

	it("a command that is not a test run says so and leaves no record (it cannot vouch for a commit)", async () => {
		const result = await call({ check: { test: "true" } }, { command: "echo ok" });
		assert.match(result.text, /Not recorded as test evidence/);
		assert.equal(existsSync(evidencePath()), false);
	});
});

describe("commit gate end-to-end (A2, A4)", () => {
	const A_TS = "export const a = 1;\n";
	const COMMIT = `git add -A && ${GIT_COMMIT} -m "add a.ts"`;
	const TICKET = "- T1 [S1] inline: add a deps: none done: `test -f a.ts` — pending";

	async function run(steps: Parameters<typeof makeWorker>[0]) {
		writeFileSync(ws.docPath, docText([TICKET]));
		env.settings({ check: { test: "true" } });
		const worker = makeWorker(steps);
		runner = await openFixtureRunner(ws, worker);
		const outcome = await runner.wait(await runner.start(ws.docPath, { maxAttempts: 2 }));
		return { worker, outcome };
	}

	it("(a) a worker that commits without running `check` is blocked, the ticket retries and then fails", async () => {
		const { worker, outcome } = await run({ T1: [writeFile("a.ts", A_TS), bash(COMMIT)] });
		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T1"] } });
		assert.equal(worker.prompts.length, 2, "two attempts");
		const gate = worker.results.filter((r) => r.isError && /Blocked by brigadev evidence gate: no passing test is recorded/.test(r.text));
		assert.equal(gate.length, 2, "the gate's reason reached the worker in each attempt");
		assert.equal(git(ws.repo, "rev-list", "--count", "HEAD"), "1", "no commit was made");
		assert.match(ticketLine(readDoc(ws), "T1"), /— blocked needs you: no commit/);
		assert.equal(existsSync(evidencePath()), false, "nothing was recorded: the worker never ran check");
	});

	it("(b) a worker that runs `check` (passing) and then commits succeeds; the ticket ends done", async () => {
		const { worker, outcome } = await run({ T1: [writeFile("a.ts", A_TS), check(), bash(COMMIT)] });
		assert.deepEqual(outcome, { status: "completed", result: { status: "done", tickets: [{ id: "T1", status: "done" }] } });
		assert.equal(worker.prompts.length, 1);
		assert.match(worker.results[1].text, /^PASS exit=0/, "the check result reached the worker");
		assert.equal(git(ws.repo, "rev-list", "--count", "HEAD"), "2");
		assert.deepEqual(parseTicketList(readDoc(ws)).tickets.map((t) => t.status), ["done"]);
		const [record] = runs();
		assert.equal(record.agent, "runner-worker");
		assert.equal(record.outcome, "pass");
		assert.ok(JSON.parse(readFileSync(evidencePath(), "utf8").split("\n")[0]).tree, "the run is bound to the working tree");
	});

	it("a worker that edits after `check` is blocked: the passing run no longer matches the tree", async () => {
		const { worker } = await run({ T1: [writeFile("a.ts", A_TS), check(), writeFile("a.ts", `${A_TS}export const b = 2;\n`), bash(COMMIT)] });
		assert.ok(worker.results.some((r) => r.isError && /evidence gate/.test(r.text)), "blocked by the gate");
		assert.equal(git(ws.repo, "rev-list", "--count", "HEAD"), "1");
	});

	it("a failing `check` does not unlock the commit", async () => {
		env.settings({ check: { test: "false" } });
		writeFileSync(ws.docPath, docText([TICKET]));
		const worker = makeWorker({ T1: [writeFile("a.ts", A_TS), check(), bash(COMMIT)] });
		runner = await openFixtureRunner(ws, worker);
		await runner.wait(await runner.start(ws.docPath, { maxAttempts: 1 }));
		assert.match(worker.results[1].text, /^FAIL exit=1/);
		assert.match(worker.results[2].text, /the last test run on this tree failed/);
		assert.equal(git(ws.repo, "rev-list", "--count", "HEAD"), "1");
	});

	it("the worker cannot write the evidence log to forge a pass", async () => {
		const forge = `echo '{"v":1,"type":"run","kind":"test","outcome":"pass"}' >> ${evidencePath()}`;
		const { worker } = await run({ T1: [bash(forge), writeFile(evidencePath(), "{}")] });
		assert.equal(worker.results.filter((r) => r.isError && /evidence log is written only by the recorder/.test(r.text)).length >= 2, true);
		assert.equal(existsSync(evidencePath()), false);
	});

	it("`git push` from the worker is blocked with the runner-owns-delivery reason", async () => {
		const { worker } = await run({ T1: [bash("git push origin HEAD")] });
		assert.ok(worker.results.some((r) => r.isError && /the runner owns PR delivery/.test(r.text)));
	});
});
