// H5 at the board, with a scripted Runner (no Harness, no git, no model: fast and deterministic):
//  - redaction at the one `clean` choke point covers what runner/src/redact.ts masks (standard base64 with `+` and `/`), also in what a refusal says;
//  - R1-001: an answer acts only on what the page showed: the prompt's key (and for the merge, the head sha it names) must still be current when the control reads
//    the state, and what is delivered is the key the prompt named; otherwise 409 and nothing is delivered;
//  - R4-002: a refresh that lands after the loop's last check runs again;
//  - stop() while a refresh is mid-read ends cleanly.
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { createWebLog, type WebLog } from "../../lib/web-log.ts";
import { ActionRefused } from "../../lib/web-server.ts";
import { createBoard, type Board } from "../src/board.ts";
import { mergeLoop } from "../src/control.ts";
import type { LoopStatus, PrStatus, Runner } from "../src/runner.ts";
import type { OpenDecision } from "../src/tasks.ts";

const DOC = "/tmp/brigadev-board-hardening/feature.md";
const AWS_SECRET = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

const decision = (round: number, over: Partial<OpenDecision> = {}): OpenDecision =>
	({ ticketId: "T1", key: `decision-T1-${round}`, round, until: 1, question: "Which storage?", options: [{ label: "SQLite" }, { label: "JSONL" }], recommended: null, command: null, ...over }) as OpenDecision;

const loopStatus = (over: Partial<LoopStatus> = {}): LoopStatus => ({ taskId: 1 as never, docPath: DOC, state: "sleeping", decisions: [], lastKeys: {}, epoch: 0, ...over });

const prStatus = (over: Partial<PrStatus> = {}): PrStatus => ({ taskId: 2 as never, phase: "wait-merge", asleep: true, url: "https://github.com/acme/repo/pull/7", number: 7, sha: "a".repeat(40), decisions: [], lastKeys: {}, mergeKey: "merge-1", ...over });

interface Delivery {
	taskId: number;
	key: string;
	value: unknown;
}

/** A Runner whose `status()` is read from a queue (then `current`), and whose deliveries are recorded. */
function scripted(first: LoopStatus) {
	const queue: LoopStatus[] = [];
	let current = first;
	const delivered: Delivery[] = [];
	const runner = {
		cwd: "/tmp/brigadev-board-hardening/repo",
		harness: { resume() {} },
		async find() {
			return 1;
		},
		async status() {
			return queue.shift() ?? current;
		},
		async ticketRuns() {
			return [];
		},
		async deliver(taskId: number, _token: unknown, key: string, value: unknown) {
			delivered.push({ taskId, key, value });
			return "delivered";
		},
	};
	return {
		runner: runner as unknown as Runner & { status: () => Promise<LoopStatus> },
		delivered,
		/** The state from now on. */
		set: (status: LoopStatus) => {
			current = status;
		},
		/** The next reads only, in order: the board's own read of an action, then the control's. */
		next: (...statuses: LoopStatus[]) => queue.push(...statuses),
	};
}

let boards: Board[] = [];
afterEach(async () => {
	for (const board of boards) await board.stop();
	boards = [];
});

async function boardOver(world: ReturnType<typeof scripted>, log: WebLog = createWebLog()) {
	const board = await createBoard({ runner: world.runner, docPath: DOC, log, observe: false, pollMs: 3_600_000, debounceMs: 1, readBranch: async () => "feat/x" });
	boards.push(board);
	return { board, log };
}

const events = (log: WebLog, type: string) => log.since(0).filter((event) => event.type === type);
const phaseOf = (log: WebLog) => (events(log, "brigadev_phase").at(-1)?.data as { phase: string; detail?: string }).phase;

