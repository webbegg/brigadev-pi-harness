// The two durable tasks: `brigadev.ticket-loop` (pick → launch → record, ticket by ticket) and `brigadev.ticket`
// (one ticket: a worker conversation per attempt, then the done check). Both only commit state; the doc is written
// through lib/ticket-list.ts after re-reading it, so a user's edit is never overwritten.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { configure, defineTask, SubmissionSettled } from "@earendil-works/pi-durable";
import type { ModelRef, TaskId, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import {
	appendLogLine,
	changedSpecs,
	ownedLineConflicts,
	parseTicketList,
	readyTickets,
	setTicketStatus,
	ticketsLinkedTo,
	writeFileAtomic,
	type TicketStatus,
} from "../../lib/ticket-list.ts";
import { validateDoc } from "./doc.ts";
import { loadWorker, workerInput, workerInstructions, type TicketBrief, type Worker } from "./worker.ts";

export const LOOP_TASK = "brigadev.ticket-loop";
export const TICKET_TASK = "brigadev.ticket";
export const DEFAULT_MAX_ATTEMPTS = 3;
/** Consecutive failed tickets that pause the whole loop (S2). */
export const PAUSE_AFTER_FAILURES = 2;

// ---------------------------------------------------------------------------------------------------------------------
// Injectable effects

export interface RunResult {
	exitCode: number | null;
	output: string;
}

/** Everything the ticket task does outside storage; tests pass their own to observe or interrupt it. */
export interface TicketDeps {
	/** Run a shell command in `cwd`; stdout and stderr are combined. Rejects when `signal` aborts. */
	run(command: string, cwd: string, signal?: AbortSignal): Promise<RunResult>;
	/** The commit HEAD points at; "" when there is none yet. */
	head(cwd: string, signal?: AbortSignal): Promise<string>;
}

export const defaultDeps: TicketDeps = {
	run: (command, cwd, signal) =>
		new Promise((resolve, reject) => {
			let output = "";
			const child = spawn("sh", ["-c", command], { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
			child.stdout.on("data", (chunk) => (output += chunk));
			child.stderr.on("data", (chunk) => (output += chunk));
			child.on("error", reject);
			child.on("close", (exitCode) => resolve({ exitCode, output }));
		}),
	head: (cwd, signal) =>
		new Promise((resolve, reject) => {
			execFile("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd, signal }, (error, stdout) => {
				if (signal?.aborted) reject(error ?? new Error("aborted"));
				else resolve(error ? "" : stdout.trim());
			});
		}),
};

const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

export function tailOf(output: string): string {
	const lines = output.trimEnd().split("\n");
	const tail = lines.slice(-TAIL_LINES).join("\n");
	return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}

// ---------------------------------------------------------------------------------------------------------------------
// brigadev.ticket

export type TicketInput = {
	docPath: string;
	cwd: string;
	ticketId: string;
	title: string;
	/** The done command (backticks removed). */
	done: string;
	/** Linked spec IDs, for the worker's brief. */
	specs: string[];
	maxAttempts: number;
	model: ModelRef;
};

export type TicketState = { phase: "start"; attempt: number; failure?: string } | { phase: "check"; attempt: number; key: string };

export type TicketResult = { commit: string; outputTail: string; attempts: number };

/**
 * Tools the runner can give the worker: the worker's tool list restricted to what pi-durable's CodingTools provides, plus the
 * runner's own tools (`check`, which the worker's list does not name: the Pi worker records evidence through an extension instead).
 */
function workerTools(worker: Worker, extra: readonly ToolRegistration[]) {
	const available = [...(CodingTools.tools ?? []), ...extra] as ToolRegistration[];
	const wanted = worker.tools.length > 0 ? [...worker.tools, ...extra.map((tool) => tool.name)] : available.map((tool) => tool.name);
	return available.filter((tool) => wanted.includes(tool.name));
}

function createTicketTask(deps: TicketDeps, worker: Worker, extraTools: readonly ToolRegistration[]) {
	return defineTask<TicketInput, TicketState, TicketResult>({
		name: TICKET_TASK,
		version: 1,
		initial: () => ({ phase: "start", attempt: 1 }),
		phases: {
			start: async (task, runtime, context) => {
				const input = task.input;
				const { attempt, failure } = task.state.checkpoint;
				// The HEAD this ticket started from, memoized so a rerun (or a later attempt) compares against the same one.
				if ((await runtime.memo<string>("startHead", context)) === undefined) await runtime.memo("startHead", await deps.head(input.cwd, runtime.signal), context);

				const brief: TicketBrief = { ticketId: input.ticketId, title: input.title, specs: input.specs, done: input.done, docPath: input.docPath, attempt, maxAttempts: input.maxAttempts, failure };
				// One worker conversation per attempt, owned by this task and found again by position after a rerun.
				let conversationId!: string;
				await runtime.commit(async (tx) => {
					const owned = (await tx.scanConversations({ ownerTaskId: task.id }, 100)).items;
					if (owned.length >= attempt) {
						conversationId = owned[attempt - 1].id;
						return undefined;
					}
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					await configure(tx, created.id, { model: input.model, cwd: input.cwd, tools: workerTools(worker, extraTools), instructions: workerInstructions(worker, brief) });
					conversationId = created.id;
					return undefined;
				}, context);

				const conversation = await runtime.conversation(conversationId as never, context);
				if (!conversation) throw new Error(`worker conversation ${conversationId} is missing`);
				const key = `attempt-${attempt}`;
				// Admit the input and park on its settlement in one commit: no gap in which a crash loses either.
				await runtime.commit(async (tx) => {
					await conversation.submit(tx, {
						type: "input",
						content: workerInput(brief),
						requestId: `ticket:${task.id}:attempt:${attempt}`,
						notify: { taskId: task.id, key },
					});
					return { status: "sleeping", signals: [SubmissionSettled.key(key)], checkpoint: { phase: "check", attempt, key } };
				}, context);
			},

			check: async (task, runtime, context) => {
				const input = task.input;
				const { attempt, key } = task.state.checkpoint;
				const settled = await runtime.readSignal(SubmissionSettled, key, context);
				const workerNote = settled && "value" in settled && settled.value.status === "unanswered" ? `the worker run ended without an answer (${settled.value.reason})` : undefined;
				const startHead = await runtime.memo<string>("startHead", context);

				let run: RunResult;
				let head: string;
				try {
					run = await deps.run(input.done, input.cwd, runtime.signal);
					head = await deps.head(input.cwd, runtime.signal);
				} catch (error) {
					// Closing the Harness aborts the signal; this phase reruns from its top on reopen.
					if (runtime.signal.aborted) return;
					throw error;
				}

				const outputTail = tailOf(run.output);
				if (run.exitCode === 0 && head !== "" && head !== startHead) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { commit: head, outputTail, attempts: attempt } } }), context);
					return;
				}
				const message = run.exitCode !== 0 ? "done check failed" : "no commit";
				const detail = run.exitCode !== 0 ? `done check failed (exit ${run.exitCode ?? "signal"}) for \`${input.done}\`:\n${outputTail || "(no output)"}` : "no commit: the done check passed but HEAD did not move; commit the work.";
				const reason = [workerNote, detail].filter(Boolean).join("\n");
				if (attempt < input.maxAttempts) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "start", attempt: attempt + 1, failure: reason } }), context);
					return;
				}
				await runtime.commit(
					() => ({ status: "terminal", outcome: { status: "failed", error: { message: `${message} after ${attempt} attempt${attempt === 1 ? "" : "s"}`, detail: { reason: message, attempts: attempt, outputTail } } } }),
					context,
				);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// brigadev.ticket-loop

