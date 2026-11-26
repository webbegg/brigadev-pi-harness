// /brigadev:retro <runId>: close one subagent run with its outcome and feed it back to the factory.
// A flawed run (the agent produced the wrong thing) becomes a draft eval case (lib/evals.ts layout);
// a blocked one becomes the line that names what the environment lacked. Pure over the run folder
// (lib/run-artifacts.ts); the command in extensions/retro.ts asks and writes.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Assertion, EvalCaseSpec } from "./evals.ts";
import { runsDir } from "./run-artifacts.ts";

export const OUTCOMES = ["success", "flawed", "blocked", "manual"] as const;
export type Outcome = (typeof OUTCOMES)[number];

/** A plain folder name: no separator, no `..`, no leading dot. Run ids and agent names both become path segments. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Why `id` cannot name a run folder, or undefined when it can. */
export function runIdProblem(id: string): string | undefined {
	if (!id) return "a run id is required";
	if (!PLAIN_NAME.test(id) || id.includes("..")) return `not a run id: ${id} (a folder name under runs/, no / or ..)`;
	return undefined;
}

export interface RetroRun {
	runId: string;
	agent: string;
	/** The task as the parent wrote it (result.json), not the composed message. */
	task: string;
	reason?: string;
	/** A writer's surfaces, from the task message's `## Allowed edit surfaces` section. */
	allowedEditSurfaces?: string[];
	structured?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

/** The `- item` lines of a writer's `## Allowed edit surfaces` section (lib/delegation.ts buildChildTask). */
function surfacesOf(taskText: string): string[] | undefined {
	const section = /^## Allowed edit surfaces\n((?:- .*\n?)+)/m.exec(taskText);
	const items = section?.[1].split("\n").flatMap((line) => (line.startsWith("- ") ? [line.slice(2).trim()] : []));
	return items?.length ? items : undefined;
}

/** The text under `## Task` of the composed message, the fallback when result.json lacks the task. */
const taskSection = (taskText: string): string => /^## Task\n([\s\S]*?)(?=\n## |$)/m.exec(taskText)?.[1].trim() ?? taskText.trim();

/** Reads `<docs>/runs/<runId>/` (task.md and result.json). */
export function readRun(docsDir: string, runId: string): { ok: true; run: RetroRun } | { ok: false; error: string } {
	const problem = runIdProblem(runId);
	if (problem) return { ok: false, error: problem };
	const dir = join(runsDir(docsDir), runId);
	try {
		// A symlinked run folder is never followed.
		if (!lstatSync(dir).isDirectory()) return { ok: false, error: `not a run folder: ${dir}` };
	} catch {
		return { ok: false, error: `no run folder ${dir}` };
	}
	let result: Record<string, unknown>;
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(dir, "result.json"), "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
		result = parsed as Record<string, unknown>;
	} catch (err) {
		return { ok: false, error: `unreadable result.json in ${dir}: ${err instanceof Error ? err.message : String(err)}` };
	}
	const taskFile = join(dir, "task.md");
	const taskText = existsSync(taskFile) ? readFileSync(taskFile, "utf8") : "";
	const agent = typeof result.agent === "string" ? result.agent : "";
	if (runIdProblem(agent)) return { ok: false, error: `result.json names no usable agent: ${JSON.stringify(result.agent)}` };
	const str = (value: unknown) => (typeof value === "string" && value ? value : undefined);
	return {
		ok: true,
		run: {
			runId,
			agent,
			task: str(result.task) ?? taskSection(taskText),
			reason: str(result.reason),
			allowedEditSurfaces: surfacesOf(taskText),
			structured: result.structured,
			stopReason: str(result.stopReason),
			errorMessage: str(result.errorMessage),
		},
	};
}

/**
 * One assertion per top-level field of the result, to edit into what the right result would have been:
 * a boolean is pinned to the value it had, an array needs an item, anything else must exist.
 * A run without an object result gets `$ exists`.
 */
export function expectSkeleton(structured: unknown): Assertion[] {
	if (!structured || typeof structured !== "object" || Array.isArray(structured)) return [{ path: "$", exists: true }];
	const fields = Object.entries(structured).filter(([key]) => /^[A-Za-z_$][\w$-]*$/.test(key));
	if (fields.length === 0) return [{ path: "$", exists: true }];
	return fields.map(([key, value]): Assertion => {
		const path = `$.${key}`;
		if (typeof value === "boolean") return { path, equals: value };
		if (Array.isArray(value)) return { path, minItems: 1 };
		return { path, exists: true };
	});
}

export interface EvalDraft {
	/** Repository-relative: `evals/<agent>/<runId>/case.json`. */
	path: string;
	spec: EvalCaseSpec;
	/** The file content. */
	text: string;
}

/** The eval case a flawed run becomes. It has no fixture: the run's checkout is not recorded, so add one by hand. */
export function draftEvalCase(run: RetroRun): EvalDraft {
	const spec: EvalCaseSpec = { task: run.task, ...(run.reason ? { reason: run.reason } : {}), ...(run.allowedEditSurfaces ? { allowedEditSurfaces: run.allowedEditSurfaces } : {}), expect: expectSkeleton(run.structured) };
	return { path: `evals/${run.agent}/${run.runId}/case.json`, spec, text: `${JSON.stringify(spec, null, "\t")}\n` };
}

/** The close line of a blocked run: what was missing, from the agent's `unblock`, else the run's error, else left to fill in. */
export function blockedLine(run: RetroRun): string {
	const unblock = run.structured && typeof run.structured === "object" ? (run.structured as Record<string, unknown>).unblock : undefined;
	const missing = typeof unblock === "string" && unblock.trim() ? unblock.trim() : (run.errorMessage?.trim() ?? "");
	return `Outcome: blocked (${run.agent} ${run.runId}). What was missing: ${missing}`;
}
