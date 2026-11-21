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
import { canonicalPath } from "../../lib/paths.ts";
import { readSettings } from "../../lib/runtime.ts";
import { createCheckTool } from "./check-tool.ts";
import { createContainment } from "./contain.ts";
import { createAskTool } from "./decision.ts";
import { LoopStartedDifferently } from "./errors.ts";
import { guardExtension } from "./guard.ts";
import { PR_TASK, prPhaseLabel, type PrDeps, type PrState } from "./pr.ts";
import { decisionKey, deliver } from "./signals.ts";
import { createTasks, defaultDeps, LOOP_TASK, TICKET_TASK, type LoopInput, type LoopResult, type LoopState, type OpenDecision, type TicketDeps, type TicketInput, type TicketResult, type TicketState } from "./tasks.ts";
import { doneTimeoutMs } from "./shell.ts";
import { createVerdictTool, type Verifier } from "./verify.ts";
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
	/** git, gh, and the suite of the PR loop; tests pass a fake `gh` and a real git against a local remote. */
	prDeps?: PrDeps;
	worker?: Worker;
	/** The verify conversation's prompt (default: assets/agents/brigadev-verify.md). */
	verifier?: Verifier;
	/** pi-durable run policy (retry, progress intervals, ...); defaults otherwise. */
	settings?: HarnessSettings;
	context?: Context;
	onReport?: (report: Report) => void;
	/** The Harness clock and timers (sleep deadlines are stored on this clock); tests pass a manual one. */
	now?: () => number;
	setTimer?: SetTimer;
	/** Open for reading only (`status`): nothing is recovered, written, or scheduled. The storage must be opened read-only too where it has such an option. */
	readOnly?: boolean;
	/** The environment the agent's processes are derived from (default `process.env`): the contained environment removes its credentials (src/contain.ts). */
	env?: NodeJS.ProcessEnv;
}

export type LoopOutcome =
	| { status: "completed"; result: LoopResult }
	| { status: "failed"; error: { message: string; detail?: unknown } }
	| { status: "aborted" | "orphaned" | "faulted"; reason?: string; error?: { message: string } };

/**
 * What `settle()` returns while the loop is parked: asleep on a person (open decisions, a merge approval, a PR loop stop) or on `resume` (`paused`), with
 * nothing left to run in this process. `pr` is set while the PR loop is the one parked. A CI wait is not parked: its poll is a timer of this process.
 */
export type Waiting = { status: "waiting"; paused?: string; decisions: string[]; pr?: { phase: string; url?: string; reason?: string } };

/** The PR loop child, as `status` shows it. */
export interface PrStatus {
	taskId: TaskId;
	/** final-check, verify, push, open, wait-ci, `fix <n>`, wait-merge, needs-you. */
	phase: string;
	/** The task is asleep (a poll timer, a signal wait), not between phases. */
	asleep: boolean;
	url?: string;
	number?: number;
	/** The commit the branch was last pushed at: what a merge approval is for. */
	sha?: string;
	/** Why it stopped (phase needs-you). */
	reason?: string;
	/** The open decision of a fix ticket, answered with `answer` like a ticket's. */
	decisions: OpenDecision[];
	lastKeys: Record<string, string>;
	/** The key `resume` is delivered under while the PR loop waits in needs-you. */
	resumeKey?: string;
	/** The key `merge` is delivered under while the PR loop waits for the merge approval. */
	mergeKey?: string;
	/** The last PR comment that could not be posted. */
	warning?: string;
}

/**
 * One ticket's latest worker run, as the board shows it (`ticketRuns`): live or how it ended, its attempts, and the worker's most recent tool calls read from its
 * conversation in the store. A ticket that ran again (after a decision, or a `resume`) shows its latest run. `FIX-n` tickets of the PR loop are included.
 */
