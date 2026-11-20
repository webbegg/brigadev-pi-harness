// T5 (S4, S9): a ticket that needs a decision parks as a durable signal, and the answer reruns it; an approved command is allowed once.
// Covers A1 (decision tool), A2 (parking in the loop), A3 (command approval), A6 (a), (b), (c), (f), on JSONL and SQLite for the reopen case.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { answerDecision } from "../src/control.ts";
import { ANSWER } from "../src/signals.ts";
import { askUser, bash, commitFile, context, docText, fakeClock, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, type FixtureRunner, type Workspace } from "./fixture.ts";

let restoreEnv: () => void;
before(() => {
	restoreEnv = isolateEnv().restore;
});
after(() => restoreEnv());

const T1 = "- T1 [S1] inline: storage deps: none done: `test -f t1.txt` — pending";
const T2 = "- T2 [S2] inline: after storage deps: T1 done: `test -f t2.txt` — pending";
const T3 = "- T3 [S2] inline: independent deps: none done: `test -f t3.txt` — pending";
const QUESTION = "Which storage?";
const OPTIONS = [{ label: "SQLite", description: "one file" }, { label: "JSONL", description: "append only" }];
const HOUR = 60 * 60 * 1000;

const backends: Array<[string, (dir: string) => Promise<Storage>]> = [
	["JSONL", (dir) => openNodeJsonlStorage(join(dir, "jsonl"), context)],
	["SQLite", (dir) => openNodeSqliteStorage(join(dir, "runner.sqlite"))],
];

