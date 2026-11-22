// R4-001: `runner.ticketRuns` is what the board reads on every refresh (every 5 s, and after each task-graph advance). It must cost what this loop has done, not what the
// store holds: another doc's loop is never read for its tickets, a finished ticket is read once (its card and its steps are cached), and the caches are bounded.
// pi-durable's task scan has no owner filter, so the scan runs newest first and stops at what it already knows (a mark below which every task of the loop is final).
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { Context } from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { ConversationQuery, Cursor, TaskQuery } from "@earendil-works/pi-durable";
import { RunsCache } from "../src/runs-cache.ts";
import { askUser, commitFile, docText, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, type FixtureRunner, type Workspace } from "./fixture.ts";
import { until } from "./pr-fixture.ts";

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
		assert.ok(storage.taskRows.length <= 3, `a steady-state refresh read ${storage.taskRows.length} task rows: ${storage.taskRows.join(",")}`);
		assert.ok(storage.taskRows.filter((id) => aTasks.includes(id)).length <= 1, "at most the page boundary reaches into A");
		assert.ok(bTasks.length === 2);

		// The older loop, read with a newer one in the store: B's tickets are not A's.
		storage.reset();
		const aAgain = await runner.ticketRuns(loopA);
		assert.deepEqual(aAgain.map((run) => run.ticketId).sort(), ["T1", "T2", "T3", "T4", "T5", "T6"], "A shows A");
		storage.reset();
		await runner.ticketRuns(loopA);
		assert.deepEqual(storage.conversationOwners, []);
		assert.ok(storage.taskRows.length <= 3, `the older loop's steady-state refresh read ${storage.taskRows.length} task rows`);
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
