// R4-001: `runner.ticketRuns` is what the board reads on every refresh (every 5 s, and after each task-graph advance). It must cost what this loop has done, not what the
// store holds: another doc's loop is never read for its tickets, a finished ticket is read once (its card and its steps are cached), and the caches are bounded.
// pi-durable's task scan has no owner filter, so the scan runs newest first and stops at what it already knows (a mark below which every task of the loop is final).
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationQuery, Cursor, TaskQuery } from "@earendil-works/pi-durable";
import { answerDecision } from "../src/control.ts";
import { POLL_MS } from "../src/pr.ts";
import { RunsCache } from "../src/runs-cache.ts";
import { askUser, bash, commitFile, docText, fakeClock, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, type FixtureRunner, type Workspace } from "./fixture.ts";
import { addRemote, drivers, FakeGh, FAIL, PASS, prDepsOf, until } from "./pr-fixture.ts";

/** A store that remembers which task rows and which conversations were read. */
class SpyStorage extends MemoryStorage {
	taskRows: number[] = [];
	conversationOwners: number[] = [];
	override async scanTasks(query: TaskQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		const page = await super.scanTasks(query, limit, cursor, context);
		if (query.kind === "brigadev.ticket" || query.kind === "brigadev.pr-loop") this.taskRows.push(...page.items.map((item) => Number(item.id)));
		return page;
	}
	override async scanConversations(query: ConversationQuery, limit: number, cursor: Cursor | undefined, context: Context) {
		if (query.ownerTaskId !== undefined) this.conversationOwners.push(Number(query.ownerTaskId));
		return super.scanConversations(query, limit, cursor, context);
	}
	reset() {
		this.taskRows = [];
		this.conversationOwners = [];
	}
}

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

const OPTIONS = [{ label: "yes" }, { label: "no" }];
const parked = (ids: number[]) => ids.map((n) => `- T${n} [S1] inline: parks ${n} deps: none done: \`true\` — pending`);

describe("ticketRuns reads this loop, not the store (R4-001)", () => {
	it("another doc's loop is not read for its tickets, steady-state refreshes read next to nothing, and finished tickets are not read again", async () => {
		const storage = new SpyStorage();
		// Doc A: six tickets that each park on a decision (terminal ticket tasks, no git work), its loop asleep on them.
		const docA = join(ws.root, "a.md");
		writeFileSync(docA, docText(parked([1, 2, 3, 4, 5, 6])));
		const docB = ws.docPath;
		writeFileSync(docB, docText(["- T7 [S1] inline: seventh deps: none done: `test -f t7.txt` — pending", "- T8 [S2] inline: eighth deps: T7 done: `test -f t8.txt` — pending"]));
		const scripts: Record<string, any> = { T7: commitFile("t7.txt"), T8: commitFile("t8.txt") };
		for (const n of [1, 2, 3, 4, 5, 6]) scripts[`T${n}`] = [askUser(`Question ${n}?`, OPTIONS)];
		const worker = makeWorker(scripts);
		runner = await openFixtureRunner(ws, worker, { storage });

		const loopA = await runner.start(docA);
		await until(async () => ((await runner!.status(loopA)).decisions.length === 6 ? true : undefined), "six parked decisions in A");
		const aRuns = await runner.ticketRuns(loopA);
		assert.deepEqual(aRuns.map((run) => run.ticketId).sort(), ["T1", "T2", "T3", "T4", "T5", "T6"]);
		const aTasks = aRuns.map((run) => Number(run.taskId));

		const loopB = await runner.start(docB);
		assert.equal((await runner.wait(loopB)).status, "completed");

		storage.reset();
		const first = await runner.ticketRuns(loopB);
		assert.deepEqual(first.map((run) => run.ticketId).sort(), ["T7", "T8"], "only this loop's tickets");
		assert.ok(first.every((run) => run.end === "commit" && !run.live));
		assert.ok(!storage.conversationOwners.some((owner) => aTasks.includes(owner)), "A's tickets' conversations are never read");
		const bTasks = first.map((run) => Number(run.taskId));

		// Steady state: nothing changed. The scan stops at what it knows; it does not walk A's six tickets (a store of years would hold thousands).
		storage.reset();
		const again = await runner.ticketRuns(loopB);
		assert.deepEqual(again, first, "the same answer");
		assert.deepEqual(storage.conversationOwners, [], "a finished ticket is not read again (steps included)");
		// What is bounded is the walk into history (another loop's tasks), not the page size: it never reads all of A's tickets.
		assert.ok(storage.taskRows.filter((id) => aTasks.includes(id)).length < aTasks.length, `a steady-state refresh walked A's ${aTasks.length} tickets: ${storage.taskRows.join(",")}`);
		assert.ok(bTasks.length === 2);

		// The older loop, read with a newer one in the store: B's tickets are not A's.
		storage.reset();
		const aAgain = await runner.ticketRuns(loopA);
		assert.deepEqual(aAgain.map((run) => run.ticketId).sort(), ["T1", "T2", "T3", "T4", "T5", "T6"], "A shows A");
		storage.reset();
		await runner.ticketRuns(loopA);
		assert.deepEqual(storage.conversationOwners, []);
		assert.ok(storage.taskRows.length < aTasks.length + bTasks.length, `the older loop's steady-state refresh read the whole store (${storage.taskRows.length} rows)`);
	});
});

