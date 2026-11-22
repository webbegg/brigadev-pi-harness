// S1 (post-0.24 follow-ups): a durable dollar cost cap per loop (a doc's `start`). The faux provider reports no cost, so these tests price every model response
// at $0.50 (`makeWorker(..., { price })`): a worker run of `commitFile` is four responses = $2.00 exactly, and N responses are N * $0.50 with no rounding.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { PromptState } from "../../lib/bus.ts";
import type { WebServer } from "../../lib/web-server.ts";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { createBoard, serveBoard, type ServedBoard } from "../src/board.ts";
import { main, startLoop, storePathFor } from "../src/cli.ts";
import { resumeLoop, statusText } from "../src/control.ts";
import { costBlock, DEFAULT_CAP, UsageDoc } from "../src/cost.ts";
import { POLL_MS, type PrDeps } from "../src/pr.ts";
import { createWebLog } from "../../lib/web-log.ts";
import { pauseLoop } from "../src/control.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";
import { bash, commitFile, context, docText, fakeClock, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";
import { addRemote, drivers, FakeGh, FAIL, PENDING, prDepsOf, until, verdict } from "./pr-fixture.ts";

let env: Isolation;
let cliEnv: Record<string, string | undefined>;
before(() => {
	env = isolateEnv();
	cliEnv = { BRIGADEV_HOME: process.env.BRIGADEV_HOME };
});
after(() => env.restore());

let ws: Workspace;
let gh: FakeGh;
let clock: ReturnType<typeof fakeClock>;
let runner: FixtureRunner | undefined;
let served: ServedBoard | undefined;
let dirs: string[] = [];
beforeEach(() => {
	env.settings({ check: { test: "true" } });
	rmSync(env.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
	gh = new FakeGh(addRemote(ws));
	clock = fakeClock();
});
afterEach(async () => {
	await served?.close();
	served = undefined;
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const PRICE = 0.5;
const T = (id: string, file: string) => `- ${id} [S1] inline: ${file.replace(/\.\w+$/, "")} deps: none done: \`test -f ${file}\` — pending`;
const T1 = T("T1", "t1.txt");
const T2 = T("T2", "t2.txt");
const T3 = T("T3", "t3.txt");
const statuses = () => Object.fromEntries(parseTicketList(readDoc(ws)).tickets.map((ticket) => [ticket.id, ticket.status]));
const escaped = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const worker3 = () => makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") }, { price: PRICE });

async function open(worker: ReturnType<typeof makeWorker>, options: { storage?: Awaited<ReturnType<typeof openNodeSqliteStorage>>; prDeps?: PrDeps } = {}) {
	runner = await openFixtureRunner(ws, worker, { clock, prDeps: options.prDeps ?? prDepsOf(gh), storage: options.storage });
	return runner;
}

async function sqlite() {
	const path = storePathFor(ws.repo, cliEnv);
	mkdirSync(dirname(path), { recursive: true });
	return openNodeSqliteStorage(path);
}

async function cli(args: string[], cwd = ws.repo) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, cliEnv, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, cwd);
	return { code, stdout, stderr };
}

// ---------------------------------------------------------------------------------------------------------------------

describe("the cap is checked at every boundary before new spend (a)", () => {
	it("before the next ticket: two tickets spend $4.00 of a $4.00 cap, the loop parks needs-you naming the spend and the cap, and the third ticket never starts", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = worker3();
		const r = await open(worker);
		const id = await r.start(ws.docPath, { cap: 4 });
		assert.deepEqual(await r.settle(id), { status: "waiting", paused: "cost cap reached: $4.00 of $4.00 spent", decisions: [] });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"], "T3 did not start");
		assert.deepEqual(statuses(), { T1: "done", T2: "done", T3: "pending" });
		const status = await r.status(id);
		assert.deepEqual([status.state, status.reason, status.kind, status.cost], ["paused", "cost cap reached: $4.00 of $4.00 spent", "cost", { spent: 4, cap: 4 }]);
		assert.ok(status.resumeKey, "a durable signal wait, like the other pauses");
	});

	it("before the next attempt of a ticket: a failed attempt counts, so a $1.00 cap parks the ticket (in_progress, needs you) instead of running attempt 2", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [bash("echo no commit yet")] : commitFile("t1.txt")) }, { price: PRICE });
		const r = await open(worker);
		const id = await r.start(ws.docPath, { cap: 1 });
		assert.deepEqual(await r.settle(id), { status: "waiting", paused: "cost cap reached: $1.00 of $1.00 spent", decisions: [] });
		assert.deepEqual(worker.prompts.map((p) => `${p.ticketId}#${p.run}`), ["T1#1"], "attempt 2 did not start");
		assert.deepEqual(statuses(), { T1: "in_progress" });
		assert.match(readDoc(ws), /T1.*needs you: cost cap reached: \$1\.00 of \$1\.00 spent/);
		assert.equal((await r.status(id)).cost?.spent, 1, "the failed attempt's two responses");
	});

	it("before verify: the PR loop stops needs-you with the spend and the cap, before anything is pushed, and no verify conversation exists", async () => {
		gh.checks = () => [PENDING];
		writeFileSync(ws.docPath, docText([T("T1", "auth.js")]));
		const worker = makeWorker({ T1: commitFile("auth.js"), VERIFY: [verdict()] }, { price: PRICE });
		const r = await open(worker);
		const id = await r.start(ws.docPath, { pr: true, cap: 2 });
		const d = drivers(() => r, gh, clock, POLL_MS);
		const stopped = await d.atStop(id);
		assert.equal(stopped.reason, "cost cap reached: $2.00 of $2.00 spent");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "no VERIFY conversation");
		assert.equal(gh.pushes().length, 0, "nothing was pushed");
		assert.equal((await r.status(id)).pr?.costCap, true);
		assert.equal((await r.status(id)).cost?.spent, 2);
	});

	it("before a FIX ticket: a failing final check stops needs-you at the cap instead of running FIX-1 (no PR yet: no comment, a Log line)", async () => {
		writeFileSync(ws.docPath, docText([T("T1", "app.js")]));
		let runs = 0;
		const prDeps: PrDeps = { ...prDepsOf(gh), suite: async (cwd, signal) => (++runs === 1 ? { exitCode: 1, tail: "FAIL: synthetic" } : prDepsOf(gh).suite(cwd, signal)) };
		const worker = makeWorker({ T1: commitFile("app.js"), "FIX-1": commitFile("fix1.js") }, { price: PRICE });
		const r = await open(worker, { prDeps });
		const id = await r.start(ws.docPath, { pr: true, cap: 2 });
		const stopped = await drivers(() => r, gh, clock, POLL_MS).atStop(id);
		assert.equal(stopped.reason, "cost cap reached: $2.00 of $2.00 spent");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "no FIX-1");
		assert.equal(gh.comments.length, 0, "no PR yet, so no comment");
		assert.ok(readDoc(ws).split("\n").some((line) => /PR loop needs you \(1\): cost cap reached: \$2\.00 of \$2\.00 spent$/.test(line)));
	});

	it("a PR that exists gets the PR comment, which says to resume with --cap", async () => {
		writeFileSync(ws.docPath, docText([T("T1", "auth.js")]));
		const worker = makeWorker({ T1: commitFile("auth.js"), VERIFY: [verdict()] }, { price: PRICE });
		const r = await open(worker);
		// The ticket spends $2.00, a $2.25 cap lets verify start ($2.00 < $2.25); verify's one response ($0.50) takes it to $2.50, and CI failing then reaches the fix boundary.
		gh.checks = () => (gh.pushes().length >= 1 ? [FAIL] : [PENDING]);
		const id = await r.start(ws.docPath, { pr: true, cap: 2.25 });
		const d = drivers(() => r, gh, clock, POLL_MS);
		const stopped = await d.atStop(id);
		assert.equal(stopped.reason, "cost cap reached: $2.50 of $2.25 spent");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "VERIFY"], "verify ran ($2.00 < $2.25), the fix did not ($2.50 > $2.25)");
		assert.deepEqual(gh.comments.map((c) => c.body.split("\n")[0]), ["Needs you: cost cap reached: $2.50 of $2.25 spent"]);
		assert.match(gh.comments[0].body, new RegExp(`brigadev-runner resume ${escaped(ws.docPath)} --cap <dollars>`));
	});
});