export interface TicketRun {
	ticketId: string;
	taskId: TaskId;
	/** The task has not ended: the worker runs, or the ticket waits for its done check. */
	live: boolean;
	/** How the run ended; absent while live. */
	end?: "commit" | "decision" | "integrity" | "failed" | "aborted";
	/** The attempt in progress while live; the attempts used when it ended. */
	attempts: number;
	maxAttempts: number;
	commit?: string;
	/** The failure message of a failed run. */
	failure?: string;
	/** The end of the failing done check's output. */
	outputTail?: string;
	startedAt?: number;
	endedAt?: number;
	/** The worker's last tool calls, oldest first, with their raw arguments (the caller summarizes and redacts them). */
	steps: Array<{ tool: string; args: unknown }>;
}

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
	/** The PR loop, while it runs. */
	pr?: PrStatus;
	/** What the user asked when the loop was first started (the stored input): `start` cannot change it. */
	started?: { pr: boolean; cwd: string };
	/** The merged PR, once the loop ended `merged`. */
	merged?: { url: string; number: number };
}

export interface Runner {
	harness: Harness;
	/** The resolved repo directory workers run in. */
	cwd: string;
	/** Start the loop for a doc. Idempotent per doc path: a second call returns the same task, also after a restart. Enables scheduling. */
	start(docPath: string, options?: { maxAttempts?: number; pr?: boolean }): Promise<TaskId<LoopResult>>;
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
	/** Every ticket the loop (and its PR loop) ran, newest run per ticket, from storage reads only: it works on any open Runner and commits nothing. */
	ticketRuns(taskId: TaskId<LoopResult>): Promise<TicketRun[]>;
	/** Deliver a signal to the loop (or to its PR loop child: `status().pr.taskId`) in one commit, without scheduling anything. */
	deliver<T>(taskId: TaskId, token: SignalToken<T>, key: string, value: T): Promise<SignalResult>;
	close(): Promise<void>;
}

export { LoopStartedDifferently };

const SETTLE_POLL_MS = 20;
/** How many of a worker conversation's newest entries are read for its recent tool calls, and how many calls are kept. */
const STEP_WINDOW_ENTRIES = 60;
const STEPS_KEPT = 8;
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

