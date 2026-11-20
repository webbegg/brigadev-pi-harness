// Opens the Harness for one repo: registry (CodingTools, the guard hook, the check and ask tools, the ticket tasks), a Node environment on each conversation's cwd,
// and helpers to start a loop for a feature doc (once per doc path), see where it is, hand it a signal, and wait for its outcome.
//
// Scheduling is opt-in: opening a runner runs nothing. `start()` and `wait()` enable it (so does `harness.resume()`); `deliver()`, `find()`, and
// `status()` never do, which is what lets `brigadev-runner answer|pause|resume` hand a signal over from a short-lived process.
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import type { HarnessSettings, ModelRef, Report, SetTimer, SignalResult, SignalToken, Storage, TaskId, Tx } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCheckTool } from "./check-tool.ts";
import { createAskTool } from "./decision.ts";
import { guardExtension } from "./guard.ts";
import { decisionKey, deliver } from "./signals.ts";
import { createTasks, defaultDeps, LOOP_TASK, type LoopInput, type LoopResult, type LoopState, type OpenDecision, type TicketDeps } from "./tasks.ts";
import type { Worker } from "./worker.ts";

export interface RunnerOptions {
	storage: Storage;
	models: Models;
	/** The repo (worktree) the worker edits and commits in. */
	cwd: string;
	/** The model the loop and its workers run with. */
	model: ModelRef;
	/** Shell and git effects of the ticket task; tests pass their own. */
	deps?: TicketDeps;
	worker?: Worker;
	/** pi-durable run policy (retry, progress intervals, ...); defaults otherwise. */
	settings?: HarnessSettings;
	context?: Context;
	onReport?: (report: Report) => void;
	/** The Harness clock and timers (sleep deadlines are stored on this clock); tests pass a manual one. */
	now?: () => number;
	setTimer?: SetTimer;
	/** Open for reading only (`status`): nothing is recovered, written, or scheduled. The storage must be opened read-only too where it has such an option. */
	readOnly?: boolean;
}

export type LoopOutcome =
	| { status: "completed"; result: LoopResult }
	| { status: "failed"; error: { message: string; detail?: unknown } }
	| { status: "aborted" | "orphaned" | "faulted"; reason?: string; error?: { message: string } };

/** What `settle()` returns while the loop is parked: asleep on a person (open decisions) or on `resume` (`paused`), with nothing left to run in this process. */
export type Waiting = { status: "waiting"; paused?: string; decisions: string[] };

/** Where a loop is, read from its task record. `paused` and `decisions` come from the checkpoint; a finished loop has neither. */
export interface LoopStatus {
	taskId: TaskId<LoopResult>;
	docPath: string;
	state: "running" | "sleeping" | "paused" | "done" | "stalled" | "failed" | "aborted";
	/** Why it is paused, why it failed, or what it is waiting on. */
	reason?: string;
	/** The ticket IDs a stalled loop waits on. */
	waiting?: string[];
	/** Open decisions, with their options, deadlines, and keys. */
	decisions: OpenDecision[];
	/** The latest decision key per ticket, answered or not (a late answer to it is a final `duplicate` or `closed`). */
	lastKeys: Record<string, string>;
	/** `pause-<epoch>` is the key of the next pause request. */
	epoch: number;
	/** The key `resume` is delivered under while paused. */
	resumeKey?: string;
}

export interface Runner {
	harness: Harness;
	/** The resolved repo directory workers run in. */
	cwd: string;
	/** Start the loop for a doc. Idempotent per doc path: a second call returns the same task, also after a restart. Enables scheduling. */
	start(docPath: string, options?: { maxAttempts?: number }): Promise<TaskId<LoopResult>>;
	/** The loop already started for a doc, or undefined. Starts nothing. */
	find(docPath: string): Promise<TaskId<LoopResult> | undefined>;
	/** Wait for the loop's outcome. Enables scheduling, so after a reopen this also resumes interrupted work. Does not return for a loop that sleeps: see `settle`. */
	wait(taskId: TaskId<LoopResult>): Promise<LoopOutcome>;
	/**
	 * Wait until the loop ends (its outcome) or parks: asleep on a decision or a pause with nothing runnable in this process, so the process
	 * could exit and the loop would continue from storage. Does not enable scheduling: call `start()` first.
	 */
	settle(taskId: TaskId<LoopResult>): Promise<LoopOutcome | Waiting>;
	status(taskId: TaskId<LoopResult>): Promise<LoopStatus>;
	/** Deliver a signal to the loop in one commit, without scheduling anything. */
	deliver<T>(taskId: TaskId<LoopResult>, token: SignalToken<T>, key: string, value: T): Promise<SignalResult>;
	close(): Promise<void>;
}