export type LoopInput = { docPath: string; cwd: string; maxAttempts?: number };

/** Runner-owned ticket lines as the runner last wrote them (S8). */
type Owned = Record<string, string>;
type Carry = { owned: Owned; baseline: string; failed: string[] };

export type LoopState =
	| ({ phase: "pick"; first: boolean } & Carry)
	| ({ phase: "launch"; ticketId: string } & Carry)
	| ({ phase: "record"; ticketId: string; childId: string; done: string } & Carry);

export type LoopResult =
	| { status: "done"; tickets: Array<{ id: string; status: string }> }
	| { status: "stalled"; waiting: string[] }
	| { status: "paused"; reason: string };

type Change = { id: string; status: TicketStatus; note: string; log?: string; own: boolean };
type WriteBack = { conflict: string } | { text: string; owned: Owned; baseline: string };

const rawOf = (text: string, id: string) => parseTicketList(text).tickets.find((ticket) => ticket.id === id)?.raw;
const hasLog = (text: string, log: string) => text.split("\n").some((line) => line.endsWith(`): ${log}`));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();

/**
 * The only way the loop writes the doc. Synchronously: re-read it, refuse when the user edited a runner-owned line,
 * apply `change`, reopen done tickets linked to specs changed since `baseline`, and write atomically.
 */