let ws: Workspace;
let runner: FixtureRunner | undefined;
let extra: FixtureRunner[] = [];
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(async () => {
	const all = [runner, ...extra].filter((r): r is FixtureRunner => r !== undefined);
	for (const r of all) await r.close();
	runner = undefined;
	extra = [];
	ws.cleanup();
	assert.deepEqual(all.flatMap((r) => r.reports).map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const statuses = () => Object.fromEntries(parseTicketList(readDoc(ws)).tickets.map((t) => [t.id, t.status]));
const logLines = () => readDoc(ws).split("## Log\n")[1].trim().split("\n");

describe("decision parking (S4, S9)", () => {
	for (const [name, open] of backends) {
		it(`${name}: a decision parks T1, T3 runs meanwhile, T2 waits; after close and reopen the answer reruns T1 with it in the brief, then T2`, async () => {
			const store = mkdtempSync(join(tmpdir(), "brigadev-runner-store-"));
			try {
				writeFileSync(ws.docPath, docText([T1, T2, T3]));
				const worker = makeWorker({
					T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS, { recommended: 1 })] : commitFile("t1.txt")),
					T2: commitFile("t2.txt"),
					T3: commitFile("t3.txt"),
				});
				const first = await openFixtureRunner(ws, worker, { storage: await open(store) });
				extra.push(first);
				const id = await first.start(ws.docPath);
				const parked = await first.settle(id);
				assert.deepEqual(parked, { status: "waiting", decisions: ["T1"] });
				assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T3"], "T3 ran while T1 waits; T2 (deps T1) did not");
				assert.deepEqual(statuses(), { T1: "blocked", T2: "pending", T3: "done" });
				assert.match(
					ticketLine(readDoc(ws), "T1"),
					new RegExp(`— blocked needs you: decision: Which storage\\? \\(answer: brigadev-runner answer ${ws.docPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} T1 <1\\.\\.n\\|text>\\)$`),
				);
				assert.equal(logLines().filter((l) => /T1 blocked: needs you: decision/.test(l)).length, 1, "one Log line");
				await first.close();

				// Reopened without scheduling: delivering the answer runs nothing.
				const second = await openFixtureRunner(ws, worker, { storage: await open(store) });
				extra.push(second);
				const calls = worker.faux.state.callCount;
				const delivered = await answerDecision(second, ws.docPath, "T1", "2");
				assert.deepEqual([delivered.code, delivered.result], [0, "delivered"], delivered.text);
				const again = await answerDecision(second, ws.docPath, "T1", "1");
				assert.deepEqual([again.code, again.result], [1, "duplicate"], "a second answer is a final duplicate");
				assert.equal((await second.harness.inspect(context)).scheduling, "paused", "delivering does not schedule");
				assert.equal(worker.faux.state.callCount, calls, "no worker ran");
				assert.deepEqual(statuses(), { T1: "blocked", T2: "pending", T3: "done" });

				assert.equal(await second.start(ws.docPath), id, "the same loop task");
				const outcome = await second.settle(id);
				assert.deepEqual(outcome, { status: "completed", result: { status: "done", tickets: [{ id: "T1", status: "done" }, { id: "T2", status: "done" }, { id: "T3", status: "done" }] } });
				assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T3", "T1", "T2"]);
				const rerun = worker.prompts[2];
				assert.match(rerun.system, /Which storage\?/);
				assert.match(rerun.system, /1\. SQLite/);
				assert.match(rerun.system, /2\. JSONL/);
				assert.match(rerun.system, /answer: JSONL/i, "the user's choice");
				assert.match(rerun.system, /attempt: 1 of 3/, "fresh attempt count");
				assert.ok(!worker.prompts[0].system.includes("Which storage?"), "the first run has no decision section");
			} finally {
				rmSync(store, { recursive: true, force: true });
			}
		});
	}

	it("free text answers the decision too, and the loop never ends `stalled` while a decision is open", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({
			T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS)] : commitFile("t1.txt")),
			T2: commitFile("t2.txt"),
		});
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1"] });
		assert.deepEqual((await answerDecision(runner, ws.docPath, "T1", "use postgres instead")).result, "delivered");
		const outcome = await runner.settle(id);
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.match(worker.prompts[1].system, /answer: use postgres instead/i);
	});

	it("a user who hand-edits the parked line back to pending gets it picked as usual, and its decision is dropped", async () => {
		writeFileSync(ws.docPath, docText([T1, T3]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS)] : commitFile("t1.txt")), T3: commitFile("t3.txt") });
		// "Meanwhile": the edit lands while an independent ticket runs, so the next pick sees it (a sleeping loop is not woken by a doc edit).
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId === "T3") writeFileSync(ws.docPath, readDoc(ws).replace(/^(- T1 .*) — blocked .*$/m, "$1 — pending"));
		};
		runner = await openFixtureRunner(ws, worker);
		const outcome = await runner.settle(await runner.start(ws.docPath));
		assert.equal((outcome as { result?: { status: string } }).result?.status, "done");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T3", "T1"]);
		assert.ok(!worker.prompts[2].system.includes("Which storage?"), "no answer was given: the rerun is a plain one");
		assert.deepEqual(statuses(), { T1: "done", T3: "done" });
	});

	it("an unanswered decision expires after 24 h: the line says `no answer within 24 h`, and a late answer is `closed`", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const clock = fakeClock();
		const worker = makeWorker({ T1: [askUser(QUESTION, OPTIONS)], T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		runner = await openFixtureRunner(ws, worker, { clock });
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1"] });
		const first = await runner.status(id);
		assert.equal(first.decisions[0].until, clock.now() + 24 * HOUR, "the deadline is 24 h after the question");

		clock.advance(24 * HOUR - 1000);
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1"] }, "not yet");
		clock.advance(2000);
		const outcome = await runner.settle(id);
		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T1", "T2"] } });
		assert.match(ticketLine(readDoc(ws), "T1"), /— blocked needs you: no answer within 24 h$/);
		assert.equal(logLines().filter((l) => /T1 blocked: needs you: no answer within 24 h/.test(l)).length, 1);
		const late = await answerDecision(runner, ws.docPath, "T1", "1");
		assert.deepEqual([late.code, late.result], [1, "closed"], late.text);
		assert.equal(worker.prompts.filter((p) => p.ticketId === "T1").length, 1, "T1 never reran");
	});

	it("keys are per ticket and round, never reused: a second question of the same ticket is `decision-T1-2`", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: (run) => (run < 3 ? [askUser(`Question ${run}?`, OPTIONS)] : commitFile("t1.txt")) });
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1"] });
		assert.equal((await runner.status(id)).decisions[0].key, "decision-T1-1");
		await answerDecision(runner, ws.docPath, "T1", "1");
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1"] });
		const second = await runner.status(id);
		assert.equal(second.decisions[0].key, "decision-T1-2");
		assert.equal(second.decisions[0].question, "Question 2?");
		// The first question's key is spent: a repeat of that answer is a duplicate, not an answer to the second question.
		assert.equal((await runner.deliver(id, ANSWER, "decision-T1-1", { choice: "x" })), "duplicate");
		await answerDecision(runner, ws.docPath, "T1", "2");
		assert.equal((await runner.settle(id)).status, "completed");
		assert.match(worker.prompts[2].system, /question: Question 2\?/);
		assert.match(worker.prompts[2].system, /answer: JSONL/);
	});

	it("a question keeps its own deadline when an earlier one expires: the sibling's key is renewed, and it can still be answered", async () => {
		writeFileSync(ws.docPath, docText([T1, T3]));
		const clock = fakeClock();
		const start = clock.now();
		const worker = makeWorker({ T1: [askUser("First?", OPTIONS)], T3: (run) => (run === 1 ? [askUser("Second?", OPTIONS)] : commitFile("t3.txt")) });
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId === "T3") clock.advance(HOUR); // T3 asks an hour after T1
		};
		runner = await openFixtureRunner(ws, worker, { clock });
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1", "T3"] });
		const before = await runner.status(id);
		assert.deepEqual(before.decisions.map((d) => d.until), [start + 24 * HOUR, start + 25 * HOUR]);

		clock.advance(23 * HOUR + 1000); // T1's deadline passes, T3's does not
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T3"] });
		assert.match(ticketLine(readDoc(ws), "T1"), /— blocked needs you: no answer within 24 h$/);
		const after = await runner.status(id);
		assert.equal(after.decisions[0].key, "decision-T3-2", "the key the shared sleep expired was renewed");
		assert.equal(after.decisions[0].until, start + 25 * HOUR, "with the same deadline");

		assert.deepEqual((await answerDecision(runner, ws.docPath, "T3", "1")).result, "delivered");
		assert.equal((await runner.settle(id)).status, "completed");
		assert.deepEqual(statuses(), { T1: "blocked", T3: "done" });
	});

	it("a signal delivered after the deadline to a loop that has not woken yet is `closed`, and the key is dead", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const clock = fakeClock();
		const worker = makeWorker({ T1: [askUser(QUESTION, OPTIONS)] });
		const store = mkdtempSync(join(tmpdir(), "brigadev-runner-store-"));
		try {
			const first = await openFixtureRunner(ws, worker, { clock, storage: await openNodeSqliteStorage(join(store, "runner.sqlite")) });
			extra.push(first);
			const id = await first.start(ws.docPath);
			await first.settle(id);
			await first.close();

			clock.advance(24 * HOUR + 1000);
			const second = await openFixtureRunner(ws, worker, { clock, storage: await openNodeSqliteStorage(join(store, "runner.sqlite")) });
			extra.push(second);
			const late = await answerDecision(second, ws.docPath, "T1", "1");
			assert.deepEqual([late.code, late.result], [1, "closed"], late.text);
			assert.equal((await second.harness.inspect(context)).scheduling, "paused");

			await second.start(ws.docPath);
			await second.settle(id);
			assert.match(ticketLine(readDoc(ws), "T1"), /— blocked needs you: no answer within 24 h$/);
			assert.equal(worker.prompts.length, 1, "the late answer did not rerun T1");
		} finally {
			rmSync(store, { recursive: true, force: true });
		}
	});

	it("a worker that asks about something the guard denied, with `command`, gets that command once in the rerun (A3)", async () => {
		writeFileSync(ws.docPath, docText([T1, T3]));
		const rm = "rm -rf build";
		const worker = makeWorker({
			T1: (run) =>
				run === 1
					? [bash(rm), askUser(`Run \`${rm}\`?`, [{ label: `Approve ${rm}` }, { label: "Find another way" }], { command: rm, recommended: 1 })]
					: [bash(rm), bash(rm), bash("rm -rf other"), bash("git push origin HEAD"), ...commitFile("t1.txt")],
			T3: [bash(rm), ...commitFile("t3.txt")],
		});
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1"] });

		// The denial tells the worker how to get an approval.
		const [denied] = worker.results.filter((r) => r.ticketId === "T1");
		assert.match(denied.text, /needs you: /);
		assert.match(denied.text, /ask_user_choice/);
		assert.match(denied.text, /`command`/);
		assert.match(denied.text, /Approve/);
		const t3Denied = worker.results.filter((r) => r.ticketId === "T3")[0];
		assert.match(t3Denied.text, /needs you: /, "another ticket gets no approval before or after");

		assert.deepEqual((await answerDecision(runner, ws.docPath, "T1", "1")).result, "delivered");
		const outcome = await runner.settle(id);
		assert.equal((outcome as { result: { status: string } }).result.status, "done");

		const rerun = worker.results.filter((r) => r.ticketId === "T1").slice(1); // after the first run's denial
		assert.equal(rerun[0].isError, false, "the approved command runs once");
		assert.match(rerun[1].text, /needs you: /, "the same command again is denied");
		assert.match(rerun[2].text, /needs you: /, "a different command is denied");
		assert.match(rerun[3].text, /the runner owns PR delivery/, "delivery stays blocked");
		assert.deepEqual(statuses(), { T1: "done", T3: "done" });
		assert.match(worker.prompts.find((p) => p.ticketId === "T1" && p.run === 2)!.system, /approved .*rm -rf build/i);
	});

	it("a command is approved only by an answer that says so: another option, or text, lifts nothing", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const rm = "rm -rf build";
		const worker = makeWorker({
			T1: (run) => (run === 1 ? [askUser("Run it?", [{ label: `Approve ${rm}` }, { label: "No" }], { command: rm })] : [bash(rm), ...commitFile("t1.txt")]),
		});
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		await runner.settle(id);
		await answerDecision(runner, ws.docPath, "T1", "2");
		await runner.settle(id);
		const rerun = worker.results.filter((r) => r.ticketId === "T1"); // the first run asked at once: no result of its own
		assert.match(rerun[0].text, /needs you: /);
	});

	it("`--approve` approves the command whatever the option labels say", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const rm = "rm -rf build";
		const worker = makeWorker({
			T1: (run) => (run === 1 ? [askUser("Run it?", [{ label: "Yes, go" }, { label: "No" }], { command: rm })] : [bash(rm), ...commitFile("t1.txt")]),
		});
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		await runner.settle(id);
		await answerDecision(runner, ws.docPath, "T1", "1", { approve: true });
		await runner.settle(id);
		const rerun = worker.results.filter((r) => r.ticketId === "T1");
		assert.equal(rerun[0].isError, false);
	});
});

