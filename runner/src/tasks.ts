// The two durable tasks: `brigadev.ticket-loop` (pick → launch → record, ticket by ticket; parks on decisions and pauses) and
// `brigadev.ticket` (one ticket: a worker conversation per attempt, then the done check). Both only commit state; the doc is written
// through lib/ticket-list.ts after re-reading it, so a user's edit is never overwritten.
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { configure, defineTask, SubmissionSettled } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ModelRef, TaskId, TaskRuntime, ToolRegistration } from "@earendil-works/pi-durable";
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
import { ApprovalDoc, approves, DecisionDoc, decisionOf, type AnsweredDecision, type Decision } from "./decision.ts";
import { validateDoc } from "./doc.ts";
import { createPrTask, type PrOptions, type PrResult } from "./pr.ts";
import { ANSWER, answerCommand, DECISION_DEADLINE_MS, decisionKey, PAUSE, pauseKey, RESUME, resumeKey } from "./signals.ts";
import { tailOf } from "./tail.ts";
import { loadWorker, workerInput, workerInstructions, type TicketBrief, type Worker } from "./worker.ts";

export { answerCommand, tailOf };

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
	/** What to do, for a ticket with no line in the doc (a PR loop fix ticket): the worker's brief carries it as `## Spec`. */
	spec?: string;
	maxAttempts: number;
	model: ModelRef;
	/** The decision this ticket parked on in an earlier run, with the user's answer: the brief carries it, and an approved command is lifted in the first attempt's conversation only. */
	decision?: AnsweredDecision;
};

export type TicketState = { phase: "start"; attempt: number; failure?: string } | { phase: "check"; attempt: number; key: string; conversationId: string };

/** Finished (`commit`), or the worker asked a question (`decision`): a decision uses no attempt, so `attempts` counts the ones before it. */
export type TicketResult = { commit: string; outputTail: string; attempts: number } | { decision: Decision; attempts: number };

/**
 * Tools the runner can give the worker: the worker's tool list restricted to what pi-durable's CodingTools provides, plus the
 * runner's own tools (`check`, `ask_user_choice`, which the worker's list does not name: the Pi worker has them through extensions).
 */
function workerTools(worker: Worker, extra: readonly ToolRegistration[]) {
	const available = [...(CodingTools.tools ?? []), ...extra] as ToolRegistration[];
	const wanted = worker.tools.length > 0 ? [...worker.tools, ...extra.map((tool) => tool.name)] : available.map((tool) => tool.name);
	return available.filter((tool) => wanted.includes(tool.name));
}

export type TicketTask = ReturnType<typeof createTicketTask>;

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

				const brief: TicketBrief = { ticketId: input.ticketId, title: input.title, specs: input.specs, ...(input.spec ? { spec: input.spec } : {}), done: input.done, docPath: input.docPath, attempt, maxAttempts: input.maxAttempts, failure, decision: input.decision };
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
					// The approval of a decision's command lives on the conversation the guard decides for: durable (it survives a reopen) and scoped
					// to this ticket (only its conversations carry it). Only the first attempt's: the approval is for one run of the command.
					if (attempt === 1 && input.decision?.approved && input.decision.command !== null) (await tx.doc(ApprovalDoc, created.id)).command = input.decision.command;
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
					return { status: "sleeping", signals: [SubmissionSettled.key(key)], checkpoint: { phase: "check", attempt, key, conversationId } };
				}, context);
			},

			check: async (task, runtime, context) => {
				const input = task.input;
				const { attempt, key, conversationId } = task.state.checkpoint;

				// The worker asked a question (`ask_user_choice`): the ticket completes with it instead of running the done check, and the attempt is
				// not used. The question was recorded on the conversation by the tool's own commit, before its run ended.
				const asked = decisionOf(await runtime.snapshot(DecisionDoc, conversationId as never, context));
				if (asked) {
					await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { decision: asked, attempts: attempt - 1 } } }), context);
					return;
				}

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

/** `pr`: when no ticket is left to run, launch the PR loop (final check, verify, push, PR, CI, merge approval, merge). Default false: the loop ends `done`. */
export type LoopInput = { docPath: string; cwd: string; maxAttempts?: number; pr?: boolean };

/** Runner-owned ticket lines as the runner last wrote them (S8). */
type Owned = Record<string, string>;

/** A question a ticket parked on, waiting for `brigadev.answer` under `key`; `until` (ms, Harness clock) is its deadline, fixed when it was asked. */
export type OpenDecision = Decision & { ticketId: string; key: string; round: number; until: number };

