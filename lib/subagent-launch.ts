// Launch orchestration for the `subagent` tool, shared by sync and async mode:
// a slot of the process-wide semaphore per task, queued placeholders, the model
// fallback chain, writer registration, and the text the model reads. No Pi
// imports: the task runner, semaphore, writer registry, card/UI hooks, and
// working-tree snapshot are injected, so tests drive it with fakes.

import { randomUUID } from "node:crypto";
import type { AgentDefinition } from "./agents.ts";
import type { ChildControl } from "./child-rpc.ts";
import { failed, finalText, output, type RunResult } from "./child-run.ts";
import { emptyTally } from "./cost.ts";
import { buildChildTask, type ActiveWriter, type LaunchRequest, type SkillRef } from "./delegation.ts";
import { classifyFailure, type FailureCategory } from "./fallback.ts";
import type { ResolvedRoute } from "./model-routing.ts";
import type { Semaphore } from "./semaphore.ts";
import { settleQueued } from "./subagent-row.ts";
import { formatStructured } from "./structured-output.ts";
import { diffSnapshots, outsideSurfaces, type Snapshot } from "./worktree-snapshot.ts";

const OUTSIDE_WARNING = "files changed outside the writers' allowed edit surfaces";
const CANCELLED_TEXT = "Cancelled before it started.";

/** A placeholder that never started (aborted while queued): neither a success nor a child failure. */
const cancelled = (r: RunResult) => r.cancelled === true && r.exitCode === -1;

export const PER_TASK_OUTPUT_CAP = 50 * 1024;

export interface Details {
	mode: "single" | "parallel";
	results: RunResult[];
	/** Files the batch changed outside every writer's surfaces (set when writers ran in a git repo). */
	outsideSurfaces?: string[];
	/** Async launch id (subagent_wait / subagent_cancel collect it). */
	launchId?: string;
	/** True on the immediate async return and on a wait that timed out: the results are not final. */
	pending?: boolean;
}

/** A finished launch as the tool returns it; the registry keeps it for `subagent_wait`. */
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
	/** Streams partial results to the tool call (sync mode). */
	onUpdate?: (result: { content: Array<{ type: "text"; text: string }>; details: Details }) => void;
	/** Reports `done/total` to the registry (async mode). */
	onProgress?: (done: number, total: number) => void;
	/** Async launches settle with partial results when aborted; sync ones throw as they always did. */
	tolerateAbort: boolean;
	/** Async launch: the parent keeps working meanwhile, so the writer backstop ignores other launches' writers and words its warning honestly. */
	async?: boolean;
}

export function capOutput(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= PER_TASK_OUTPUT_CAP) return text;
	let cut = text.slice(0, PER_TASK_OUTPUT_CAP);
	while (Buffer.byteLength(cut, "utf8") > PER_TASK_OUTPUT_CAP) cut = cut.slice(0, -1);
	return `${cut}\n\n[Output truncated. Full output is in the tool details.]`;
}

/** One parallel section's body: a structured result is never cut (compact JSON above the cap); prose is capped. */
export const sectionOutput = (r: RunResult): string => (!failed(r) && r.structured !== undefined ? formatStructured(r.structured, PER_TASK_OUTPUT_CAP) : capOutput(output(r)));

/** The content the model reads: the same text for a sync call and for `subagent_wait`. */
export function toResult(mode: Details["mode"], { details, warnings }: Launched): LaunchResult {
	const warningText = warnings.length ? `\n\nWarnings: ${warnings.join("; ")}` : "";
	if (mode === "single") {
		const r = details.results[0];
		// A task cancelled while queued (async only: a sync abort throws) is an error that says so, not an empty success.
		if (cancelled(r)) return { content: [{ type: "text", text: `Agent cancelled: ${CANCELLED_TEXT}${warningText}` }], details, isError: true };
		return { content: [{ type: "text", text: (failed(r) ? `Agent ${r.stopReason ?? "failed"}: ` : "") + output(r) + warningText }], details, isError: failed(r) };
	}
	const ok = details.results.filter((r) => !failed(r) && !cancelled(r)).length;
	const sections = details.results.map((r) => (cancelled(r) ? `### [${r.agent}] cancelled\n\n${CANCELLED_TEXT}` : `### [${r.agent}] ${failed(r) ? "failed" : "completed"}\n\n${sectionOutput(r)}`));
	return { content: [{ type: "text", text: `Parallel: ${ok}/${details.results.length} succeeded\n\n${sections.join("\n\n---\n\n")}${warningText}` }], details };
}