describe("a conversation over the cap gets its tools blocked (b)", () => {
	it("once the loop's spend is at the cap, every further tool call is blocked with the cap reason, and the run ends", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: [bash("echo one"), bash("echo two"), bash("echo three")] }, { price: PRICE });
		const r = await open(worker);
		const id = await r.start(ws.docPath, { cap: 1, maxAttempts: 1 });
		await r.settle(id);
		const results = worker.results.filter((result) => result.ticketId === "T1");
		assert.equal(results.length, 3, "the script ran to its end: the model was not stopped, its tools were");
		// Response 1 ($0.50) is under the $1.00 cap: its call runs. Response 2 reaches it: this call and every one after is blocked.
		assert.equal(results[0].isError, false);
		assert.match(results[0].text, /one/);
		for (const blocked of results.slice(1)) {
			assert.equal(blocked.isError, true);
			// The Harness wraps a block's reason (`Tool call blocked: <reason>`).
			assert.match(blocked.text, /Tool call blocked: Blocked: the loop's cost cap \(\$1\.00\) is reached; finish now\./);
		}
	});

	it("counts the loop's earlier spend: T2 starts with $2.00 spent of $3.00 and is blocked from its third response on", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") }, { price: PRICE });
		const r = await open(worker);
		const id = await r.start(ws.docPath, { cap: 3, maxAttempts: 1 });
		await r.settle(id);
		const results = worker.results.filter((result) => result.ticketId === "T2");
		// Spend before each call: 2.50 (write), 3.00 (check: blocked), 3.50 (commit: blocked).
		assert.deepEqual(results.map((result) => result.isError), [false, true, true]);
		assert.match(results[1].text, /cost cap \(\$3\.00\) is reached/);
		assert.deepEqual(statuses(), { T1: "done", T2: "blocked" }, "the blocked run did not commit");
	});

	it("fails safe: when the spend cannot be read the call is not blocked on that ground, and the failure is logged", async () => {
		const warnings: string[] = [];
		const api = { conversationId: "c1", snapshot: async () => Promise.reject(new Error("storage hiccup")) };
		const reason = await costBlock({ name: "bash", arguments: {} } as never, api as never, context, (message) => warnings.push(message));
		assert.equal(reason, undefined);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /storage hiccup/);
		// With a readable spend over the cap it blocks; the terminating verdict tool is the one call that is let through, so a verify run can still finish.
		const over = { conversationId: "c1", snapshot: async (token: unknown) => (token === UsageDoc ? { models: { "x/y": { cost: { total: 3 } } }, tools: {} } : { base: 2, cap: 5 }) };
		assert.match((await costBlock({ name: "bash", arguments: {} } as never, over as never, context, () => {}))!, /^Blocked: the loop's cost cap \(\$5\.00\) is reached; finish now\.$/);
		assert.equal(await costBlock({ name: "verify_verdict", arguments: {} } as never, over as never, context, () => {}), undefined);
	});
});