/**
 * What the loop carries between phases. `epoch` counts the pauses so far: the pause request key is `pause-<epoch>` and the resume key of the
 * pause entered at that epoch `resume-<epoch>`. `rounds` is the last key round per ticket (a key is never reused), `answers` the answered
 * decisions waiting for their ticket to be launched.
 */
export type Carry = { owned: Owned; baseline: string; failed: string[]; decisions: OpenDecision[]; rounds: Record<string, number>; answers: Record<string, AnsweredDecision>; epoch: number };

type PickState = { phase: "pick"; first: boolean } & Carry;
type LaunchState = { phase: "launch"; ticketId: string } & Carry;
type RecordState = { phase: "record"; ticketId: string; childId: string; done: string } & Carry;
type Working = PickState | LaunchState | RecordState;
/** With every ticket done and `pr` set: launch the PR loop, then wait for it. The PR loop is a child task; it parks and resumes on its own signals. */
type PrLaunchState = { phase: "pr" } & Carry;
type PrRecordState = { phase: "pr-record"; childId: string } & Carry;

export type PauseKind = "user" | "conflict" | "failures";

/** The loop asleep on its resume signal (no deadline); `next` is the state it continues with, its epoch already past this pause. */
export type PausedState = { phase: "resume"; kind: PauseKind; reason: string; key: string; next: Working };

export type LoopState = Working | PausedState | PrLaunchState | PrRecordState;

/**
 * The loop ends `done` (no PR loop), `stalled`, `merged` (the PR loop merged the PR) or `pr-failed` (the PR loop task itself failed or was aborted);
 * a pause, an open decision, and a PR loop's "needs you" are sleeps, not ends.
 */
export type LoopResult =
	| { status: "done"; tickets: Array<{ id: string; status: string }> }
	| { status: "stalled"; waiting: string[] }
	| { status: "merged"; url: string; number: number; tickets: Array<{ id: string; status: string }> }
	| { status: "pr-failed"; reason: string; tickets: Array<{ id: string; status: string }> };

type Change = { id: string; status: TicketStatus; note: string; log?: string; own: boolean };
type WriteBack = { conflict: string } | { text: string; owned: Owned; baseline: string };

const rawOf = (text: string, id: string) => parseTicketList(text).tickets.find((ticket) => ticket.id === id)?.raw;
const hasLog = (text: string, log: string) => text.split("\n").some((line) => line.endsWith(`): ${log}`));
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
/** A question as one doc line: the ticket line's status regex reads the last ` — <status>`, so a dash in the text must not look like one. */
const lineText = (text: string) => oneLine(text).replaceAll(" — ", " - ");

/** A state saved before a field existed reads with its default. */
function withDefaults<T extends Carry>(state: T): T {
	return { ...state, decisions: state.decisions ?? [], rounds: state.rounds ?? {}, answers: state.answers ?? {}, epoch: state.epoch ?? 0 };
}

/**
 * The only way the loop writes the doc. Synchronously: re-read it, refuse when the user edited a runner-owned line,
 * apply `change`, reopen done tickets linked to specs changed since `baseline`, and write atomically.
 */