const POLL_MS = 20;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function openRunner(options: RunnerOptions): Promise<Runner> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const cwd = resolve(options.cwd);
	const checkTool = createCheckTool({ cwd });
	const askTool = createAskTool();
	const { loop, ticket } = createTasks(options.deps ?? defaultDeps, options.worker, [checkTool, askTool]);
	const registry = createRegistry();
	registry.install(CodingTools);
	// S5: every tool call of a worker conversation (nested ones too) goes through the brigadev guard rules.
	registry.install(guardExtension({ cwd }));
	registry.install(defineExtension({ name: "brigadev-check", tools: [checkTool] }));
	registry.install(defineExtension({ name: "brigadev-decision", tools: [askTool] }));
	registry.install(defineExtension({ name: "brigadev-runner", tasks: [loop, ticket] }));

	const harness = await Harness.open(
		options.storage,
		{
			models: options.models,
			registry,
			settings: options.settings,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
			onReport: options.onReport,
			...(options.now ? { now: options.now } : {}),
			...(options.setTimer ? { setTimer: options.setTimer } : {}),
			...(options.readOnly ? { readOnly: true } : {}),
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: options.model, cwd } });

	/** One loop per doc path: look through every loop task, live or ended. */
	const findIn = async (tx: Tx, path: string): Promise<TaskId<LoopResult> | undefined> => {
		let cursor: Awaited<ReturnType<typeof tx.scanTasks>>["next"];
		do {
			const page = await tx.scanTasks({ kind: LOOP_TASK }, 100, cursor);
			const found = page.items.find((record) => (record.input as LoopInput).docPath === path);
			if (found) return found.id as TaskId<LoopResult>;
			cursor = page.next;
		} while (cursor);
		return undefined;
	};

	const outcomeOf = (outcome: { status: string } & Record<string, unknown>): LoopOutcome => {
		if (outcome.status === "completed") return { status: "completed", result: outcome.result as LoopResult };
		if (outcome.status === "failed") return { status: "failed", error: outcome.error as { message: string } };
		return outcome as LoopOutcome;
	};

	const runner: Runner = {
		harness,
		cwd,
		async start(docPath, startOptions = {}) {
			const path = resolve(docPath);
			const input: LoopInput = { docPath: path, cwd, ...(startOptions.maxAttempts === undefined ? {} : { maxAttempts: startOptions.maxAttempts }) };
			const taskId = await root.commit(async (tx) => (await findIn(tx, path)) ?? tx.createTask(loop, input, { ownership: { kind: "conversation" } }), context);
			// Committing a task does not start the scheduler; do it here so the loop runs without anyone waiting on it.
			harness.resume();
			return taskId;
		},
		// A plain storage read: no commit, so it also works on a read-only Harness.
		async find(docPath) {
			const path = resolve(docPath);
			let cursor: Awaited<ReturnType<Storage["scanTasks"]>>["next"];
			do {
				const page = await options.storage.scanTasks({ kind: LOOP_TASK }, 100, cursor, context);
				const found = page.items.find((record) => (record.input as LoopInput).docPath === path);
				if (found) return found.id as TaskId<LoopResult>;
				cursor = page.next;
			} while (cursor);
			return undefined;
		},
		async wait(taskId) {
			const settled = await harness.waitForTask(taskId, context);
			return outcomeOf(settled.state.outcome as never);
		},
		async settle(taskId) {
			let quiet = 0;
			for (;;) {
				const record = await harness.getTask(taskId, context);
				if (!record) throw new Error(`no such task ${taskId}`);
				if (record.state.status === "terminal") return outcomeOf(record.state.outcome as never);
				// Asleep, and nothing in this process can run now: parked. Twice in a row, so a hand-over between phases is not mistaken for it.
				if (record.state.status === "sleeping" && !harness.wake().active) quiet += 1;
				else quiet = 0;
				if (quiet >= 2) {
					const current = await runner.status(taskId);
					return { status: "waiting", ...(current.state === "paused" ? { paused: current.reason } : {}), decisions: current.decisions.map((decision) => decision.ticketId) };
				}
				await sleep(POLL_MS);
			}
		},
		async status(taskId) {
			const record = await harness.getTask(taskId, context);
			if (!record) throw new Error(`no such task ${taskId}`);
			const docPath = (record.input as LoopInput).docPath;
			const base = { taskId, docPath, decisions: [] as OpenDecision[], lastKeys: {} as Record<string, string>, epoch: 0 };
			if (record.state.status === "terminal" || record.state.status === "completing") {
				const outcome = outcomeOf(record.state.outcome as never);
				if (outcome.status === "completed") {
					return outcome.result.status === "done" ? { ...base, state: "done" } : { ...base, state: "stalled", waiting: outcome.result.waiting };
				}
				if (outcome.status === "failed") return { ...base, state: "failed", reason: outcome.error.message };
				return { ...base, state: "aborted" };
			}
			const checkpoint = record.state.checkpoint as LoopState;
			const working = checkpoint.phase === "resume" ? checkpoint.next : checkpoint;
			const carried = {
				decisions: working.decisions ?? [],
				lastKeys: Object.fromEntries(Object.entries(working.rounds ?? {}).map(([id, round]) => [id, decisionKey(id, round)])),
				epoch: working.epoch ?? 0,
			};
			if (checkpoint.phase === "resume") return { ...base, ...carried, state: "paused", reason: checkpoint.reason, resumeKey: checkpoint.key };
			return { ...base, ...carried, state: record.state.status === "sleeping" ? "sleeping" : "running" };
		},
		deliver: (taskId, token, key, value) => deliver(harness, taskId, token, key, value, context),
		close: () => harness.close(context),
	};
	return runner;
}
