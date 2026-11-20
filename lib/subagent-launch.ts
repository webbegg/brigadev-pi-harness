// Launch orchestration for the `subagent` tool (always synchronous: the call returns when every task has ended):
// a slot of the process-wide semaphore per task, queued placeholders, one model per task, writer registration,
// and the text the model reads. No Pi imports: the task runner, semaphore, writer registry, card/UI hooks, and
// working-tree snapshot are injected, so tests drive it with fakes.

import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "./agents.ts";
import { failed, finalText, isUnfinished, output, runStatus, USER_CANCEL, type RunResult } from "./run-status.ts";
import { emptyTally } from "./cost.ts";
import { buildChildTask, type ActiveWriter, type LaunchRequest, type SkillRef } from "./delegation.ts";
import type { ResolvedRoute } from "./model-routing.ts";
import type { Semaphore } from "./semaphore.ts";
import { settleQueued } from "./subagent-row.ts";
import { compactResult } from "./result-compaction.ts";
import { diffSnapshots, outsideSurfaces, type Snapshot } from "./worktree-snapshot.ts";

const OUTSIDE_WARNING = "files changed outside the writers' allowed edit surfaces";
const CANCELLED_TEXT = "Cancelled before it started.";

/** A task that never started (aborted while queued) or that the user stopped: neither a success nor a child failure. */
const cancelled = (r: RunResult) => runStatus(r) === "cancelled";

/** What the parent reads of a cancelled task: who stopped it, and whether it had started. */
const cancelledText = (r: RunResult) => (r.cancelledBy === "user" ? `Cancelled by the user${r.startedAt === undefined ? " before it started" : ""}.` : CANCELLED_TEXT);

/**
 * A model that ran out of quota, credit or rate limit. There is no fallback model: the agent's one model
 * failed, and the result says so loudly instead of leaving it to look like an ordinary error.
 */
const LIMIT_FAILURE = /quota exceeded|usage limit|exceeded your (current )?quota|credit balance|insufficient_quota|billing|subscription rate limit|rate.?limit|\b429\b|too many requests/i;

export const limitFailed = (r: Pick<RunResult, "exitCode" | "stopReason" | "errorMessage" | "stderr">): boolean => failed(r) && r.stopReason === "error" && LIMIT_FAILURE.test(r.errorMessage || r.stderr);

export interface Details {
	mode: "single" | "parallel";
	results: RunResult[];
	/** Files the batch changed outside every writer's surfaces (set when writers ran in a git repo). */
	outsideSurfaces?: string[];
}

/** A finished launch as the tool returns it. */
export interface LaunchResult {
	content: Array<{ type: "text"; text: string }>;
	details: Details;
	isError?: boolean;
}

export interface Launched {
	details: Details;
	warnings: string[];
}

export interface LaunchHooks {
	/** Streams partial results to the tool call. */
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: Details }) => void;
}

/**
 * What the parent reads of one task (S12): a structured result as verdicts, blockers and paths, long text as head and tail,
 * and the path of the full result in the run folder. The tool details keep the whole run for the viewer.
 */
export const taskOutput = (r: RunResult): string =>
	compactResult({ structured: !failed(r) ? r.structured : undefined, text: output(r), artifactsDir: r.artifactsDir, notSaved: r.runId !== undefined && r.artifactsDir === undefined });

/** The content the model reads. */
export function toResult(mode: Details["mode"], { details, warnings }: Launched): LaunchResult {
	const warningText = warnings.length ? `\n\nWarnings: ${warnings.join("; ")}` : "";
	if (mode === "single") {
		const r = details.results[0];
		// A task cancelled while queued is an error that says so, not an empty success.
		if (cancelled(r)) return { content: [{ type: "text", text: `Agent cancelled: ${cancelledText(r)}${warningText}` }], details, isError: true };
		return { content: [{ type: "text", text: (failed(r) ? `Agent ${r.stopReason ?? "failed"}: ` : "") + taskOutput(r) + warningText }], details, isError: failed(r) };
	}
	const ok = details.results.filter((r) => !failed(r) && !cancelled(r)).length;
	const sections = details.results.map((r) => (cancelled(r) ? `### [${r.agent}] cancelled\n\n${cancelledText(r)}` : `### [${r.agent}] ${failed(r) ? "failed" : "completed"}\n\n${taskOutput(r)}`));
	return { content: [{ type: "text", text: `Parallel: ${ok}/${details.results.length} succeeded\n\n${sections.join("\n\n---\n\n")}${warningText}` }], details };
}

export interface LaunchTask {
	request: LaunchRequest;
	agent: AgentDefinition;
	route: ResolvedRoute;
	routeLabel: string;
}