describe("resume --cap (c)", () => {
	async function parked() {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = worker3();
		const r = await open(worker);
		const id = await r.start(ws.docPath, { cap: 4 });
		await r.settle(id);
		return { worker, r, id };
	}

	it("a plain resume on a cost-cap park is refused with the hint to pass --cap, and nothing is delivered", async () => {
		const { r, id } = await parked();
		const before = await r.status(id);
		const refused = await resumeLoop(r, ws.docPath);
		assert.equal(refused.code, 2);
		assert.equal(refused.result, undefined);
		assert.match(refused.text, /cost cap reached: \$4\.00 of \$4\.00 spent/);
		assert.match(refused.text, new RegExp(`brigadev-runner resume ${escaped(ws.docPath)} --cap <dollars>`));
		const after = await r.status(id);
		assert.deepEqual([after.state, after.resumeKey], [before.state, before.resumeKey], "still parked on the same key");
	});

	it("a plain resume works once the stored cap is already above the spend (raised by `start --cap`): it would not stop again at once", async () => {
		const { worker, r, id } = await parked();
		assert.equal(await r.start(ws.docPath, { cap: 8 }), id);
		assert.equal((await r.status(id)).cost?.cap, 8);
		const resumed = await resumeLoop(r, ws.docPath);
		assert.deepEqual([resumed.code, resumed.result], [0, "delivered"], resumed.text);
		assert.equal((await r.settle(id)).status, "completed");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T3"]);
	});

	it("a cap at or below the spend is refused (exit 2) and delivers nothing; a cap above it continues and the loop finishes", async () => {
		const { worker, r, id } = await parked();
		for (const low of [4, 3.99, 0.5]) {
			const refused = await resumeLoop(r, ws.docPath, undefined, { cap: low });
			assert.equal(refused.code, 2, `--cap ${low}`);
			assert.equal(refused.result, undefined);
			assert.match(refused.text, /must be above the spend \$4\.00; nothing was delivered/);
		}
		assert.equal((await r.status(id)).state, "paused");
		assert.equal((await r.status(id)).cost?.cap, 4, "the stored cap did not change");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"]);

		const resumed = await resumeLoop(r, ws.docPath, undefined, { cap: 6 });
		assert.deepEqual([resumed.code, resumed.result], [0, "delivered"], resumed.text);
		assert.match(resumed.text, /cost cap \$6\.00/);
		assert.equal((await r.settle(id)).status, "completed");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T3"]);
		assert.deepEqual(statuses(), { T1: "done", T2: "done", T3: "done" });
		const done = await r.status(id);
		assert.deepEqual([done.state, done.cost], ["done", { spent: 6, cap: 6 }]);
		assert.equal((await resumeLoop(r, ws.docPath, undefined, { cap: 9 })).code, 1, "an ended loop is a final closed");
	});

	it("--cap belongs to a cost-cap park: on a user pause it is refused (exit 2), and a plain resume still works", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") }, { price: PRICE });
		let asked = false;
		const deps: TicketDeps = {
			head: defaultDeps.head,
			run: async (command, cwd, signal, shell) => {
				if (!asked) {
					asked = true;
					assert.equal((await pauseLoop(runner!, ws.docPath)).code, 0);
				}
				return defaultDeps.run(command, cwd, signal, shell);
			},
		};
		runner = await openFixtureRunner(ws, worker, { clock, deps });
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", paused: "paused by user", decisions: [] });
		const refused = await resumeLoop(runner, ws.docPath, undefined, { cap: 9 });
		assert.equal(refused.code, 2);
		assert.match(refused.text, /not a cost-cap park/);
		assert.deepEqual((await resumeLoop(runner, ws.docPath)).result, "delivered");
		assert.equal((await runner.settle(id)).status, "completed");
	});

	it("the PR loop's cost stop continues with `resume --cap`: the verify it stopped before then runs, in the same cap", async () => {
		gh.checks = () => [PENDING];
		writeFileSync(ws.docPath, docText([T("T1", "auth.js")]));
		const worker = makeWorker({ T1: commitFile("auth.js"), VERIFY: [verdict()] }, { price: PRICE });
		const r = await open(worker);
		const id = await r.start(ws.docPath, { pr: true, cap: 2 });
		const d = drivers(() => r, gh, clock, POLL_MS);
		await d.atStop(id);
		const plain = await resumeLoop(r, ws.docPath);
		assert.equal(plain.code, 2);
		assert.match(plain.text, /--cap <dollars>/);
		assert.equal((await resumeLoop(r, ws.docPath, undefined, { cap: 2 })).code, 2);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"]);

		const resumed = await resumeLoop(r, ws.docPath, undefined, { cap: 10 });
		assert.deepEqual([resumed.code, resumed.result], [0, "delivered"], resumed.text);
		await d.asleepAt(id, "wait-ci");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "VERIFY"]);
		assert.deepEqual((await r.status(id)).cost, { spent: 2.5, cap: 10 }, "the ticket's $2.00 and verify's one response");
	});

	it("the PR loop's cost stop before a fix continues with `resume --cap`: FIX-1 then runs", async () => {
		writeFileSync(ws.docPath, docText([T("T1", "app.js")]));
		let runs = 0;
		// The final check fails twice: before the stop, and again after the resume, which is when FIX-1 runs.
		const prDeps: PrDeps = { ...prDepsOf(gh), suite: async (cwd, signal) => (++runs <= 2 ? { exitCode: 1, tail: "FAIL: synthetic" } : prDepsOf(gh).suite(cwd, signal)) };
		const worker = makeWorker({ T1: commitFile("app.js"), "FIX-1": commitFile("fix1.js") }, { price: PRICE });
		const r = await open(worker, { prDeps });
		const id = await r.start(ws.docPath, { pr: true, cap: 2 });
		const d = drivers(() => r, gh, clock, POLL_MS);
		await d.atStop(id);
		assert.deepEqual((await resumeLoop(r, ws.docPath, undefined, { cap: 10 })).result, "delivered");
		await d.atMerge(id);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1"]);
		assert.deepEqual((await r.status(id)).cost, { spent: 4, cap: 10 });
	});

	it("the CLI: `resume <doc>` is refused with the hint (exit 2), `--cap N` at or below the spend is exit 2, above it exit 0, and `start` then finishes the loop", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = worker3();
		const first = await open(worker, { storage: await sqlite() });
		const id = await first.start(ws.docPath, { cap: 4 });
		await first.settle(id);
		await first.close();
		runner = undefined;

		const plain = await cli(["resume", ws.docPath]);
		assert.equal(plain.code, 2);
		assert.match(plain.stderr, /--cap <dollars>/);
		for (const low of ["4", "3.5"]) {
			const refused = await cli(["resume", ws.docPath, "--cap", low]);
			assert.equal(refused.code, 2, low);
			assert.match(refused.stderr, /must be above the spend \$4\.00/);
		}
		const status = await cli(["status", ws.docPath]);
		assert.match(status.stdout, /spend \$4\.00 of \$4\.00/);
		assert.match(status.stdout, new RegExp(`resume: brigadev-runner resume ${escaped(ws.docPath)} --cap <dollars>`));
		assert.match(status.stdout, /loop: paused: cost cap reached: \$4\.00 of \$4\.00 spent/);

		const ok = await cli(["resume", ws.docPath, "--cap", "6"]);
		assert.equal(ok.code, 0, ok.stderr);
		assert.match(ok.stdout, /delivered: resume requested/);
		const second = await open(worker, { storage: await sqlite() });
		let out = "";
		assert.equal(await startLoop(second, ws.docPath, { out: (text) => (out += `${text}\n`), err: () => {} }), 0);
		assert.match(out, /"status": "done"/);
		assert.deepEqual(statuses(), { T1: "done", T2: "done", T3: "done" });
	});
});