export interface LaunchTask {
	request: LaunchRequest;
	agent: AgentDefinition;
	route: ResolvedRoute;
	/** Base route label (the attempt adds " ↪ fallback" when it is not the primary model). */
	routeLabel: string;
}

/** One attempt for the task runner. */
export interface AgentCall {
	index: number;
	taskText: string;
	route: ResolvedRoute;
	routeLabel: string;
	signal?: AbortSignal;
	onUpdate: (result: RunResult) => void;
	/** The attempt's steering handle while its child runs; `undefined` once the run has finished. */
	onControl?: (control: ChildControl | undefined) => void;
}

/** Card/viewer hooks for one task; the extension keeps the card rows and the live results. */
export interface TaskView {
	/** The task got its slot: count it as running and add its card row. */
	start(index: number, info: { agent: string; task: string; model?: string; thinking?: string; startedAt: number }): void;
	/** A new attempt placeholder was installed (its model and thinking are the attempt's). */
	attempt(index: number, result: RunResult): void;
	/** The child streamed a partial result. */
	update(index: number, result: RunResult): void;
	/** The task ended (any outcome): settle its row and the running count. */
	finish(index: number, result: RunResult): void;
	/** The task's child can be steered (`control`) or can no longer be (`undefined`: it finished). */
	control?(index: number, control: ChildControl | undefined): void;
}

export interface FallbackStep {
	model?: string;
	thinking?: string;
}