function writeBack(docPath: string, carry: Carry, change: Change | undefined, date: string): WriteBack {
	const text = readFileSync(docPath, "utf8");
	let next = text;
	if (change) {
		try {
			next = setTicketStatus(next, change.id, change.status, change.note);
		} catch {
			return { conflict: change.id }; // the ticket's line is gone
		}
	}
	// A rerun after a crash may find the change already written: that is not the user's edit.
	const conflicts = ownedLineConflicts(text, carry.owned).filter((id) => !(change && id === change.id && rawOf(text, id) === rawOf(next, id)));
	if (conflicts.length > 0) return { conflict: conflicts[0] };
	if (change?.log && !hasLog(next, change.log)) next = appendLogLine(next, date, change.log);

	const owned = { ...carry.owned };
	if (change) {
		if (change.own) owned[change.id] = rawOf(next, change.id)!;
		else delete owned[change.id];
	}
	const changed = changedSpecs(carry.baseline, text);
	for (const ticket of ticketsLinkedTo(parseTicketList(next), changed)) {
		if (ticket.status !== "done") continue;
		const specs = changed.filter((spec) => ticket.specs.includes(spec) || ticket.specs.includes("all"));
		next = setTicketStatus(next, ticket.id, "pending", `reopened: ${specs.join(", ")} changed`);
		delete owned[ticket.id];
	}
	if (next !== text) writeFileAtomic(docPath, next);
	return { text: next, owned, baseline: next };
}

