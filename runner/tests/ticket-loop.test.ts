import assert from "node:assert/strict";
import { readdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";
import { commitFile, context, docText, git, isolateGitEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, type FixtureRunner, type Workspace } from "./fixture.ts";

let restoreEnv: () => void;
before(() => {
	restoreEnv = isolateGitEnv();
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
const T2 = "- T2 [S1,S2] inline: second deps: T1 done: `test -f t2.txt` — pending";
const T3_FAILS = "- T3 [S2] inline: third deps: none done: `cat never.txt` — pending";

function statuses(ws: Workspace): Record<string, string | undefined> {
	return Object.fromEntries(parseTicketList(readDoc(ws)).tickets.map((t) => [t.id, t.status]));
}

async function run(worker: ReturnType<typeof makeWorker>, options: { maxAttempts?: number } = {}) {
	runner = await openFixtureRunner(ws, worker);
	const id = await runner.start(ws.docPath, options);
	return { id, outcome: await runner.wait(id) };
}

describe("ticket loop (S2)", () => {
	it("runs T1 then T2, blocks T3 after 3 attempts with the failure tail in the retry prompt, and writes the doc back", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3_FAILS]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		const { outcome } = await run(worker);

		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T3"] } });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T3", "T3", "T3"]);
		assert.deepEqual(statuses(ws), { T1: "done", T2: "done", T3: "blocked" });

		// Commits: initial, T1, T2, and one per T3 attempt (the worker committed, the done check still failed).
		assert.equal(git(ws.repo, "rev-list", "--count", "HEAD"), "6");

		const doc = readDoc(ws);
		const [t1, t2, t3] = parseTicketList(doc).tickets;
		assert.match(t1.note, /^[0-9a-f]{7} \(test -f t1\.txt passed\)$/);
		assert.match(t2.note, /^[0-9a-f]{7} \(test -f t2\.txt passed\)$/);
		assert.match(t3.note, /^needs you: done check failed/);
		const logs = doc.split("## Log\n")[1].trim().split("\n");
		assert.equal(logs.length, 4, doc);
		assert.match(logs[1], /^- L2 \(\d{4}-\d{2}-\d{2}\): T1 done [0-9a-f]{7}/);
		assert.match(logs[2], /^- L3 \(.*\): T2 done /);
		assert.match(logs[3], /^- L4 \(.*\): T3 blocked: needs you: done check failed/);

		// Attempt 1 has no failure section; attempts 2 and 3 carry the previous attempt's output tail.
		const t3Runs = worker.prompts.filter((p) => p.ticketId === "T3");
		assert.ok(!t3Runs[0].system.includes("Previous attempt failed"));
		for (const retry of t3Runs.slice(1)) {
			assert.match(retry.system, /Previous attempt failed/);
			assert.match(retry.system, /never\.txt/);
		}
		// The worker prompt, the ticket, and the done command reach the conversation.
		assert.match(worker.prompts[0].system, /bounded implementation writer/);
		assert.match(worker.prompts[0].system, /id: T1/);
		assert.match(worker.prompts[0].system, /done command: `test -f t1\.txt`/);
		assert.ok(worker.prompts[0].system.includes(ws.docPath));
		assert.ok(!readdirSync(dirname(ws.docPath)).some((f) => f.endsWith(".tmp")), "no temp file left by the atomic write");
	});

	it("skips tickets that depend on a blocked one and continues with independent tickets", async () => {
		writeFileSync(
			ws.docPath,
			docText([
				"- T1 [S1] inline: fails deps: none done: `cat never.txt` — pending",
				"- T2 [S1] inline: needs T1 deps: T1 done: `test -f t2.txt` — pending",
				"- T3 [S2] inline: independent deps: none done: `test -f t3.txt` — pending",
			]),
		);
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		const { outcome } = await run(worker);
		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T1", "T2"] } });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T1", "T1", "T3"]);
		assert.deepEqual(statuses(ws), { T1: "blocked", T2: "pending", T3: "done" });
	});

	it("ends done when every ticket is done", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		const { outcome } = await run(worker);
		assert.deepEqual(outcome, { status: "completed", result: { status: "done", tickets: [{ id: "T1", status: "done" }, { id: "T2", status: "done" }] } });
	});

	it("pauses after two consecutive failed tickets and does not start the next one", async () => {
		writeFileSync(
			ws.docPath,
			docText([
				"- T1 [S1] inline: a deps: none done: `cat never.txt` — pending",
				"- T2 [S1] inline: b deps: none done: `cat never.txt` — pending",
				"- T3 [S2] inline: c deps: none done: `test -f t3.txt` — pending",
			]),
		);
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		const { outcome } = await run(worker, { maxAttempts: 1 });
		assert.equal(outcome.status, "completed");
		const result = (outcome as { result: { status: string; reason: string } }).result;
		assert.equal(result.status, "paused");
		assert.match(result.reason, /two consecutive tickets failed: T1, T2/);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"]);
		assert.deepEqual(statuses(ws), { T1: "blocked", T2: "blocked", T3: "pending" });
	});

	it("fails a ticket whose worker leaves no commit, even when the done command passes", async () => {
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: a deps: none done: `true` — pending"]));
		const worker = makeWorker({ T1: "echo nothing to commit" });
		const { outcome } = await run(worker, { maxAttempts: 2 });
		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T1"] } });
		assert.match(ticketLine(readDoc(ws), "T1"), /— blocked needs you: no commit/);
		assert.equal(worker.prompts.length, 2);
	});

	it("starting the same doc twice returns the same task (idempotent per doc path)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: commitFile("t1.txt") });
		runner = await openFixtureRunner(ws, worker);
		const first = await runner.start(ws.docPath);
		const second = await runner.start(ws.docPath);
		assert.equal(first, second);
		await runner.wait(first);
		assert.equal(await runner.start(ws.docPath), first, "also after the loop ended");
		assert.equal(worker.prompts.length, 1);
	});
});