describe("decision does not consume an attempt (A6 f)", () => {
	it("with one attempt allowed, a decision is not a failure: the rerun gets attempt 1 of 1 and the loop does not pause", async () => {
		writeFileSync(ws.docPath, docText([T1, "- T2 [S2] inline: other deps: none done: `test -f t2.txt` — pending", T3]));
		const worker = makeWorker({
			T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS)] : commitFile("t1.txt")),
			T2: (run) => (run === 1 ? [askUser("Second question?", OPTIONS)] : commitFile("t2.txt")),
			T3: commitFile("t3.txt"),
		});
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath, { maxAttempts: 1 });
		assert.deepEqual(await runner.settle(id), { status: "waiting", decisions: ["T1", "T2"] }, "two parked decisions are not two failures: T3 still ran");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T3"]);
		assert.deepEqual(statuses(), { T1: "blocked", T2: "blocked", T3: "done" });

		// The child's result: a decision, with no attempt used.
		const result = await runner.harness.commit(async (tx) => (await tx.scanTasks({ kind: "brigadev.ticket" }, 10)).items[0].state.outcome, context);
		assert.deepEqual(result, {
			status: "completed",
			result: { decision: { question: QUESTION, options: OPTIONS, recommended: null, command: null }, attempts: 0 },
		});

		await answerDecision(runner, ws.docPath, "T1", "1");
		await answerDecision(runner, ws.docPath, "T2", "2");
		const outcome = await runner.settle(id);
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.match(worker.prompts.find((p) => p.ticketId === "T1" && p.run === 2)!.system, /attempt: 1 of 1/);
	});

	it("an invalid call (one option) is an error result the worker sees: nothing is parked", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: [askUser(QUESTION, ["only one"]), ...commitFile("t1.txt")] });
		runner = await openFixtureRunner(ws, worker);
		const outcome = await runner.settle(await runner.start(ws.docPath));
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.equal(worker.results[0].isError, true);
		assert.match(worker.results[0].text, /2.?6 options/);
	});
});
