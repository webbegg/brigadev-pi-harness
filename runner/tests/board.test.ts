// T7 (S6): the runner serves the web UI's board. R1: the loop's state as `{type, data}` events of the web log (the bus snapshot shapes of lib/bus.ts); R2: the
// page's actions delivered in-process through the live Runner (the Harness `start` opened), end to end over HTTP with a real session secret from the one-time code.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { basename } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import type { PromptState } from "../../lib/bus.ts";
import { createWebLog, type WebLog } from "../../lib/web-log.ts";
import type { WebServer } from "../../lib/web-server.ts";
import { createBoard, serveBoard, type Board, type ServedBoard } from "../src/board.ts";
import { answerDecision } from "../src/control.ts";
import { POLL_MS } from "../src/pr.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";
import { askUser, commitFile, docText, fakeClock, FEATURE_BRANCH, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";
import { addRemote, drivers, FakeGh, prDepsOf, until } from "./pr-fixture.ts";

let env: Isolation;
before(() => {
	env = isolateEnv();
});
after(() => env.restore());

let ws: Workspace;
let runner: FixtureRunner | undefined;
let served: ServedBoard | undefined;
let extra: Board[] = [];
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(async () => {
	for (const board of extra) await board.stop();
	extra = [];
	await served?.close();
	served = undefined;
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending";
const T2 = "- T2 [S2] inline: after first deps: T1 done: `test -f t2.txt` — pending";
const T3 = "- T3 [S2] inline: independent deps: none done: `test -f t3.txt` — pending";
const QUESTION = "Which storage?";
const OPTIONS = [{ label: "SQLite", description: "one file" }, { label: "JSONL", description: "append only" }];
const TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

// ---------------------------------------------------------------------------------------------------------------------
// Readers of the web log, and a browser's way in

const eventsOf = (log: WebLog, type: string) => log.since(0).filter((event) => event.type === type);
const dataOf = <T = any>(log: WebLog, type: string, key?: string): T | undefined => eventsOf(log, type).find((event) => key === undefined || event.key === key)?.data as T | undefined;
const prompts = (log: WebLog): Record<string, PromptState> => Object.fromEntries(eventsOf(log, "brigadev_prompt").map((event) => [event.key!, event.data as PromptState]));
const openPrompt = (log: WebLog, match: (prompt: PromptState) => boolean = () => true) => Object.values(prompts(log)).find((prompt) => prompt.status === "open" && match(prompt));
const agentOf = (log: WebLog, id: string) => dataOf<any>(log, "brigadev_agent", id);

interface Reply {
	status: number;
	body: any;
}

/** Sign in as the page does (the one-time code in a header, spent at once) and return a function that POSTs actions with the session secret. */
async function signIn(server: WebServer): Promise<(body: unknown) => Promise<Reply>> {
	const code = new URL(server.openUrl()).searchParams.get("code")!;
	const session = await fetch(`${server.url}session`, { method: "POST", headers: { "x-brigadev-code": code } });
	assert.equal(session.status, 200);
	const { secret } = (await session.json()) as { secret: string };
	return async (body) => {
		const res = await fetch(`${server.url}action`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
		const text = await res.text();
		return { status: res.status, body: text ? JSON.parse(text) : undefined };
	};
}

const BOARD = { debounceMs: 10, pollMs: 2_000 };

/** Ticket deps whose done check awaits `hook` first (the user acts "meanwhile"). */
const defaultDepsWith = (hook: () => Promise<void>): TicketDeps => ({ head: defaultDeps.head, run: async (command, cwd, signal, shell) => (await hook(), defaultDeps.run(command, cwd, signal, shell)) });

describe("the adapter (R1): the loop's state as events of the web log", () => {
	it("maps the doc and the loop to session, todo, run, phase, and one agent card per ticket that ran: done with its commit, failed with its attempts, steps from the store, no credential", async () => {
		const failing = `- T2 [S2] inline: broken deps: none done: \`echo ${TOKEN}; exit 1\` — pending`;
		writeFileSync(ws.docPath, docText([T1, failing, "- T3 [S2] inline: after broken deps: T2 done: `test -f t3.txt` — pending"]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		runner = await openFixtureRunner(ws, worker);
		const log = createWebLog();
		const board = await createBoard({ runner, docPath: ws.docPath, log, ...BOARD });
		extra.push(board);
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "completed", result: { status: "stalled", waiting: ["T2", "T3"] } });
		await board.refresh();

		assert.deepEqual(dataOf(log, "session"), { id: "session", project: basename(ws.repo), branch: FEATURE_BRANCH, kind: "runner", doc: "feature.md" });
		const todo = dataOf<any>(log, "brigadev_todo");
		assert.equal(todo.scope, "todo");
		assert.deepEqual(todo.todos.map((t: any) => [t.id, t.status]), [["T1", "done"], ["T2", "blocked"], ["T3", "pending"]]);
		assert.match(todo.todos[0].text, /first/);

		const ids = eventsOf(log, "brigadev_agent").map((event) => event.key).sort();
		assert.deepEqual(ids, ["ticket:T1", "ticket:T2"], "a card for each ticket that ran; T3 never did");
		const first = agentOf(log, "ticket:T1");
		const sha = /— done ([0-9a-f]{7}) /.exec(ticketLine(readDoc(ws), "T1"))![1];
		assert.equal(first.agent, "brigadev-worker");
		assert.equal(first.status, "done");
		assert.match(first.task, /first/);
		assert.match(first.output, new RegExp(`^DONE\\n[\\s\\S]*commit: ${sha}`));
		assert.match(first.output, /attempts: 1/);
		assert.equal(first.cancellable, false);
		assert.ok(first.steps.some((step: any) => step.tool === "bash" && /t1\.txt/.test(step.summary)), "the worker's tool calls, from its conversation");
		assert.ok(first.steps.some((step: any) => step.tool === "check"));
		const broken = agentOf(log, "ticket:T2");
		assert.equal(broken.status, "failed");
		assert.match(broken.reason, /needs you: done check failed after 3 attempts/);
		assert.match(broken.output, /^FAILED\n/);
		assert.match(broken.output, /attempts: 3/);
		assert.ok(!JSON.stringify(log.since(0)).includes(TOKEN), "the failing check's output is redacted before it leaves");
		assert.match(broken.output, /\*\*\*/);

		assert.equal(dataOf<any>(log, "run").running, false);
		assert.deepEqual([dataOf<any>(log, "brigadev_phase").scope, dataOf<any>(log, "brigadev_phase").phase, dataOf<any>(log, "brigadev_phase").running], ["loop", "idle", false]);

		// Nothing changed: nothing is published again.
		const seq = log.lastSeq();
		await board.refresh();
		assert.equal(log.lastSeq(), seq, "only what changed is published");
	});

	it("refreshes by itself: when the task graph advances (debounced), and on the slow timer when it is not observed", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: commitFile("t1.txt") });
		runner = await openFixtureRunner(ws, worker);
		const log = createWebLog();
		extra.push(await createBoard({ runner, docPath: ws.docPath, log, ...BOARD }));
		// Not observing the graph: only the timer can show it what happens after it was created (before the loop exists).
		const slow = createWebLog();
		extra.push(await createBoard({ runner, docPath: ws.docPath, log: slow, observe: false, debounceMs: 10, pollMs: 15 }));
		assert.equal(dataOf<any>(slow, "brigadev_phase").phase, "idle", "before the loop exists the board shows an idle session");
		assert.equal(dataOf<any>(slow, "brigadev_todo").todos.length, 1, "and the doc's tickets");
		const id = await runner.start(ws.docPath);
		await until(() => agentOf(log, "ticket:T1")?.status === "done" || undefined, "T1's card to be done, with no refresh asked for");
		assert.equal((await runner.wait(id)).status, "completed");
		await until(() => (agentOf(slow, "ticket:T1")?.status === "done" ? true : undefined), "the timer to publish T1's card");
		await until(() => (dataOf<any>(slow, "brigadev_phase")?.phase === "close" ? true : undefined), "the timer to see the loop end");
		await until(() => (dataOf<any>(log, "brigadev_phase")?.phase === "close" ? true : undefined), "the observer to see the loop end");
	});

	it("an open decision is a choice prompt (id = its signal key, options, recommended, free text allowed) and the ticket's card needs you; it closes whoever answered (here the CLI's own function)", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS, { recommended: 2, command: "npm run weird" })] : commitFile("t1.txt")), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		runner = await openFixtureRunner(ws, worker);
		const log = createWebLog();
		extra.push(await createBoard({ runner, docPath: ws.docPath, log, ...BOARD }));
		const id = await runner.start(ws.docPath);
		assert.equal((await runner.settle(id)).status, "waiting");
		const prompt = await until(() => openPrompt(log), "the decision prompt");
		assert.equal(prompt.id, (await runner.status(id)).decisions[0].key);
		assert.equal(prompt.id, "decision-T1-1");
		assert.equal(prompt.kind, "choice");
		assert.match(prompt.title, /^T1: Which storage\?/);
		assert.deepEqual(prompt.options, OPTIONS);
		assert.equal(prompt.recommended, 2);
		assert.equal(prompt.allowOther, true);
		assert.match(prompt.body ?? "", /npm run weird/, "the command it needs approved is shown");
		await until(() => agentOf(log, "ticket:T1")?.status === "needs-you" || undefined, "T1's card to need you");
		assert.equal(dataOf<any>(log, "brigadev_phase").phase, "decide");

		const answered = await answerDecision(runner, ws.docPath, "T1", "1");
		assert.equal(answered.code, 0, answered.text);
		const closed = await until(() => (prompts(log)[prompt.id].status !== "open" ? prompts(log)[prompt.id] : undefined), "the prompt to close");
		assert.equal(closed.status, "dismissed", "answered elsewhere: the board does not know the answer");
		assert.equal(closed.reason, "no longer current", "the page says the loop moved on, not that the prompt was dropped");
		assert.equal((await runner.wait(id)).status, "completed");
	});
});