describe("the cap is durable (d)", () => {
	it("is $5 unless set, and the spend of a finished loop is still shown", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const r = await open(worker3());
		const id = await r.start(ws.docPath);
		assert.equal(DEFAULT_CAP, 5);
		assert.equal((await r.status(id)).cost?.cap, 5, "the default");
		assert.equal((await r.settle(id)).status, "completed");
		assert.deepEqual((await r.status(id)).cost, { spent: 2, cap: 5 });
	});

	it("survives a close and reopen; a start without --cap keeps it, and a start with --cap changes it (and says so)", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = worker3();
		const first = await open(worker, { storage: await sqlite() });
		const id = await first.start(ws.docPath, { cap: 4 });
		await first.settle(id);
		await first.close();
		runner = undefined;

		const second = await open(worker, { storage: await sqlite() });
		assert.equal((await second.status(id)).cost?.cap, 4, "stored with the loop: a reopen keeps it");
		assert.equal(await second.start(ws.docPath), id, "the same loop");
		assert.equal((await second.status(id)).cost?.cap, 4, "a start without --cap keeps the stored one");
		let out = "";
		await startLoop(second, ws.docPath, { out: (text) => (out += `${text}\n`), err: () => {} }, { cap: 9 });
		assert.equal((await second.status(id)).cost?.cap, 9);
		assert.match(out, /cost cap changed: \$4\.00 → \$9\.00 \(spent \$4\.00\)/);
		// A start does not lift a park: only `resume` does.
		assert.equal((await second.status(id)).state, "paused");
		await second.close();
		runner = undefined;

		const third = await open(worker, { storage: await sqlite() });
		assert.equal((await third.status(id)).cost?.cap, 9, "the changed cap is durable too");
	});

	it("a loop that is parked at the cap and reopened is still parked on the same key, and `resume --cap` still works after the reopen", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = worker3();
		const first = await open(worker, { storage: await sqlite() });
		const id = await first.start(ws.docPath, { cap: 4 });
		await first.settle(id);
		const key = (await first.status(id)).resumeKey;
		await first.close();
		runner = undefined;

		const second = await open(worker, { storage: await sqlite() });
		const status = await second.status(id);
		assert.deepEqual([status.state, status.kind, status.resumeKey, status.cost], ["paused", "cost", key, { spent: 4, cap: 4 }]);
		assert.deepEqual((await resumeLoop(second, ws.docPath, undefined, { cap: 7 })).result, "delivered");
		assert.equal((await second.wait(id)).status, "completed", "a reopened runner schedules once it waits");
	});

	it("rejects a cap that is not a positive number", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const r = await open(worker3());
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) await assert.rejects(r.start(ws.docPath, { cap: bad }), /positive/, String(bad));
		assert.equal(await r.find(ws.docPath), undefined, "nothing was started");
	});
});