function writeBack(docPath: string, carry: Pick<Carry, "owned" | "baseline">, change: Change | undefined, date: string): WriteBack {
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

function createLoopTask(ticketTask: TicketTask, prTask: ReturnType<typeof createPrTask>) {
	return defineTask<LoopInput, LoopState, LoopResult>({
		name: LOOP_TASK,
		version: 1,
		initial: () => ({ phase: "pick", first: true, owned: {}, baseline: "", failed: [], decisions: [], rounds: {}, answers: {}, epoch: 0 }),
		phases: {
			pick: async (task, runtime, context) => {
				const state = withDefaults(task.state.checkpoint);
				const date = new Date(runtime.now()).toISOString().slice(0, 10);
				const fail = (message: string, errors: string[] = []) =>
					runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message, detail: { errors } } } }), context);
				const end = (result: LoopResult) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
				const run = (next: Working) => runtime.commit(() => ({ status: "running", checkpoint: next }), context);

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
				let carry: Carry = { owned: state.owned, baseline: state.first ? text : state.baseline, failed: state.failed, decisions: state.decisions, rounds: state.rounds, answers: state.answers, epoch: state.epoch };
				const again: PickState = { phase: "pick", first: false, ...carry };
				const written = writeBack(task.input.docPath, carry, undefined, date);
				if ("conflict" in written) return pause(runtime, context, "conflict", `doc edited: ${written.conflict}`, state);
				carry = { ...carry, owned: written.owned, baseline: written.baseline };

				// A user's pause request (`brigadev-runner pause`) is honored here, at a pick: the ticket that was running has finished.
				const requested = await runtime.readSignal(PAUSE, pauseKey(carry.epoch), context);
				if (requested && "value" in requested) return pause(runtime, context, "user", "paused by user", { ...again, ...carry, first: false });

				const list = parseTicketList(written.text);
				const lineOf = (id: string) => list.tickets.find((ticket) => ticket.id === id);

				// Decisions. A parked ticket whose line the user edited off `blocked` (back to pending, done, dropped, or gone) is theirs again: its
				// decision is dropped, and a ready one is picked below as usual.
				carry = { ...carry, decisions: carry.decisions.filter((decision) => lineOf(decision.ticketId)?.status === "blocked") };
				for (const decision of carry.decisions) {
					const answer = await runtime.readSignal(ANSWER, decision.key, context);
					if (answer && "value" in answer) {
						const rest = carry.decisions.filter((other) => other !== decision);
						const answered: AnsweredDecision = { question: decision.question, options: decision.options, recommended: decision.recommended, command: decision.command, answer: answer.value.choice, approved: approves(decision, answer.value) };
						// The ticket goes back to in_progress when it is launched (a blocked ticket with an answer is launched, not skipped).
						return run({ phase: "launch", ticketId: decision.ticketId, ...carry, decisions: rest, answers: { ...carry.answers, [decision.ticketId]: answered } });
					}
					if (answer && "expired" in answer) {
						if (runtime.now() < decision.until) {
							// The key was expired by another question's earlier deadline (one sleep has one `until`): same question and deadline, a new key.
							const round = (carry.rounds[decision.ticketId] ?? 0) + 1;
							const renewed = { ...decision, round, key: decisionKey(decision.ticketId, round) };
							return run({ ...again, ...carry, first: false, rounds: { ...carry.rounds, [decision.ticketId]: round }, decisions: carry.decisions.map((other) => (other === decision ? renewed : other)) });
						}
						const change: Change = { id: decision.ticketId, status: "blocked", note: "needs you: no answer within 24 h", log: `${decision.ticketId} blocked: needs you: no answer within 24 h`, own: false };
						const expired = writeBack(task.input.docPath, carry, change, date);
						if ("conflict" in expired) return pause(runtime, context, "conflict", `doc edited: ${expired.conflict}`, { ...again, ...carry, first: false });
						return run({ ...again, ...carry, first: false, owned: expired.owned, baseline: expired.baseline, decisions: carry.decisions.filter((other) => other !== decision) });
					}
				}

				const ready = readyTickets(list)[0];
				if (ready) return run({ phase: "launch", ticketId: ready.id, ...carry });

				// Nothing to run. With a question open, sleep on every open question's key until the earliest deadline; no `stalled` ending while a person
				// may still answer. A past deadline wakes at once: its key expires, and the next pick turns it into `no answer within 24 h`.
				if (carry.decisions.length > 0) {
					const signals = carry.decisions.map((decision) => ANSWER.key(decision.key));
					const until = Math.min(...carry.decisions.map((decision) => decision.until));
					return runtime.commit(() => ({ status: "sleeping", signals, until, checkpoint: { phase: "pick", first: false, ...carry } }), context);
				}
				const open = list.tickets.filter((ticket) => ticket.status !== "done" && ticket.status !== "dropped");
				// Every ticket is done or dropped and nothing is parked: the PR loop is the last phase.
				if (open.length === 0 && task.input.pr) return run({ phase: "pr", ...carry });
				if (open.length === 0) return end({ status: "done", tickets: list.tickets.map((ticket) => ({ id: ticket.id, status: ticket.status ?? "pending" })) });
				return end({ status: "stalled", waiting: [...new Set(open.map((ticket) => ticket.id))] });
			},

			// Marks the ticket in_progress and creates its child. A separate phase so a rerun after the doc write finds the
			// ticket already marked instead of mistaking it for a user edit.
			launch: async (task, runtime, context) => {
				const state = withDefaults(task.state.checkpoint);
				const date = new Date(runtime.now()).toISOString().slice(0, 10);
				const model = (await runtime.agent(context)).model;
				const backToPick = (carry: Carry) => runtime.commit(() => ({ status: "running", checkpoint: { phase: "pick", first: false, ...carry } }), context);
				if (!model) {
					return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "the loop's conversation has no model configured" } } }), context);
				}

				const current = parseTicketList(readFileSync(task.input.docPath, "utf8")).tickets.find((ticket) => ticket.id === state.ticketId);
				const answered = state.answers[state.ticketId];
				// A parked ticket (blocked) is launched only with its answer; otherwise the user changed it since the pick.
				const launchable = current && (current.status === "pending" || current.status === "in_progress" || (current.status === "blocked" && answered !== undefined));
				if (!launchable) return backToPick({ ...state, answers: Object.fromEntries(Object.entries(state.answers).filter(([id]) => id !== state.ticketId)) });
				const change: Change = { id: current.id, status: "in_progress", note: "", own: true, ...(answered ? { log: `${current.id} answered: ${lineText(answered.answer)}` } : {}) };
				const written = writeBack(task.input.docPath, state, change, date);
				if ("conflict" in written) return pause(runtime, context, "conflict", `doc edited: ${written.conflict}`, state);
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
					...(answered ? { decision: answered } : {}),
				};
				const answers = Object.fromEntries(Object.entries(state.answers).filter(([id]) => id !== current.id));
				await runtime.commit(async (tx) => {
					const childId = await tx.createTask(ticketTask, input, { ownership: { kind: "task", taskId: task.id } });
					return {
						status: "waiting",
						checkpoint: { phase: "record", ticketId: current.id, childId, done, owned: written.owned, baseline: written.baseline, failed: state.failed, decisions: state.decisions, rounds: state.rounds, answers, epoch: state.epoch },
						on: [childId],
						policy: "allSettled",
					};
				}, context);
			},

			record: async (task, runtime, context) => {
				const state = withDefaults(task.state.checkpoint);
				const date = new Date(runtime.now()).toISOString().slice(0, 10);
				const [outcome] = await runtime.outcomes([state.childId as TaskId<TicketResult>], context);
				const carryOf = (written: { owned: Owned; baseline: string }, extra: Partial<Carry> = {}): PickState => ({
					phase: "pick",
					first: false,
					owned: written.owned,
					baseline: written.baseline,
					failed: state.failed,
					decisions: state.decisions,
					rounds: state.rounds,
					answers: state.answers,
					epoch: state.epoch,
					...extra,
				});

				// The worker asked a question: park the ticket and remember the question under a key of its own. A decision is not a failure.
				if (outcome.status === "completed" && "decision" in outcome.result) {
					const asked = outcome.result.decision;
					const round = (state.rounds[state.ticketId] ?? 0) + 1;
					const key = decisionKey(state.ticketId, round);
					// One deadline per question, memoized: a rerun of this phase after a crash finds the same one.
					const until = await runtime.memo<number>(`until.${key}`, runtime.now() + DECISION_DEADLINE_MS, context);
					const question = lineText(asked.question);
					const change: Change = {
						id: state.ticketId,
						status: "blocked",
						note: `needs you: decision: ${question} (answer: ${answerCommand(task.input.docPath, state.ticketId)})`,
						log: `${state.ticketId} blocked: needs you: decision: ${question}`,
						own: false,
					};
					const written = writeBack(task.input.docPath, state, change, date);
					if ("conflict" in written) return pause(runtime, context, "conflict", `doc edited: ${written.conflict}`, state);
					const open: OpenDecision = { ...asked, ticketId: state.ticketId, key, round, until };
					return runtime.commit(
						() => ({ status: "running", checkpoint: carryOf(written, { decisions: [...state.decisions.filter((decision) => decision.ticketId !== state.ticketId), open], rounds: { ...state.rounds, [state.ticketId]: round } }) }),
						context,
					);
				}

				let change: Change;
				if (outcome.status === "completed") {
					const sha = ("commit" in outcome.result ? outcome.result.commit : "").slice(0, 7);
					change = { id: state.ticketId, status: "done", note: `${sha} (${state.done} passed)`, log: `${state.ticketId} done ${sha} (${state.done} passed)`, own: true };
				} else {
					const reason = outcome.status === "failed" ? outcome.error.message : `ticket run ${outcome.status}${"reason" in outcome && outcome.reason ? `: ${outcome.reason}` : ""}`;
					const tail = outcome.status === "failed" ? (outcome.error.detail as { outputTail?: string } | undefined)?.outputTail : undefined;
					const lastLine = tail ? oneLine(tail.split("\n").filter(Boolean).at(-1) ?? "").slice(0, 120) : "";
					change = { id: state.ticketId, status: "blocked", note: `needs you: ${reason}`, log: `${state.ticketId} blocked: needs you: ${reason}${lastLine ? ` — ${lastLine}` : ""}`, own: false };
				}
				const written = writeBack(task.input.docPath, state, change, date);
				if ("conflict" in written) return pause(runtime, context, "conflict", `doc edited: ${written.conflict}`, state);
				const failed = outcome.status === "completed" ? [] : [...state.failed, state.ticketId];
				if (failed.length >= PAUSE_AFTER_FAILURES) {
					// The loop sleeps instead of ending; `resume` starts the count again.
					return pause(runtime, context, "failures", `two consecutive tickets failed: ${failed.join(", ")}`, carryOf(written, { failed: [] }));
				}
				await runtime.commit(() => ({ status: "running", checkpoint: carryOf(written, { failed }) }), context);
			},

			// Every ticket is done: create the PR loop child and wait for it. One commit creates the child and records its id, so a crash never
			// launches a second one: after a reopen this phase is not rerun, `pr-record` is.
			pr: async (task, runtime, context) => {
				const state = withDefaults(task.state.checkpoint);
				const model = (await runtime.agent(context)).model;
				if (!model) return runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message: "the loop's conversation has no model configured" } } }), context);
				await runtime.commit(async (tx) => {
					const childId = await tx.createTask(prTask, { docPath: task.input.docPath, cwd: task.input.cwd, model }, { ownership: { kind: "task", taskId: task.id } });
					return { status: "waiting", checkpoint: { phase: "pr-record", childId, owned: state.owned, baseline: state.baseline, failed: state.failed, decisions: state.decisions, rounds: state.rounds, answers: state.answers, epoch: state.epoch }, on: [childId], policy: "allSettled" };
				}, context);
			},

			// The PR loop ended: fold its outcome into the loop's.
			"pr-record": async (task, runtime, context) => {
				const state = withDefaults(task.state.checkpoint);
				const [outcome] = await runtime.outcomes([state.childId as TaskId<PrResult>], context);
				const tickets = parseTicketList(readFileSync(task.input.docPath, "utf8")).tickets.map((ticket) => ({ id: ticket.id, status: ticket.status ?? "pending" }));
				const result: LoopResult =
					outcome.status === "completed"
						? { status: "merged", url: outcome.result.url, number: outcome.result.number, tickets }
						: { status: "pr-failed", reason: outcome.status === "failed" ? outcome.error.message : `PR loop ${outcome.status}`, tickets };
				await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
			},

			// After a pause: `resume` was delivered. Continue with the state saved at the pause; a conflict is checked again by that phase.
			resume: async (task, runtime, context) => {
				const { next } = task.state.checkpoint;
				await runtime.commit(() => ({ status: "running", checkpoint: next }), context);
			},
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}