describe("actions (R2): the board answers through the live runner", () => {
	it("a parked decision: the board shows it, POST /action answer continues the loop in this process and closes the prompt; a second answer is 409; no secret, no action", async () => {
		writeFileSync(ws.docPath, docText([T1, T2]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS, { recommended: 1 })] : commitFile("t1.txt")), T2: commitFile("t2.txt") });
		runner = await openFixtureRunner(ws, worker);
		served = await serveBoard(runner, ws.docPath, { port: 0, ...BOARD });
		const act = await signIn(served.server);
		assert.equal((await fetch(`${served.server.url}action`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "abort" }) })).status, 401, "no session secret, no action");

		const id = await runner.start(ws.docPath);
		const prompt = await until(() => openPrompt(served!.log), "the decision prompt");
		assert.equal(prompt.kind, "choice");
		assert.equal(worker.prompts.filter((p) => p.ticketId === "T1").length, 1, "T1 ran once and parked");

		const reply = await act({ action: "answer", id: prompt.id, value: "JSONL" });
		assert.deepEqual([reply.status, reply.body], [202, { ok: true }]);
		const settled = await until(() => (prompts(served!.log)[prompt.id].status === "answered" ? prompts(served!.log)[prompt.id] : undefined), "the prompt to close");
		assert.deepEqual([settled.answer, settled.by], ["JSONL", "web"]);
		const outcome = await runner.wait(id);
		assert.equal(outcome.status, "completed", "the loop continued in the same process: no start again");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T1", "T2"]);
		assert.match(worker.prompts[1].system, /answer: JSONL/i, "the option's label, as the CLI's number would give");
		assert.match(ticketLine(readDoc(ws), "T1"), /— done /);

		const again = await act({ action: "answer", id: prompt.id, value: "SQLite" });
		assert.equal(again.status, 409);
		assert.match(again.body.error, /no longer open/);
		const strange = await act({ action: "answer", id: "decision-T9-1", value: "x" });
		assert.equal(strange.status, 409, "an id that is not open now");
	});

	it("free text answers a decision (allowOther); a choice is not a yes/no, and the page's prompt and cancel actions are refused with a reason", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser(QUESTION, OPTIONS)] : commitFile("t1.txt")) });
		runner = await openFixtureRunner(ws, worker);
		served = await serveBoard(runner, ws.docPath, { port: 0, ...BOARD });
		const act = await signIn(served.server);
		const id = await runner.start(ws.docPath);
		const prompt = await until(() => openPrompt(served!.log), "the decision prompt");

		const message = await act({ action: "prompt", text: "hello" });
		assert.equal(message.status, 409);
		assert.match(message.body.error, /no conversation/);
		const cancel = await act({ action: "cancel-agent", id: "ticket:T1" });
		assert.equal(cancel.status, 409);
		assert.match(cancel.body.error, /Pause/);
		const yes = await act({ action: "answer", id: prompt.id, value: true });
		assert.equal(yes.status, 409);
		assert.match(yes.body.error, /option|text/);
		const number = await act({ action: "answer", id: prompt.id, value: "7" });
		assert.equal(number.status, 409, "a bare number outside the options is the CLI's `invalid`");
		assert.equal(openPrompt(served.log)?.id, prompt.id, "still open after every refusal");

		const text = await act({ action: "answer", id: prompt.id, value: "Neither: use a flat file and say so in the README" });
		assert.equal(text.status, 202);
		assert.equal((await runner.wait(id)).status, "completed");
		assert.match(worker.prompts[1].system, /answer: Neither: use a flat file/i);
	});

	it("merge approval from the board merges with --match-head-commit (the fake gh records it); Deny is a no-op that closes nothing", async () => {
		const gh = new FakeGh(addRemote(ws));
		const clock = fakeClock();
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: app deps: none done: `test -f app.js` — pending"]));
		const worker = makeWorker({ T1: commitFile("app.js") });
		runner = await openFixtureRunner(ws, worker, { clock, prDeps: prDepsOf(gh) });
		served = await serveBoard(runner, ws.docPath, { port: 0, ...BOARD });
		const act = await signIn(served.server);
		const log = served.log;
		const id = await runner.start(ws.docPath, { pr: true });
		const d = drivers(() => runner!, gh, clock, POLL_MS);
		const at = await d.atMerge(id);

		const prompt = await until(() => openPrompt(log, (p) => p.source === "merge"), "the merge prompt");
		assert.equal(prompt.id, at.mergeKey);
		assert.equal(prompt.kind, "confirm");
		const sha = gh.remoteSha(FEATURE_BRANCH)!;
		assert.equal(prompt.title, `Merge PR #1 at ${sha.slice(0, 7)}?`);
		assert.match(prompt.body ?? "", /https:\/\/github\.com\/acme\/repo\/pull\/1/);
		assert.match(prompt.body ?? "", /CI/);
		const card = await until(() => (agentOf(log, "pr")?.status === "needs-you" ? agentOf(log, "pr") : undefined), "the PR card to need you");
		assert.equal(card.agent, "brigadev-pr");
		assert.match(card.taskText + card.output, /pull\/1/);
		assert.equal(dataOf<any>(log, "brigadev_phase").phase, "commit");

		const deny = await act({ action: "answer", id: prompt.id, value: false });
		assert.equal(deny.status, 202);
		assert.equal(openPrompt(log, (p) => p.source === "merge")?.id, prompt.id, "Deny closes nothing");
		assert.equal(gh.merges().length, 0);

		const approve = await act({ action: "answer", id: prompt.id, value: true });
		assert.equal(approve.status, 202);
		const outcome = (await runner.wait(id)) as { status: string; result: { status: string } };
		assert.equal(outcome.result.status, "merged");
		assert.equal(gh.merges().length, 1);
		const args = gh.merges()[0];
		assert.equal(args[args.indexOf("--match-head-commit") + 1], sha, "merged at the head the prompt named");
		await served.board.refresh();
		assert.equal(prompts(log)[prompt.id].status, "answered");
		assert.equal(agentOf(log, "pr").status, "done");
		assert.equal(dataOf<any>(log, "brigadev_phase").phase, "close");
		assert.equal((await act({ action: "answer", id: prompt.id, value: true })).status, 409, "a second approval");
		assert.equal(gh.merges().length, 1);
	});

	it("Pause from the board pauses the loop at its next pick, the Resume prompt appears and works; Pause while paused is 409", async () => {
		writeFileSync(ws.docPath, docText([T1, "- T2 [S2] inline: second deps: none done: `test -f t2.txt` — pending"]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });
		let act!: (body: unknown) => Promise<Reply>;
		let asked = false;
		const deps = defaultDepsWith(async () => {
			if (asked) return;
			asked = true;
			// The user presses Pause while T1's done check runs.
			const reply = await act({ action: "abort" });
			assert.deepEqual([reply.status, reply.body], [202, { ok: true }]);
		});
		runner = await openFixtureRunner(ws, worker, { deps });
		served = await serveBoard(runner, ws.docPath, { port: 0, ...BOARD });
		act = await signIn(served.server);
		const id = await runner.start(ws.docPath);
		assert.deepEqual(await runner.settle(id), { status: "waiting", paused: "paused by user", decisions: [] });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "T1 finished, T2 did not start");

		const prompt = await until(() => openPrompt(served!.log, (p) => p.title === "Resume the loop?"), "the Resume prompt");
		assert.equal(prompt.kind, "confirm");
		assert.match(prompt.body ?? "", /paused by user/);
		assert.equal(prompt.id, (await runner.status(id)).resumeKey);
		assert.equal(dataOf<any>(served.log, "brigadev_phase").phase, "idle");
		const twice = await act({ action: "abort" });
		assert.equal(twice.status, 409);
		assert.match(twice.body.error, /already paused/);

		assert.equal((await act({ action: "answer", id: prompt.id, value: true })).status, 202);
		assert.equal((await runner.wait(id)).status, "completed");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"], "the loop went on in this process");
		await until(() => (prompts(served!.log)[prompt.id].status === "answered" ? true : undefined), "the Resume prompt to close");
		assert.equal((await act({ action: "answer", id: prompt.id, value: true })).status, 409);
	});

	it("the event stream carries the runner's session snapshot (kind: runner, doc) to a signed-in page", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await openFixtureRunner(ws, makeWorker({ T1: commitFile("t1.txt") }));
		served = await serveBoard(runner, ws.docPath, { port: 0, ...BOARD });
		await served.board.refresh();
		const code = new URL(served.server.openUrl()).searchParams.get("code")!;
		const { secret } = (await (await fetch(`${served.server.url}session`, { method: "POST", headers: { "x-brigadev-code": code } })).json()) as { secret: string };
		const controller = new AbortController();
		const res = await fetch(`${served.server.url}events`, { headers: { authorization: `Bearer ${secret}` }, signal: controller.signal });
		assert.equal(res.status, 200);
		const reader = res.body!.getReader();
		let text = "";
		while (!/"kind":"runner"/.test(text)) {
			const chunk = await reader.read();
			assert.ok(!chunk.done, "the stream ended before the session event");
			text += new TextDecoder().decode(chunk.value);
		}
		assert.match(text, /"doc":"feature\.md"/);
		controller.abort();
		assert.equal(served.server.url, `http://127.0.0.1:${served.server.port}/`, "loopback only");
	});
});