describe("ticket task (S2)", () => {
	it("runs the done command and reads HEAD through the injected deps, in the repo, once per attempt", async () => {
		writeFileSync(ws.docPath, docText([T3_FAILS]));
		const worker = makeWorker({ T3: commitFile("t3.txt") });
		const calls: string[] = [];
		const deps: TicketDeps = {
			run: (command, cwd, signal) => (calls.push(`run ${command} @ ${cwd}`), defaultDeps.run(command, cwd, signal)),
			head: (cwd, signal) => (calls.push(`head @ ${cwd}`), defaultDeps.head(cwd, signal)),
		};
		runner = await openFixtureRunner(ws, worker, { deps });
		await runner.wait(await runner.start(ws.docPath, { maxAttempts: 2 }));
		const repo = runner.cwd;
		// The start HEAD is read once (memoized at the first start); each attempt then runs the check and reads HEAD.
		assert.deepEqual(calls, [`head @ ${repo}`, `run cat never.txt @ ${repo}`, `head @ ${repo}`, `run cat never.txt @ ${repo}`, `head @ ${repo}`]);
	});

	it("creates one worker conversation per attempt, owned by the ticket task, with a deterministic requestId", async () => {
		writeFileSync(ws.docPath, docText([T3_FAILS]));
		const worker = makeWorker({ T3: commitFile("t3.txt") });
		runner = await openFixtureRunner(ws, worker);
		await runner.wait(await runner.start(ws.docPath, { maxAttempts: 2 }));
		const found = await runner.harness.commit(async (tx) => {
			const [ticket] = (await tx.scanTasks({ kind: "brigadev.ticket" }, 10)).items;
			const conversations = (await tx.scanConversations({ ownerTaskId: ticket.id }, 10)).items;
			const requests = await Promise.all(conversations.map(async (c, i) => (await tx.submissionByRequest(c.id, `ticket:${ticket.id}:attempt:${i + 1}`))?.notify?.taskId));
			return { ticket: ticket.id, owner: ticket.owner, requests, count: conversations.length };
		}, context);
		assert.equal(found.count, 2);
		assert.deepEqual(found.requests, [found.ticket, found.ticket], "each attempt's submission notifies the ticket task");
		assert.ok(found.owner, "the ticket task is owned by the loop task");
	});
});

describe("abort", () => {
	it("aborting the loop mid-check ends it `aborted`, and so the ticket task it owns", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let reached!: () => void;
		const inCheck = new Promise<void>((resolve) => (reached = resolve));
		const deps: TicketDeps = {
			head: defaultDeps.head,
			run: async (_command, _cwd, signal) => {
				reached();
				await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
				throw new Error("unreachable");
			},
		};
		runner = await openFixtureRunner(ws, worker, { deps });
		const id = await runner.start(ws.docPath);
		await inCheck;
		assert.equal(await runner.harness.abortTask(id, context), "marked");
		assert.deepEqual(await runner.wait(id), { status: "aborted" });
		const child = await runner.harness.commit(async (tx) => (await tx.scanTasks({ kind: "brigadev.ticket" }, 10)).items[0]?.state.outcome?.status, context);
		assert.equal(child, "aborted");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"]);
	});
});