// The correctness rules behind the cache, end to end through `ticketRuns`: what a refresh may skip is only what is final. A regression here hides a ticket card or freezes it on
// "running", with no other test failing.
describe("ticketRuns follows the loop as it moves (the mark)", () => {
	/** A script that waits (bounded: 30 s) for a file to exist, so a ticket stays live until the test says so. */
	const gateScript = () => {
		const path = join(ws.root, "gate.sh");
		writeFileSync(path, 'n=0\nwhile [ ! -e "$1" ] && [ $n -lt 3000 ]; do n=$((n+1)); sleep 0.01; done\n');
		return path;
	};
	const ticketRun = (runs: Awaited<ReturnType<FixtureRunner["ticketRuns"]>>, id: string) => runs.find((run) => run.ticketId === id);

	it("a live ticket is read again on each refresh until it ends, then once more and cached; a ticket created after the mark appears; the loop's end changes nothing but the last card", async () => {
		const storage = new SpyStorage();
		const gate = gateScript();
		const [open1, open2] = [join(ws.root, "open1"), join(ws.root, "open2")];
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending", "- T2 [S2] inline: second deps: T1 done: `test -f t2.txt` — pending"]));
		const worker = makeWorker({ T1: [bash(`sh ${gate} ${open1}`), ...commitFile("t1.txt")], T2: [bash(`sh ${gate} ${open2}`), ...commitFile("t2.txt")] });
		runner = await openFixtureRunner(ws, worker, { storage });
		const loop = await runner.start(ws.docPath);

		// T1 is live: it is shown, and read (its steps) on every refresh.
		const first = await until(async () => ((runs) => (ticketRun(runs, "T1")?.live ? runs : undefined))(await runner!.ticketRuns(loop)), "T1 live");
		const t1 = Number(ticketRun(first, "T1")!.taskId);
		assert.equal(first.length, 1);
		for (let n = 0; n < 2; n += 1) {
			storage.reset();
			const again = await runner.ticketRuns(loop);
			assert.equal(ticketRun(again, "T1")?.live, true, "still live: not cached as if it had ended");
			assert.ok(storage.conversationOwners.includes(t1), "a live ticket's steps are read on each refresh");
		}

		// T1 ends; T2 (a task that did not exist at the last refresh, above its mark) starts and waits.
		writeFileSync(open1, "");
		const second = await until(async () => ((runs) => (ticketRun(runs, "T1")?.end === "commit" && ticketRun(runs, "T2")?.live ? runs : undefined))(await runner!.ticketRuns(loop)), "T1 done and T2 live");
		const t2 = Number(ticketRun(second, "T2")!.taskId);
		assert.ok(t2 > t1);
		assert.ok(ticketRun(second, "T1")!.commit, "T1 shows its commit");

		// T1 is final now: cached. T2 is live: read again.
		storage.reset();
		await runner.ticketRuns(loop);
		assert.ok(!storage.conversationOwners.includes(t1), "T1 is final: its conversation is not read again");
		assert.ok(storage.conversationOwners.includes(t2), "T2 is live: read");

		// T2 ends: its card turns done, and from then on nothing is read.
		writeFileSync(open2, "");
		assert.equal((await runner.wait(loop)).status, "completed");
		const last = await runner.ticketRuns(loop);
		assert.deepEqual(last.map((run) => [run.ticketId, run.live, run.end]).sort(), [["T1", false, "commit"], ["T2", false, "commit"]]);
		assert.ok(existsSync(open2));
		storage.reset();
		assert.deepEqual(await runner.ticketRuns(loop), last, "the same answer");
		assert.deepEqual(storage.conversationOwners, [], "all final: nothing is read");
	});

	it("a ticket that ran again after an answer replaces its earlier run: the new task, not the cached one", async () => {
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending"]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser("Which?", OPTIONS)] : commitFile("t1.txt")) });
		runner = await openFixtureRunner(ws, worker);
		const loop = await runner.start(ws.docPath);
		const parkedRuns = await until(async () => ((runs) => (ticketRun(runs, "T1")?.end === "decision" ? runs : undefined))(await runner!.ticketRuns(loop)), "T1 parked on its decision");
		const before = Number(ticketRun(parkedRuns, "T1")!.taskId);
		await runner.ticketRuns(loop); // the parked run is cached

		const answered = await answerDecision(runner, ws.docPath, "T1", "1");
		assert.equal(answered.code, 0, answered.text);
		assert.equal((await runner.wait(loop)).status, "completed");
		const runs = await runner.ticketRuns(loop);
		assert.equal(runs.length, 1, "one card per ticket");
		assert.equal(runs[0].end, "commit", "the rerun's outcome, not the parked one");
		assert.ok(Number(runs[0].taskId) > before, "the new task");
		assert.deepEqual(await runner.ticketRuns(loop), runs, "and it stays");
	});

	it("a PR loop's fix ticket (FIX-n, created after the PR loop and after the last refresh) is the loop's (through its PR loop) and appears", async () => {
		const storage = new SpyStorage();
		const gh = new FakeGh(addRemote(ws));
		const clock = fakeClock();
		gh.checks = () => (gh.pushes().length >= 2 ? [PASS] : [FAIL]);
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending"]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), "FIX-1": commitFile("fix1.js") });
		runner = await openFixtureRunner(ws, worker, { storage, clock, prDeps: prDepsOf(gh) });
		const loop = await runner.start(ws.docPath, { pr: true });
		const drive = drivers(() => runner!, gh, clock, POLL_MS);

		// The PR loop is asleep on CI, which has failed: T1 is final, the PR loop (and so the mark) is live.
		await drive.asleepAt(loop, "wait-ci");
		const before = await runner.ticketRuns(loop);
		assert.deepEqual(before.map((run) => run.ticketId), ["T1"]);

		// CI fails, FIX-1 runs (a task created after that refresh, owned by the PR loop, not by the loop), the new head passes.
		await drive.atMerge(loop);
		const after = await runner.ticketRuns(loop);
		assert.deepEqual(after.map((run) => [run.ticketId, run.live, run.end]).sort(), [["FIX-1", false, "commit"], ["T1", false, "commit"]]);
		assert.ok(Number(ticketRun(after, "FIX-1")!.taskId) > Number(ticketRun(after, "T1")!.taskId));
		storage.reset();
		assert.deepEqual(await runner.ticketRuns(loop), after, "and a refresh with nothing new reads no conversation");
		assert.deepEqual(storage.conversationOwners, []);
	});
});

