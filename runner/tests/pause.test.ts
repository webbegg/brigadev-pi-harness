// T5 (A4, A6 d): pause and resume. The loop sleeps (no deadline) on a `resume-<n>` key instead of ending, for a user pause,
// the two-failures pause, and a doc-conflict pause; `resume` delivers the signal.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { pauseLoop, resumeLoop } from "../src/control.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";
import { commitFile, depsWithHook, docText, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, type FixtureRunner, type Workspace } from "./fixture.ts";

let restoreEnv: () => void;
before(() => {
	restoreEnv = isolateEnv().restore;
});
after(() => restoreEnv());

let ws: Workspace;
let runner: FixtureRunner | undefined;
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending";
const T2 = "- T2 [S2] inline: second deps: none done: `test -f t2.txt` — pending";
const FAILS = (id: string) => `- ${id} [S1] inline: fails deps: none done: \`cat never.txt\` — pending`;
const statuses = () => Object.fromEntries(parseTicketList(readDoc(ws)).tickets.map((t) => [t.id, t.status]));

describe("user pause (A4)", () => {
	it("is honored at the next pick: the running ticket finishes, the next one does not start; resume continues", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let asked = false;
		const deps: TicketDeps = {
			head: defaultDeps.head,
			// While T1's done check runs, the user asks to pause.
			run: async (command, cwd, signal) => {
				if (!asked) {
					asked = true;
					const result = await pauseLoop(runner!, ws.docPath);
					assert.deepEqual([result.code, result.result], [0, "delivered"], result.text);
				}
				return defaultDeps.run(command, cwd, signal);
			},
		};
		runner = await openFixtureRunner(ws, worker, { deps });
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", paused: "paused by user", decisions: [] });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "T1 finished; T2 did not start");
		assert.deepEqual(statuses(), { T1: "done", T2: "pending" });
		assert.equal((await runner.status(id)).state, "paused");

		const again = await pauseLoop(runner, ws.docPath);
		assert.equal(again.code, 1, "already paused");
		const resumed = await resumeLoop(runner, ws.docPath);
		assert.deepEqual([resumed.code, resumed.result], [0, "delivered"], resumed.text);
		const duplicate = await resumeLoop(runner, ws.docPath);
		assert.equal(duplicate.code, 1);
		assert.equal((await runner.settle(id)).status, "completed");
		assert.deepEqual(statuses(), { T1: "done", T2: "done" });
	});

	it("resume on a loop that is not paused is refused (a stale resume would unpause a later pause)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: commitFile("t1.txt") });
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		const result = await resumeLoop(runner, ws.docPath);
		assert.equal(result.code, 1);
		assert.match(result.text, /not paused/);
		await runner.settle(id);
	});
});

describe("failure pause (A4)", () => {
	it("two consecutive failures pause the loop without ending it; resume resets the count", async () => {
		writeFileSync(ws.docPath, docText([FAILS("T1"), FAILS("T2"), FAILS("T3"), "- T4 [S2] inline: fine deps: none done: `test -f t4.txt` — pending"]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt"), T4: commitFile("t4.txt") });
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath, { maxAttempts: 1 });
		assert.deepEqual(await runner.settle(id), { status: "waiting", paused: "two consecutive tickets failed: T1, T2", decisions: [] });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"]);
		assert.deepEqual(statuses(), { T1: "blocked", T2: "blocked", T3: "pending", T4: "pending" });

		assert.deepEqual((await resumeLoop(runner, ws.docPath)).result, "delivered");
		// T3 fails too, but the count restarted: that is one failure, not a second pause. T4 runs.
		const outcome = await runner.settle(id);
		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T1", "T2", "T3"] } });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T3", "T4"]);
		assert.deepEqual(statuses(), { T1: "blocked", T2: "blocked", T3: "blocked", T4: "done" });
	});
});

describe("doc conflict pause (A4, S8)", () => {
	it("pauses on an edit to the running ticket's line; resume re-reads the doc: still edited pauses again, restored continues", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let original = "";
		let edited = "";
		// While T1's done command runs: after the worker's conversation (a doc change during it is an integrity finding, B2).
		const deps = depsWithHook((command) => {
			if (command !== "test -f t1.txt" || edited) return;
			original = readDoc(ws);
			edited = original.replace("inline: first", "inline: first (user reworded)");
			writeFileSync(ws.docPath, edited);
		});
		runner = await openFixtureRunner(ws, worker, { deps });
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", paused: "doc edited: T1", decisions: [] });
		assert.equal(readDoc(ws), edited, "nothing was written over the user's edit");

		// Resume while the conflict is still there: the doc is re-read, and the loop pauses again.
		assert.deepEqual((await resumeLoop(runner, ws.docPath)).result, "delivered");
		assert.deepEqual(await runner.settle(id), { status: "waiting", paused: "doc edited: T1", decisions: [] });
		assert.equal(readDoc(ws), edited);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "no second run of T1");

		// The user restores the runner's line: resume records T1 and goes on.
		writeFileSync(ws.docPath, original);
		assert.deepEqual((await resumeLoop(runner, ws.docPath)).result, "delivered");
		const outcome = await runner.settle(id);
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.deepEqual(statuses(), { T1: "done", T2: "done" });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"]);
	});
});