describe("status and the board show spend and cap (e)", () => {
	it("`status` prints `spend $X of $Y`", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const r = await open(worker3());
		const id = await r.start(ws.docPath, { cap: 4 });
		await r.settle(id);
		const text = (await statusText(r, ws.docPath)).text;
		assert.match(text, /^loop: paused: cost cap reached: \$4\.00 of \$4\.00 spent\nspend \$4\.00 of \$4\.00\n/);
	});

	const BOARD = { debounceMs: 10, pollMs: 2_000 };
	const promptsOf = (log: ReturnType<typeof createWebLog>) => log.since(0).filter((event) => event.type === "brigadev_prompt").map((event) => event.data as PromptState);
	const dataOf = (log: ReturnType<typeof createWebLog>, type: string, key?: string) => log.since(0).filter((event) => event.type === type && (key === undefined || event.key === key)).at(-1)?.data as any;

	async function signIn(server: WebServer): Promise<(body: unknown) => Promise<{ status: number; body: any }>> {
		const code = new URL(server.openUrl()).searchParams.get("code")!;
		const session = await fetch(`${server.url}session`, { method: "POST", headers: { "x-brigadev-code": code } });
		const { secret } = (await session.json()) as { secret: string };
		return async (body) => {
			const res = await fetch(`${server.url}action`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
			const text = await res.text();
			return { status: res.status, body: text ? JSON.parse(text) : undefined };
		};
	}

	it("the phase detail and the ticket cards carry the spend and the cap, and the parked loop offers `+$5`, `+$10` and other as a choice", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const r = await open(worker3());
		const log = createWebLog();
		const board = await createBoard({ runner: r, docPath: ws.docPath, log, ...BOARD });
		try {
			const id = await r.start(ws.docPath, { cap: 4 });
			await r.settle(id);
			await board.refresh();
			assert.match(dataOf(log, "brigadev_phase", "loop").detail, /spend \$4\.00 of \$4\.00/);
			assert.equal(dataOf(log, "brigadev_agent", "ticket:T1").cost, 2, "T1's own spend: four responses");
			const prompt = promptsOf(log).find((p) => p.status === "open")!;
			assert.deepEqual([prompt.kind, prompt.source, prompt.allowOther], ["choice", "runner", true]);
			assert.match(prompt.title, /cost cap/i);
			assert.match(prompt.body ?? "", /cost cap reached: \$4\.00 of \$4\.00 spent/);
			assert.deepEqual(prompt.options!.map((option) => option.label.split(" ")[0]), ["+$5", "+$10"]);
		} finally {
			await board.stop();
		}
	});

	it("answering with +$5 resumes with a cap $5 above the spend and the loop finishes; a cap at or below the spend, and text that is no amount, are refused (409) and leave the prompt open", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = worker3();
		const r = await open(worker);
		served = await serveBoard(r, ws.docPath, { port: 0, ...BOARD });
		const act = await signIn(served.server);
		const id = await r.start(ws.docPath, { cap: 4 });
		const prompt = await until(() => promptsOf(served!.log).find((p) => p.status === "open" && p.source === "runner"), "the cap prompt");

		const low = await act({ action: "answer", id: prompt.id, value: "3" });
		assert.equal(low.status, 409);
		assert.match(low.body.error, /must be above the spend \$4\.00/);
		const text = await act({ action: "answer", id: prompt.id, value: "plenty" });
		assert.equal(text.status, 409);
		assert.match(text.body.error, /amount in dollars/);
		const yes = await act({ action: "answer", id: prompt.id, value: true });
		assert.equal(yes.status, 409, "this is a choice, not a yes/no");
		assert.equal((await r.status(id)).state, "paused", "nothing was delivered");

		const reply = await act({ action: "answer", id: prompt.id, value: prompt.options![0].label });
		assert.equal(reply.status, 202);
		assert.equal((await r.wait(id)).status, "completed");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T3"]);
		assert.equal((await r.status(id)).cost?.cap, 9, "+$5 over the $4.00 spent");
	});
});