describe("redaction at the board's one gate (H5)", () => {
	it("masks standard base64 with `+` and `/` (an AWS secret key), which lib/redact.ts misses: in a decision's question and options", async () => {
		const world = scripted(loopStatus({ decisions: [decision(1, { question: `Use key ${AWS_SECRET}?`, options: [{ label: `Key ${AWS_SECRET}` }, { label: "no" }] })] }));
		const { log } = await boardOver(world);
		const published = JSON.stringify(log.since(0));
		assert.ok(published.includes("Use key"), "the question is there");
		assert.ok(!published.includes(AWS_SECRET), "but not the key");
		assert.ok(!published.includes("K7MDENG"), "nor a piece of it");
		assert.match(published, /\*\*\*/);
	});

	it("masks what a refusal says too (the 409 body is page-bound text)", async () => {
		const world = scripted(loopStatus({ state: "paused", reason: `paused: ${AWS_SECRET}`, resumeKey: "resume-0" }));
		const { board } = await boardOver(world);
		await assert.rejects(board.onAction({ action: "abort" }), (error: Error) => error instanceof ActionRefused && /already paused/.test(error.message) && !error.message.includes(AWS_SECRET));
	});
});

describe("an answer acts only on what the page showed (R1-001)", () => {
	const moved = /no longer|changed|moved/;

	it("a decision: delivered with the key the prompt named when it is still the open one", async () => {
		const world = scripted(loopStatus({ decisions: [decision(1)] }));
		const { board } = await boardOver(world);
		await board.onAction({ action: "answer", id: "decision-T1-1", value: "SQLite" });
		assert.deepEqual(world.delivered.map((d) => [d.taskId, d.key]), [[1, "decision-T1-1"]]);
	});

	it("a decision that moved to a new round between the board's read and the control's: 409, nothing delivered", async () => {
		const world = scripted(loopStatus({ decisions: [decision(1)] }));
		const { board } = await boardOver(world);
		// The board's read still shows round 1; by the time the control reads, the ticket asked again (round 2).
		world.next(loopStatus({ decisions: [decision(1)] }), loopStatus({ decisions: [decision(2, { question: "Which cache?" })] }));
		await assert.rejects(board.onAction({ action: "answer", id: "decision-T1-1", value: "SQLite" }), (error: Error) => error instanceof ActionRefused && moved.test(error.message));
		assert.deepEqual(world.delivered, [], "the answer to round 1 was not delivered to round 2");
	});

	it("a decision the page showed, gone (answered elsewhere) when the POST lands: 409, nothing delivered", async () => {
		const world = scripted(loopStatus({ decisions: [decision(1)] }));
		const { board } = await boardOver(world);
		world.set(loopStatus({ decisions: [], lastKeys: { T1: "decision-T1-1" } }));
		await assert.rejects(board.onAction({ action: "answer", id: "decision-T1-1", value: "SQLite" }), ActionRefused);
		assert.deepEqual(world.delivered, []);
	});

	it("the merge: delivered with the merge key the prompt named, at the sha its title showed", async () => {
		const world = scripted(loopStatus({ pr: prStatus() }));
		const { board, log } = await boardOver(world);
		const prompt = events(log, "brigadev_prompt").at(-1)!.data as { id: string; title: string };
		assert.equal(prompt.id, "merge-1");
		assert.match(prompt.title, /^Merge PR #7 at aaaaaaa\?$/);
		await board.onAction({ action: "answer", id: "merge-1", value: true });
		assert.deepEqual(world.delivered.map((d) => [d.taskId, d.key]), [[2, "merge-1"]]);
	});

	it("the merge: a new head sha (same key) between the page's view and the POST: 409, nothing delivered; so is a new merge key in the window", async () => {
		const world = scripted(loopStatus({ pr: prStatus() }));
		const { board } = await boardOver(world);
		world.set(loopStatus({ pr: prStatus({ sha: "b".repeat(40) }) })); // pushed again: the page still shows the old title
		await assert.rejects(board.onAction({ action: "answer", id: "merge-1", value: true }), (error: Error) => error instanceof ActionRefused && moved.test(error.message));
		assert.deepEqual(world.delivered, [], "the approval was for aaaaaaa, not bbbbbbb");

		const other = scripted(loopStatus({ pr: prStatus() }));
		const { board: second } = await boardOver(other);
		other.next(loopStatus({ pr: prStatus() }), loopStatus({ pr: prStatus({ mergeKey: "merge-2", sha: "b".repeat(40) }) }));
		await assert.rejects(second.onAction({ action: "answer", id: "merge-1", value: true }), ActionRefused);
		assert.deepEqual(other.delivered, []);
	});

	it("resume: a resume key that moved in the window is refused; the same key is delivered", async () => {
		const paused = (key: string) => loopStatus({ state: "paused", reason: "paused by user", resumeKey: key });
		const world = scripted(paused("resume-0"));
		const { board } = await boardOver(world);
		world.next(paused("resume-0"), paused("resume-1"));
		await assert.rejects(board.onAction({ action: "answer", id: "resume-0", value: true }), ActionRefused);
		assert.deepEqual(world.delivered, []);
		await board.onAction({ action: "answer", id: "resume-0", value: true }); // the queue is empty: both reads see resume-0
		assert.deepEqual(world.delivered.map((d) => d.key), ["resume-0"]);
	});

	it("the control functions take the expectation themselves (the CLI passes none and is unchanged): mergeLoop refuses a sha or key that is not current", async () => {
		const world = scripted(loopStatus({ pr: prStatus() }));
		assert.equal((await mergeLoop(world.runner, DOC, { key: "merge-1", sha: "b".repeat(40) })).code, 1);
		assert.equal((await mergeLoop(world.runner, DOC, { key: "merge-9" })).code, 1);
		assert.deepEqual(world.delivered, []);
		assert.equal((await mergeLoop(world.runner, DOC, { key: "merge-1", sha: "a".repeat(40) })).code, 0);
		assert.equal((await mergeLoop(world.runner, DOC)).code, 0, "no expectation: as before");
		assert.deepEqual(world.delivered.map((d) => d.key), ["merge-1", "merge-1"]);
	});
});

describe("the refresh coalescer loses no update (R4-002)", () => {
	it("a refresh() that lands after the loop's last check (any number of microtasks after the publish) still runs again: the board ends on the newest state", async () => {
		for (let hops = 0; hops <= 10; hops += 1) {
			const world = scripted(loopStatus({ state: "running" }));
			const log = createWebLog();
			let hook: (() => void) | undefined;
			const append = log.append.bind(log);
			log.append = (input) => {
				const event = append(input);
				const fire = hook;
				hook = undefined;
				fire?.();
				return event;
			};
			const { board } = await boardOver(world, log);
			assert.equal(phaseOf(log), "implement", "the first refresh saw the running loop");

			// The state moves, and a refresh runs: it publishes a changed phase, and while it does the state moves again and another refresh is requested, `hops`
			// microtasks later: after the refresh's last check of "again", before it counts itself finished.
			world.set(loopStatus({ state: "paused", reason: "p", resumeKey: "resume-0" }));
			hook = () => {
				world.set(loopStatus({ state: "done" }));
				let wait: Promise<void> = Promise.resolve();
				for (let i = 0; i < hops; i += 1) wait = wait.then(() => {});
				void wait.then(() => board.refresh());
			};
			await board.refresh();
			for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
			assert.equal(phaseOf(log), "close", `hops=${hops}: the refresh requested while the first was finishing must show the loop done, but the board shows ${phaseOf(log)}`);
		}
	});
});

describe("stop() while a refresh is mid-read (R3-001)", () => {
	it("leaves no unhandled rejection whether the read fails or finishes after stop, and stop() itself resolves", async () => {
		const unhandled: unknown[] = [];
		const onRejection = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onRejection);
		try {
			for (const outcome of ["fails", "finishes"] as const) {
				const world = scripted(loopStatus());
				const { board, log } = await boardOver(world);
				const seq = log.lastSeq();
				let release!: (status: LoopStatus | Error) => void;
				const pending = new Promise<LoopStatus>((resolve, reject) => {
					release = (value) => (value instanceof Error ? reject(value) : resolve(value));
				});
				world.runner.status = () => pending;
				const refreshing = board.refresh();
				const stopping = board.stop();
				release(outcome === "fails" ? new Error("the Harness is closing") : loopStatus({ state: "done" }));
				await Promise.all([refreshing, stopping]);
				await new Promise((resolve) => setImmediate(resolve));
				assert.equal(log.lastSeq(), seq, `${outcome}: nothing is published after stop()`);
				await board.refresh(); // after stop: no rejection either
			}
			await new Promise((resolve) => setImmediate(resolve));
			assert.deepEqual(unhandled, []);
		} finally {
			process.off("unhandledRejection", onRejection);
		}
	});
});
