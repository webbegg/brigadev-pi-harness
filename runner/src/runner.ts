// Opens the Harness for one repo: registry (CodingTools, the guard hook, the check tool, the ticket tasks), a Node environment on each conversation's cwd,
// and helpers to start a loop for a feature doc (once per doc path) and wait for its outcome.
import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai/models";
import { createRegistry, defineExtension, Harness } from "@earendil-works/pi-durable";
import type { HarnessSettings, ModelRef, Report, Storage, TaskId } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { createCheckTool } from "./check-tool.ts";
import { guardExtension } from "./guard.ts";
import { createTasks, defaultDeps, LOOP_TASK, type LoopInput, type LoopResult, type TicketDeps } from "./tasks.ts";
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
}

export type LoopOutcome =
	| { status: "completed"; result: LoopResult }
	| { status: "failed"; error: { message: string; detail?: unknown } }
	| { status: "aborted" | "orphaned" | "faulted"; reason?: string; error?: { message: string } };

export interface Runner {
	harness: Harness;
	/** The resolved repo directory workers run in. */
	cwd: string;
	/** Start the loop for a doc. Idempotent per doc path: a second call returns the same task, also after a restart. */
	start(docPath: string, options?: { maxAttempts?: number }): Promise<TaskId<LoopResult>>;
	/** Wait for the loop's outcome. Enables scheduling, so after a reopen this also resumes interrupted work. */
	wait(taskId: TaskId<LoopResult>): Promise<LoopOutcome>;
	close(): Promise<void>;
}

export async function openRunner(options: RunnerOptions): Promise<Runner> {
	const context = options.context ?? BACKGROUND_CONTEXT;
	const cwd = resolve(options.cwd);
	const checkTool = createCheckTool({ cwd });
	const { loop, ticket } = createTasks(options.deps ?? defaultDeps, options.worker, [checkTool]);
	const registry = createRegistry();
	registry.install(CodingTools);
	// S5: every tool call of a worker conversation (nested ones too) goes through the brigadev guard rules.
	registry.install(guardExtension({ cwd }));
	registry.install(defineExtension({ name: "brigadev-check", tools: [checkTool] }));
	registry.install(defineExtension({ name: "brigadev-runner", tasks: [loop, ticket] }));

	const harness = await Harness.open(
		options.storage,
		{
			models: options.models,
			registry,
			settings: options.settings,
			env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? cwd }),
			onReport: options.onReport,
		},
		context,
	);
	const root = await harness.root(context, { agent: { model: options.model, cwd } });

	return {
		harness,
		cwd,
		async start(docPath, startOptions = {}) {
			const path = resolve(docPath);
			const input: LoopInput = { docPath: path, cwd, ...(startOptions.maxAttempts === undefined ? {} : { maxAttempts: startOptions.maxAttempts }) };
			const taskId = await root.commit(async (tx) => {
				// One loop per doc path: look through every loop task, live or ended, before creating one.
				let cursor: Awaited<ReturnType<typeof tx.scanTasks>>["next"];
				do {
					const page = await tx.scanTasks({ kind: LOOP_TASK }, 100, cursor);
					const found = page.items.find((record) => (record.input as LoopInput).docPath === path);
					if (found) return found.id as TaskId<LoopResult>;
					cursor = page.next;
				} while (cursor);
				return tx.createTask(loop, input, { ownership: { kind: "conversation" } });
			}, context);
			// Committing a task does not start the scheduler; do it here so the loop runs without anyone waiting on it.
			harness.resume();
			return taskId;
		},
		async wait(taskId) {
			const settled = await harness.waitForTask(taskId, context);
			const outcome = settled.state.outcome;
			if (outcome.status === "completed") return { status: "completed", result: outcome.result as LoopResult };
			if (outcome.status === "failed") return { status: "failed", error: outcome.error };
			return outcome as LoopOutcome;
		},
		close: () => harness.close(context),
	};
}