describe("--cap parsing (f)", () => {
	let dir: string;
	beforeEach(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-runner-cap-")));
		dirs.push(dir);
		writeFileSync(join(dir, "feature.md"), docText([T1]));
	});
	const doc = () => join(dir, "feature.md");

	it("`start --cap` with 0, a negative number, text, or no value is a usage error (exit 2) before anything is read or started", async () => {
		for (const args of [["--cap", "0"], ["--cap", "-1"], ["--cap", "abc"], ["--cap"], ["--cap="], ["--cap", "1e3"], ["--cap", "NaN"], ["--cap", "Infinity"]]) {
			const result = await cli(["start", doc(), ...args], dir);
			assert.equal(result.code, 2, args.join(" "));
			assert.match(result.stderr, /usage: brigadev-runner start/);
			assert.match(result.stderr, /--cap <dollars>/);
		}
	});

	it("`resume --cap` has the same rules, and --cap belongs to start and resume only", async () => {
		for (const args of [["--cap", "0"], ["--cap", "-1"], ["--cap", "abc"], ["--cap"]]) assert.equal((await cli(["resume", doc(), ...args], dir)).code, 2, args.join(" "));
		for (const command of ["status", "pause", "merge"]) assert.equal((await cli([command, doc(), "--cap", "5"], dir)).code, 2, command);
		assert.equal((await cli(["answer", doc(), "T1", "1", "--cap", "5"], dir)).code, 2);
	});

	it("a valid amount is accepted: the command goes on to its own checks (here: not a git repository), also as --cap=N", async () => {
		for (const args of [["--cap", "7.5"], ["--cap=7.5"], ["--cap", ".5"], ["--cap", "10"]]) {
			const result = await cli(["start", doc(), ...args], dir);
			assert.equal(result.code, 1, args.join(" "));
			assert.match(result.stderr, /not a git repository/);
		}
	});
});