/**
 * Park the loop (A4): sleep on the `resume-<epoch>` key with no deadline, so the process may exit. `next` is the state to continue with; its
 * epoch moves past this pause, so the pause and resume keys of the next pause are new ones (a key serves one wait).
 */
function pause(runtime: TaskRuntime<LoopInput, LoopState, LoopResult, object>, context: Context, kind: PauseKind, reason: string, next: Working) {
	const key = resumeKey(next.epoch);
	return runtime.commit(() => ({ status: "sleeping", signals: [RESUME.key(key)], checkpoint: { phase: "resume", kind, reason, key, next: { ...next, epoch: next.epoch + 1 } } }), context);
}

export interface Tasks {
	loop: ReturnType<typeof createLoopTask>;
	ticket: TicketTask;
	pr: ReturnType<typeof createPrTask>;
}

/**
 * The three tasks over `deps` (default: real shell and git), the worker definition (default: assets/agents/brigadev-worker.md), and the tools the
 * worker gets besides CodingTools. `prOptions`: the PR loop's git/gh/suite seam, verifier prompt, and the verdict tool (default: real ones).
 */
export function createTasks(deps: TicketDeps = defaultDeps, worker: Worker = loadWorker(), extraTools: readonly ToolRegistration[] = [], prOptions: PrOptions = {}): Tasks {
	const ticket = createTicketTask(deps, worker, extraTools);
	const pr = createPrTask(ticket, prOptions);
	return { loop: createLoopTask(ticket, pr), ticket, pr };
}