/** The run of one task for the task runner. */
export interface AgentCall {
	index: number;
	taskText: string;
	route: ResolvedRoute;
	routeLabel: string;
	signal?: AbortSignal;
	onUpdate: (result: RunResult) => void;
}

/** Card/viewer hooks for one task; the extension keeps the card rows and the live results. */
export interface TaskView {
	/** The task got its slot: count it as running and add its card row. */
	start(index: number, info: { agent: string; task: string; model?: string; thinking?: string; startedAt: number }): void;
	/** A new placeholder was installed for the run (its model and thinking are the run's). */
	attempt(index: number, result: RunResult): void;
	/** The child streamed a partial result. */
	update(index: number, result: RunResult): void;
	/** The task ended (any outcome): settle its row and the running count. */
	finish(index: number, result: RunResult): void;
	/** The task settled without ever starting (the user cancelled it while it waited for a slot): no `start` or `finish` follows. */
	skipped?(index: number, result: RunResult): void;
}

export interface LaunchDeps {
	/** The process-wide concurrency cap. */
	slots: Semaphore;
	/** Runs one task (spawns the child). */
	runAgent: (call: AgentCall) => Promise<RunResult>;
	skills: () => readonly SkillRef[];
	/** The shared list of running writers. */
	writers: {
		add: (writers: ActiveWriter[]) => void;
		remove: (writer: ActiveWriter) => void;
	};
	view: TaskView;
	/** Working-tree snapshot for the writer backstop; undefined without git. */
	snapshot: () => Promise<Snapshot | undefined>;
	now?: () => number;
	newWriterId?: () => string;
}

export interface LaunchInput {
	mode: Details["mode"];
	tasks: LaunchTask[];
	/** Placeholders, one per task; replaced in place as tasks start and finish. */
	results: RunResult[];
	signal?: AbortSignal;
	hooks: LaunchHooks;
	/**
	 * Called once, before the first await, with the function that cancels one task by its index: it ends only that task
	 * (killed while running, never started while queued) and returns false for an unknown or settled one.
	 */
	exposeCancel?: (cancel: (index: number) => boolean) => void;
}

/**
 * Runs every task of a validated launch. Writers are registered before the first
 * await. Each writer stays registered until its own task ends, and the launch
 * settles (or throws the first task error) only after every task has settled, so
 * sibling children never run unregistered and never hold slots after the launch ends.
 * An abort of the launch throws: the sync tool call ends with it. A task the user cancels settles as cancelled and
 * is neither an error nor a reason to stop its siblings.
 */