export async function openRunner(options: RunnerOptions): Promise<Runner> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const cwd = resolve(options.cwd);
	// B1: the credentials stay with the runner. Everything that runs the agent's code gets this environment; the PR loop's own git/gh calls do not.
	const containment = createContainment(options.env ?? process.env, { create: options.readOnly !== true });
	// B2: the brigadev settings (`check.test`, the permission mode, the risk globs) are read once; a worker that rewrites brigadev.json changes nothing for this runner.
	const pinned = readSettings();
	const settings = () => pinned;
	const shell = { env: containment.env, timeoutMs: doneTimeoutMs(pinned) };
	const checkTool = createCheckTool({ cwd, settings, shellEnv: containment.env, maxTimeoutMs: shell.timeoutMs });
	const askTool = createAskTool();
	const verdictTool = createVerdictTool();
	const { loop, ticket, pr } = createTasks(options.deps ?? defaultDeps, options.worker, [checkTool, askTool], { deps: options.prDeps, verifier: options.verifier, verdictTool, settings: pinned, shell }, shell);
	const registry = createRegistry();
	registry.install(CodingTools);
	// S5: every tool call of a worker conversation (nested ones too) goes through the brigadev guard rules.
	registry.install(guardExtension({ cwd, settings }));
	registry.install(defineExtension({ name: "brigadev-check", tools: [checkTool] }));
	registry.install(defineExtension({ name: "brigadev-decision", tools: [askTool] }));
	registry.install(defineExtension({ name: "brigadev-verify", tools: [verdictTool] }));
	registry.install(defineExtension({ name: "brigadev-runner", tasks: [loop, ticket, pr] }));

	const harness = await Harness.open(
		options.storage,
		{
			models: options.models,
			registry,
			settings: options.settings,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd, shellEnv: containment.env }),
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

	/** The PR loop child of a loop that waits for it; undefined once it ended (the loop folds its outcome next). */
	const prStatusOf = async (childId: TaskId): Promise<PrStatus | undefined> => {
		const child = await harness.getTask(childId, context);
		if (!child || child.state.status === "terminal" || child.state.status === "completing") return undefined;
		const state = child.state.checkpoint as PrState;
		return {
			taskId: childId,
			phase: prPhaseLabel(state),
			asleep: child.state.status === "sleeping",
			...(state.pr ? { url: state.pr.url, number: state.pr.number } : {}),
			...(state.sha ? { sha: state.sha } : {}),
			...(state.phase === "stop" || state.phase === "resume" ? { reason: state.reason } : {}),
			decisions: state.decision ? [state.decision] : [],
			lastKeys: Object.fromEntries(Object.entries(state.rounds ?? {}).map(([id, round]) => [id, decisionKey(id, round)])),
			...(state.phase === "resume" ? { resumeKey: state.key } : {}),
			...(state.phase === "merge" ? { mergeKey: state.key } : {}),
			...(state.warn ? { warning: state.warn } : {}),
		};
	};

	/** The tool calls of a ticket task's latest worker conversation, from the store: the newest entries only, oldest first. A finished task's are read once. */
	const finishedSteps = new Map<number, TicketRun["steps"]>();
	const stepsOf = async (taskId: TaskId, finished: boolean): Promise<TicketRun["steps"]> => {
		const known = finishedSteps.get(taskId);
		if (finished && known) return known;
		const steps: TicketRun["steps"] = [];
		try {
			const [conversation] = (await options.storage.scanConversations({ ownerTaskId: taskId, order: "descending" }, 1, undefined, context)).items;
			if (conversation) {
				const page = await options.storage.scanEntries({ conversationId: conversation.id, order: "descending" }, STEP_WINDOW_ENTRIES, undefined, context);
				for (const entry of [...page.items].reverse()) {
					const message = entry.model?.[0];
					if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
					for (const part of message.content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
						if (part.type === "toolCall" && typeof part.name === "string") steps.push({ tool: part.name, args: part.arguments });
					}
				}
			}
		} catch {
			// Steps are a nicety of the board: a store that cannot answer shows a card without them.
		}
		const kept = steps.slice(-STEPS_KEPT);
		if (finished) finishedSteps.set(taskId, kept);
		return kept;
	};

	const runner: Runner = {
		harness,
		cwd,
		async start(docPath, startOptions = {}) {
			const path = resolve(docPath);
			const input: LoopInput = { docPath: path, cwd, ...(startOptions.maxAttempts === undefined ? {} : { maxAttempts: startOptions.maxAttempts }), ...(startOptions.pr ? { pr: true } : {}) };
			// B5/R3-002: a loop that exists keeps the input it was started with. Starting it again with the PR loop switched, or from another worktree, would
			// silently do something else than what the user asked for (push and open a PR after `--no-pr`; run the guard in a checkout the commits are not in).
			const existing = await runner.find(path);
			const stored = existing === undefined ? undefined : ((await harness.getTask(existing, context))?.input as LoopInput | undefined);
			if (stored) {
				const storedPr = stored.pr === true;
				if (storedPr !== (input.pr === true)) {
					throw new LoopStartedDifferently(
						`this loop was started ${storedPr ? "with the PR loop" : "with --no-pr (tickets only)"} and that cannot change once it has started. Run \`brigadev-runner start ${path}${storedPr ? "" : " --no-pr"}\` to continue it as it was started.`,
					);
				}
				if (canonicalPath(stored.cwd) !== canonicalPath(cwd)) {
					throw new LoopStartedDifferently(`this loop was started in ${stored.cwd} (its branch and commits are there) and cannot move to ${cwd}. Run \`brigadev-runner start ${path}\` from ${stored.cwd}.`);
				}
			}
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
				// Asleep (or waiting on a child that is), and nothing in this process can run now: parked. Twice in a row, so a hand-over between phases is not mistaken for it.
				if ((record.state.status === "sleeping" || record.state.status === "waiting") && !harness.wake().active) quiet += 1;
				else quiet = 0;
				if (quiet >= 2) {
					const current = await runner.status(taskId);
					// A CI poll is a timer of this process, not a person: keep waiting for it.
					if (current.pr?.phase === "wait-ci") {
						quiet = 0;
					} else {
						const asks = [...current.decisions, ...(current.pr?.decisions ?? [])].map((decision) => decision.ticketId);
						const where = current.pr ? { pr: { phase: current.pr.phase, ...(current.pr.url ? { url: current.pr.url } : {}), ...(current.pr.reason ? { reason: current.pr.reason } : {}) } } : {};
						return { status: "waiting", ...(current.state === "paused" ? { paused: current.reason } : {}), decisions: asks, ...where };
					}
				}
				await sleep(SETTLE_POLL_MS);
			}
		},
		async status(taskId) {
			const record = await harness.getTask(taskId, context);
			if (!record) throw new Error(`no such task ${taskId}`);
			const docPath = (record.input as LoopInput).docPath;
			const started = { pr: (record.input as LoopInput).pr === true, cwd: (record.input as LoopInput).cwd };
			const base = { taskId, docPath, started, decisions: [] as OpenDecision[], lastKeys: {} as Record<string, string>, epoch: 0 };
			if (record.state.status === "terminal" || record.state.status === "completing") {
				const outcome = outcomeOf(record.state.outcome as never);
				if (outcome.status === "completed") {
					const result = outcome.result;
					if (result.status === "merged") return { ...base, state: "done", merged: { url: result.url, number: result.number } };
					if (result.status === "pr-failed") return { ...base, state: "failed", reason: result.reason };
					return result.status === "done" ? { ...base, state: "done" } : { ...base, state: "stalled", waiting: result.waiting };
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
			const pr = checkpoint.phase === "pr-record" ? await prStatusOf(checkpoint.childId as TaskId) : undefined;
			return { ...base, ...carried, ...(pr ? { pr } : {}), state: record.state.status === "sleeping" ? "sleeping" : "running" };
		},
		async ticketRuns(taskId) {
			type Page = Awaited<ReturnType<Storage["scanTasks"]>>;
			type TaskRow = Page["items"][number];
			const scan = async (kind: string, each: (record: TaskRow) => void) => {
				let cursor: Page["next"];
				do {
					const page = await options.storage.scanTasks({ kind }, 100, cursor, context);
					for (const record of page.items) each(record);
					cursor = page.next;
				} while (cursor);
			};
			// A ticket is the loop's child; a PR loop's fix ticket is the PR loop's.
			const owners = new Set<number>([taskId]);
			await scan(PR_TASK, (record) => {
				if (record.owner === taskId) owners.add(record.id);
			});
			const latest = new Map<string, TaskRow>();
			await scan(TICKET_TASK, (record) => {
				if (record.owner !== undefined && owners.has(record.owner)) latest.set((record.input as TicketInput).ticketId, record);
			});
			return Promise.all(
				[...latest.values()].map(async (record): Promise<TicketRun> => {
					const input = record.input as TicketInput;
					const base = { ticketId: input.ticketId, taskId: record.id as TaskId, maxAttempts: input.maxAttempts, ...(record.startedAt === undefined ? {} : { startedAt: record.startedAt }), ...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }) };
					if (record.state.status !== "terminal" && record.state.status !== "completing") {
						const attempt = (record.state.checkpoint as TicketState | undefined)?.attempt ?? 1;
						return { ...base, live: true, attempts: attempt, steps: await stepsOf(record.id as TaskId, false) };
					}
					const outcome = record.state.outcome as { status: string; result?: TicketResult; error?: { message: string; detail?: unknown } };
					const steps = await stepsOf(record.id as TaskId, true);
					if (outcome.status === "completed" && outcome.result) {
						const result = outcome.result;
						if ("commit" in result) return { ...base, live: false, end: "commit", attempts: result.attempts, commit: result.commit, steps };
						return { ...base, live: false, end: "decision" in result ? "decision" : "integrity", attempts: result.attempts, steps };
					}
					if (outcome.status === "failed") {
						const detail = outcome.error?.detail as { attempts?: number; outputTail?: string } | undefined;
						return { ...base, live: false, end: "failed", attempts: detail?.attempts ?? input.maxAttempts, failure: outcome.error?.message, ...(detail?.outputTail ? { outputTail: detail.outputTail } : {}), steps };
					}
					return { ...base, live: false, end: "aborted", attempts: 0, steps };
				}),
			);
		},
		deliver: (taskId, token, key, value) => deliver(harness, taskId, token, key, value, context),
		close: async () => {
			try {
				await harness.close(context);
			} finally {
				containment.dispose();
			}
		},
	};
	return runner;
}