describe("runner-only start rules (S7, A2)", () => {
	it("refuses a doc whose unfinished ticket has a done: that is not a command, listing every error", async () => {
		writeFileSync(
			ws.docPath,
			docText([T1, "- T3 [S2] inline: board deps: none done: the board shows cards — pending", "- T4 [S2] inline: no check deps: none — pending"]),
		);
		const worker = makeWorker({ T1: commitFile("t1.txt") });
		const { outcome } = await run(worker);
		assert.equal(outcome.status, "failed");
		const message = (outcome as { error: { message: string } }).error.message;
		assert.ok(message.includes("T3 done: is not a command"), message);
		assert.ok(message.includes("T4 has no done: check"), message);
		assert.equal(worker.prompts.length, 0);
		assert.equal(readDoc(ws).includes("in_progress"), false);
	});

	it("leaves finished tickets alone: a done ticket with an observable check does not block the start", async () => {
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: old deps: none done: the page renders — done abc1234", T2]));
		const worker = makeWorker({ T2: commitFile("t2.txt") });
		const { outcome } = await run(worker);
		assert.deepEqual((outcome as { result: { status: string } }).result.status, "done");
	});
});

describe("doc ownership while running (S8, A4)", () => {
	it("a user edit to the running ticket's line pauses the loop and writes nothing", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let edited = "";
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId !== "T1") return;
			edited = readDoc(ws).replace("inline: first", "inline: first (user reworded)");
			writeFileSync(ws.docPath, edited);
		};
		const { outcome } = await run(worker);
		assert.deepEqual(outcome, { status: "completed", result: { status: "paused", reason: "doc edited: T1" } });
		assert.equal(readDoc(ws), edited, "nothing was written over the user's edit");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"]);
	});

	it("a user edit to a finished ticket's line pauses at the next write-back", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let edited = "";
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId !== "T2") return;
			edited = readDoc(ws).replace("inline: first", "inline: first (edited after done)");
			writeFileSync(ws.docPath, edited);
		};
		const { outcome } = await run(worker);
		assert.deepEqual(outcome, { status: "completed", result: { status: "paused", reason: "doc edited: T1" } });
		assert.equal(readDoc(ws), edited);
	});

	it("an edit to a pending ticket is picked up at the next pick", async () => {
		writeFileSync(ws.docPath, docText([T1, "- T2 [S2] inline: second deps: T1 done: `cat never.txt` — pending"]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId === "T1") writeFileSync(ws.docPath, readDoc(ws).replace("cat never.txt", "test -f t2.txt"));
		};
		const { outcome } = await run(worker);
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.deepEqual(statuses(ws), { T1: "done", T2: "done" });
	});

	it("a changed spec reopens its linked done tickets with `reopened: S# changed`, and the loop runs them again", async () => {
		writeFileSync(ws.docPath, docText([T1, "- T2 [S2] inline: second deps: T1 done: `test -f t2.txt` — pending"]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let reopenedLine = "";
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId === "T2" && prompt.run === 1) writeFileSync(ws.docPath, readDoc(ws).replace("First behavior.", "First behavior, revised."));
			if (prompt.ticketId === "T1" && prompt.run === 2) reopenedLine = ticketLine(readDoc(ws), "T1");
		};
		const { outcome } = await run(worker);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2", "T1"]);
		assert.match(reopenedLine, /— in_progress/, "T1 was reopened to pending, then picked again");
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.deepEqual(statuses(ws), { T1: "done", T2: "done" });
		assert.ok(readDoc(ws).includes("First behavior, revised."), "the user's spec edit survives the write-back");
	});

	it("leaves `reopened: S1 changed` on the line when the loop pauses right after reopening", async () => {
		writeFileSync(
			ws.docPath,
			docText([
				T1,
				"- T2 [S2] inline: b deps: none done: `cat never.txt` — pending",
				"- T3 [S2] inline: c deps: none done: `cat never.txt` — pending",
			]),
		);
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		worker.onPrompt = (prompt) => {
			if (prompt.ticketId === "T3") writeFileSync(ws.docPath, readDoc(ws).replace("First behavior.", "First behavior, revised."));
		};
		const { outcome } = await run(worker, { maxAttempts: 1 });
		assert.equal((outcome as { result: { status: string } }).result.status, "paused");
		assert.match(ticketLine(readDoc(ws), "T1"), /— pending reopened: S1 changed$/);
		assert.deepEqual(statuses(ws), { T1: "pending", T2: "blocked", T3: "blocked" });
	});
});