describe("the runs cache is bounded (R4-001)", () => {
	const run = (n: number) => ({ ticketId: `T${n}`, taskId: n as never, live: false, end: "commit" as const, attempts: 1, maxAttempts: 3, steps: [] });

	it("keeps at most `maxLoops` loops (the least recently used goes first) and at most `maxRuns` finished runs per loop (past it, the loop starts over)", () => {
		const cache = new RunsCache({ maxLoops: 3, maxRuns: 4 });
		for (const id of [1, 2, 3]) cache.of(id as never);
		cache.of(1 as never); // 1 is now the most recently used
		cache.of(4 as never);
		assert.equal(cache.size, 3);
		assert.deepEqual(cache.loops(), [3, 1, 4], "2 (the least recently used) went");

		const loop = cache.of(1 as never);
		assert.equal(loop.mark, 1, "a new loop knows nothing above its own id");
		for (let n = 10; n < 14; n += 1) loop.final.set(n, run(n));
		loop.mark = 99;
		cache.settle(loop);
		assert.equal(loop.final.size, 4, "at the limit it is kept");
		loop.final.set(14, run(14));
		cache.settle(loop);
		assert.equal(loop.final.size, 0, "past it the loop starts over (correct, only slower)");
		assert.equal(loop.mark, 1);
	});
});