function createLoopTask(ticketTask: ReturnType<typeof createTicketTask>) {
	return defineTask<LoopInput, LoopState, LoopResult>({
		name: LOOP_TASK,
		version: 1,
		initial: () => ({ phase: "pick", first: true, owned: {}, baseline: "", failed: [] }),
		phases: {
			pick: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const date = new Date(runtime.now()).toISOString().slice(0, 10);
				const fail = (message: string, errors: string[] = []) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message, detail: { errors } } } }), context);
				const end = (result: LoopResult) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);

				let text: string;
				try {
					text = readFileSync(task.input.docPath, "utf8");
				} catch (error) {
					return fail(`cannot read ${task.input.docPath}: ${(error as Error).message}`);
				}
				if (state.first) {
					const errors = validateDoc(text);
					if (errors.length > 0) return fail(errors.join("\n"), errors);
				}
				const carry: Carry = { owned: state.owned, baseline: state.first ? text : state.baseline, failed: state.failed };
				const written = writeBack(task.input.docPath, carry, undefined, date);
				if ("conflict" in written) return end({ status: "paused", reason: `doc edited: ${written.conflict}` });

				const list = parseTicketList(written.text);
				const ready = readyTickets(list)[0];
				if (ready) {
					await runtime.commit(() => ({ status: "running", checkpoint: { phase: "launch", ticketId: ready.id, owned: written.owned, baseline: written.baseline, failed: state.failed } }), context);
					return;
				}
				const open = list.tickets.filter((ticket) => ticket.status !== "done" && ticket.status !== "dropped");
				if (open.length === 0) return end({ status: "done", tickets: list.tickets.map((ticket) => ({ id: ticket.id, status: ticket.status ?? "pending" })) });
				return end({ status: "stalled", waiting: [...new Set(open.map((ticket) => ticket.id))] });
			},

			// Marks the ticket in_progress and creates its child. A separate phase so a rerun after the doc write finds the
			// ticket already marked instead of mistaking it for a user edit.
			launch: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const date = new Date(runtime.now()).toISOString().slice(0, 10);
				const model = (await runtime.agent(context)).model;
				const backToPick = (carry: Carry) => runtime.commit(() => ({ status: "running", checkpoint: { phase: "pick", first: false, ...carry } }), context);
				if (!model) {
					return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "the loop's conversation has no model configured" } } }), context);
				}

				const current = parseTicketList(readFileSync(task.input.docPath, "utf8")).tickets.find((ticket) => ticket.id === state.ticketId);
				if (!current || (current.status !== "pending" && current.status !== "in_progress")) return backToPick(state); // the user changed it since the pick
				const written = writeBack(task.input.docPath, state, { id: current.id, status: "in_progress", note: "", own: true }, date);
				if ("conflict" in written) {
					return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "paused", reason: `doc edited: ${written.conflict}` } } }), context);
				}
				const done = current.done ?? "";
				const input: TicketInput = {
					docPath: task.input.docPath,
					cwd: task.input.cwd,
					ticketId: current.id,
					title: current.title,
					done,
					specs: current.specs,
					maxAttempts: task.input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
					model,
				};
				await runtime.commit(async (tx) => {
					const childId = await tx.createTask(ticketTask, input, { ownership: { kind: "task", taskId: task.id } });
					return {
						status: "waiting",
						checkpoint: { phase: "record", ticketId: current.id, childId, done, owned: written.owned, baseline: written.baseline, failed: state.failed },
						on: [childId],
						policy: "allSettled",
					};
				}, context);
			},

			record: async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const date = new Date(runtime.now()).toISOString().slice(0, 10);
				const [outcome] = await runtime.outcomes([state.childId as TaskId<TicketResult>], context);
				let change: Change;
				if (outcome.status === "completed") {
					const sha = outcome.result.commit.slice(0, 7);
					change = { id: state.ticketId, status: "done", note: `${sha} (${state.done} passed)`, log: `${state.ticketId} done ${sha} (${state.done} passed)`, own: true };
				} else {
					const reason = outcome.status === "failed" ? outcome.error.message : `ticket run ${outcome.status}${"reason" in outcome && outcome.reason ? `: ${outcome.reason}` : ""}`;
					const tail = outcome.status === "failed" ? (outcome.error.detail as { outputTail?: string } | undefined)?.outputTail : undefined;
					const lastLine = tail ? oneLine(tail.split("\n").filter(Boolean).at(-1) ?? "").slice(0, 120) : "";
					change = { id: state.ticketId, status: "blocked", note: `needs you: ${reason}`, log: `${state.ticketId} blocked: needs you: ${reason}${lastLine ? ` — ${lastLine}` : ""}`, own: false };
				}
				const written = writeBack(task.input.docPath, state, change, date);
				if ("conflict" in written) {
					return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "paused", reason: `doc edited: ${written.conflict}` } } }), context);
				}
				const failed = outcome.status === "completed" ? [] : [...state.failed, state.ticketId];
				if (failed.length >= PAUSE_AFTER_FAILURES) {
					const reason = `two consecutive tickets failed: ${failed.join(", ")}`;
					return runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { status: "paused", reason } } }), context);
				}
				await runtime.commit(() => ({ status: "running", checkpoint: { phase: "pick", first: false, owned: written.owned, baseline: written.baseline, failed } }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

export interface Tasks {
	loop: ReturnType<typeof createLoopTask>;
	ticket: ReturnType<typeof createTicketTask>;
}

/** The two tasks over `deps` (default: real shell and git), the worker definition (default: assets/agents/brigadev-worker.md), and the tools the worker gets besides CodingTools. */
export function createTasks(deps: TicketDeps = defaultDeps, worker: Worker = loadWorker(), extraTools: readonly ToolRegistration[] = []): Tasks {
	const ticket = createTicketTask(deps, worker, extraTools);
	return { loop: createLoopTask(ticket), ticket };
}