export async function runLaunch(input: LaunchInput, deps: LaunchDeps): Promise<Launched> {
	const { mode, tasks, results, signal, hooks } = input;
	const now = deps.now ?? Date.now;

	// One controller per task, combined with the launch's signal: aborting the launch ends every task, cancelling one ends only it.
	const controllers = tasks.map(() => new AbortController());
	const taskSignals = controllers.map((c) => (signal ? AbortSignal.any([signal, c.signal]) : c.signal));
	const cancelRequested = tasks.map(() => false);
	// The task's run ended (or it never started): a cancel no longer applies.
	const ended = tasks.map(() => false);
	input.exposeCancel?.((index) => {
		if (!Number.isInteger(index) || index < 0 || index >= tasks.length || ended[index] || cancelRequested[index] || signal?.aborted) return false;
		cancelRequested[index] = true;
		controllers[index].abort(USER_CANCEL);
		return true;
	});
	const cancelledByUser = (index: number) => cancelRequested[index] && !signal?.aborted;

	const emit = () => {
		const done = results.filter((r) => r.exitCode !== -1).length;
		hooks.onUpdate?.({
			content: [{ type: "text", text: mode === "parallel" ? `${done}/${results.length} done` : finalText(results[0].messages) || "(running...)" }],
			details: { mode, results: [...results] },
		});
	};

	const warnings: string[] = [];

	// Writers are registered before the first await, so a launch admitted right after this one
	// already sees their surfaces, even while they wait for a concurrency slot.
	const newWriterId = deps.newWriterId ?? (() => randomUUID().slice(0, 8));
	const writers: Array<ActiveWriter | undefined> = tasks.map(({ request, agent }) => (agent.writer ? { id: newWriterId(), agent: agent.name, surfaces: request.allowedEditSurfaces ?? [] } : undefined));
	deps.writers.add(writers.filter((w): w is ActiveWriter => w !== undefined));
	const removeWriter = (writer: ActiveWriter | undefined) => {
		if (writer) deps.writers.remove(writer);
	};

	// A placeholder that never started (aborted while queued) settles as cancelled instead of staying "running".
	const settleCancelled = () => {
		if (settleQueued(results, now()) > 0) emit();
	};

	// Backstop for writers: the parent is idle during the call, so any change outside the union of the writers'
	// surfaces is attributed to a child.
	const writerSurfaces = tasks.flatMap(({ request, agent }) => (agent.writer ? (request.allowedEditSurfaces ?? []) : []));
	const watchTree = tasks.some(({ agent }) => agent.writer);

	const runTask = async ({ request, agent, route, routeLabel }: LaunchTask, index: number) => {
		const { text, missingSkills } = buildChildTask(request, agent, deps.skills());
		if (missingSkills.length) warnings.push(`${agent.name}: unknown skills ${missingSkills.join(", ")}`);
		const startedAt = now();
		deps.view.start(index, { agent: agent.name, task: request.task.split("\n")[0], model: route.model, thinking: route.thinking, startedAt });
		try {
			// Live row data from the first moment: the routed model.
			results[index] = { agent: agent.name, task: request.task, exitCode: -1, messages: [], stderr: "", usage: emptyTally(), model: route.model, thinking: route.thinking, route: routeLabel, inherited: route.modelSource === "parent", startedAt };
			deps.view.attempt(index, results[index]);
			emit();
			try {
				results[index] = await deps.runAgent({
					index,
					taskText: text,
					route,
					routeLabel,
					signal: taskSignals[index],
					onUpdate: (partial) => {
						if (ended[index]) return;
						Object.assign(partial, { startedAt });
						results[index] = partial;
						deps.view.update(index, partial);
						emit();
					},
				});
			} catch (error) {
				ended[index] = true;
				// A child killed for the user's cancel may reject instead of resolving: that is the cancellation, not a failure.
				if (!cancelledByUser(index)) throw error;
			}
			ended[index] = true;
			Object.assign(results[index], { startedAt, endedAt: now() });
			if (cancelledByUser(index)) Object.assign(results[index], { cancelled: true, cancelledBy: "user" });
			// One model per agent: a quota or limit failure is not retried elsewhere, and is said out loud.
			else if (limitFailed(results[index])) warnings.push(`${agent.name}: ${results[index].model ?? route.model ?? "its model"} hit a quota or rate limit. No other model was tried; wait for the limit to reset or route this agent to another model with /brigadev:profile set`);
		} finally {
			results[index].endedAt ??= now();
			deps.view.finish(index, results[index]);
		}
		emit();
	};

	try {
		const treeBefore = watchTree ? await deps.snapshot() : undefined;
		signal?.addEventListener("abort", settleCancelled, { once: true });
		// Every task waits for a slot of the process-wide cap; one aborted while waiting never starts.
		// A task's writer is unregistered when that task ends, whatever the outcome.
		const errors: unknown[] = [];
		const pool = tasks.map(async (task, index) => {
			try {
				let release: () => void;
				try {
					release = await deps.slots.acquire(taskSignals[index]);
				} catch {
					if (!cancelledByUser(index)) throw new Error("Subagent was aborted");
					// Cancelled while it waited: it never starts, and nothing else is affected.
					ended[index] = true;
					Object.assign(results[index], { endedAt: now(), cancelled: true, cancelledBy: "user" });
					deps.view.skipped?.(index, results[index]);
					emit();
					return;
				}
				try {
					await runTask(task, index);
				} finally {
					release();
				}
			} catch (error) {
				errors.push(error);
				// A task that threw before it could settle (e.g. its view hook failed) must not stay counted as running
				// while its siblings finish: the footer count is derived from these placeholders.
				const r = results[index];
				if (isUnfinished(runStatus(r))) Object.assign(r, { endedAt: now(), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) });
			} finally {
				removeWriter(writers[index]);
			}
		});
		try {
			// Wait for every task, even after a failure: siblings keep their slots and writers until they end.
			await Promise.all(pool);
		} finally {
			signal?.removeEventListener("abort", settleCancelled);
			settleQueued(results, now());
		}
		if (errors.length > 0) throw errors[0];

		const details: Details = { mode, results };
		const treeAfter = treeBefore ? await deps.snapshot() : undefined;
		if (treeBefore && treeAfter) {
			details.outsideSurfaces = outsideSurfaces(diffSnapshots(treeBefore, treeAfter), writerSurfaces);
			if (details.outsideSurfaces.length > 0) warnings.push(`${OUTSIDE_WARNING}: ${details.outsideSurfaces.join(", ")}`);
		}
		return { details, warnings };
	} finally {
		writers.forEach(removeWriter);
	}
}