export interface LaunchDeps {
	/** The process-wide concurrency cap. */
	slots: Semaphore;
	/** Runs one attempt of one task (spawns the child). */
	runAgent: (call: AgentCall) => Promise<RunResult>;
	skills: () => readonly SkillRef[];
	/** Model chain for a task, evaluated when the task gets its slot. */
	chain: (index: number) => FallbackStep[];
	/** A model failed for `category`: keep it out of use for a while. */
	coolModel: (model: string, category: FailureCategory) => void;
	/** The task moves on to the next model. */
	fallbackNotice: (info: { agent: string; from: string; to: string; category: FailureCategory }) => void;
	/** The shared list of running writers. */
	writers: {
		add: (writers: ActiveWriter[]) => void;
		remove: (writer: ActiveWriter) => void;
		/** The writers registered right now (any launch). Async launches read it to learn who else was active. */
		list?: () => readonly ActiveWriter[];
		/** Calls `listener` with every writer registered from now on (any launch); returns the unsubscribe. */
		onAdd?: (listener: (writers: readonly ActiveWriter[]) => void) => () => void;
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
	/** Placeholders, one per task; replaced in place as attempts start and finish. */
	results: RunResult[];
	signal?: AbortSignal;
	hooks: LaunchHooks;
}

/**
 * Runs every task of a validated launch. Writers are registered before the first
 * await. Each writer stays registered until its own task ends, and the launch
 * settles (or throws the first task error) only after every task has settled, so
 * sibling children never run unregistered and never hold slots after the launch ends.
 */
export async function runLaunch(input: LaunchInput, deps: LaunchDeps): Promise<Launched> {
	const { mode, tasks, results, signal, hooks } = input;
	const now = deps.now ?? Date.now;

	const emit = () => {
		const done = results.filter((r) => r.exitCode !== -1).length;
		hooks.onProgress?.(done, results.length);
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
	// An async launch cannot tell its children's edits from another launch's writers, so it records the surfaces of every
	// other writer that is active at any time during the launch (already registered, or registering later) and excludes them.
	const ownIds = new Set(writers.flatMap((w) => (w ? [w.id] : [])));
	const otherSurfaces: string[] = [];
	const recordOthers = (others: readonly ActiveWriter[]) => {
		for (const w of others) if (!ownIds.has(w.id)) otherSurfaces.push(...w.surfaces);
	};
	let stopRecording = () => {};
	if (hooks.async && writers.some(Boolean)) {
		recordOthers(deps.writers.list?.() ?? []);
		stopRecording = deps.writers.onAdd?.(recordOthers) ?? stopRecording;
	}
	deps.writers.add(writers.filter((w): w is ActiveWriter => w !== undefined));
	const removeWriter = (writer: ActiveWriter | undefined) => {
		if (writer) deps.writers.remove(writer);
	};

	// A placeholder that never started (aborted while queued) settles as cancelled instead of staying "running".
	const settleCancelled = () => {
		if (settleQueued(results, now()) > 0) emit();
	};

	// Backstop for writers: the parent is idle during a sync call, so any change outside the union of the writers'
	// surfaces is attributed to a child. An async launch cannot promise that: the parent (and other launches'
	// writers, excluded above) may edit meanwhile, so its warning says the list may include the parent's edits.
	const writerSurfaces = tasks.flatMap(({ request, agent }) => (agent.writer ? (request.allowedEditSurfaces ?? []) : []));
	const watchTree = tasks.some(({ agent }) => agent.writer);

	const runTask = async ({ request, agent, route, routeLabel }: LaunchTask, index: number) => {
		const { text, missingSkills } = buildChildTask(request, agent, deps.skills());
		if (missingSkills.length) warnings.push(`${agent.name}: unknown skills ${missingSkills.join(", ")}`);
		const startedAt = now();
		deps.view.start(index, { agent: agent.name, task: request.task.split("\n")[0], model: route.model, thinking: route.thinking, startedAt });
		// Fallback chain: the primary, then the profile's fallbacks, with cooling
		// or out-of-quota models moved behind usable ones.
		const chain = deps.chain(index);
		const failedModels: string[] = [];
		// Whether the view holds this task's handle: a task that ends abnormally must not leave one behind.
		let held = false;
		try {
			for (let step = 0; step < chain.length; step++) {
				const attempt = chain[step];
				const stepRoute: ResolvedRoute = { ...route, model: attempt.model, thinking: attempt.thinking ?? route.thinking };
				const label = `${routeLabel}${attempt.model !== route.model ? " ↪ fallback" : ""}`;
				// Live row data from the first moment: the attempt's model and the trail so far.
				const trail = () => (failedModels.length ? { fallbacks: [...failedModels] } : {});
				results[index] = { agent: agent.name, task: request.task, exitCode: -1, messages: [], stderr: "", usage: emptyTally(), model: stepRoute.model, thinking: stepRoute.thinking, route: label, inherited: stepRoute.modelSource === "parent", startedAt, ...trail() };
				deps.view.attempt(index, results[index]);
				emit();
				try {
					results[index] = await deps.runAgent({
						index,
						taskText: text,
						route: stepRoute,
						routeLabel: label,
						signal,
						onControl: (control) => {
							held = control !== undefined;
							deps.view.control?.(index, control);
						},
						onUpdate: (partial) => {
							Object.assign(partial, { startedAt, ...trail() });
							results[index] = partial;
							deps.view.update(index, partial);
							emit();
						},
					});
				} catch (error) {
					if (!hooks.tolerateAbort || !signal?.aborted) throw error;
					// Cancelled or shut down: keep what the child produced so far and settle the row as aborted.
					const partial = results[index];
					Object.assign(partial, { stopReason: "aborted", errorMessage: partial.errorMessage ?? "Subagent was aborted", startedAt, endedAt: now(), ...trail() });
					break;
				}
				const r = results[index];
				Object.assign(r, { startedAt, endedAt: now(), ...trail() });
				if (!failed(r) || !attempt.model) break;
				const category = classifyFailure(r.stopReason ?? "error", r.errorMessage || r.stderr);
				if (!category) break;
				deps.coolModel(attempt.model, category);
				failedModels.push(`${attempt.model} (${category})`);
				const next = chain[step + 1];
				if (!next?.model) break;
				deps.fallbackNotice({ agent: agent.name, from: attempt.model, to: next.model, category });
			}
			if (failedModels.length) results[index].fallbacks = failedModels;
		} finally {
			if (held) deps.view.control?.(index, undefined);
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
					release = await deps.slots.acquire(signal);
				} catch {
					if (!hooks.tolerateAbort) throw new Error("Subagent was aborted");
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
				if (r.exitCode === -1 && r.endedAt === undefined) Object.assign(r, { endedAt: now(), stopReason: "error", errorMessage: error instanceof Error ? error.message : String(error) });
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
			details.outsideSurfaces = outsideSurfaces(diffSnapshots(treeBefore, treeAfter), hooks.async ? [...writerSurfaces, ...otherSurfaces] : writerSurfaces);
			if (details.outsideSurfaces.length > 0) warnings.push(`${OUTSIDE_WARNING}${hooks.async ? " (may include edits the parent made meanwhile)" : ""}: ${details.outsideSurfaces.join(", ")}`);
		}
		return { details, warnings };
	} finally {
		stopRecording();
		writers.forEach(removeWriter);
	}
}
