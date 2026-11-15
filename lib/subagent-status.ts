// Footer count of subagent work: `agents: 2 running · 3 done · alt+a`.
// Pure. "Running" is derived from the state of the launches in flight (queued
// tasks included), so no exit path can leave a counter behind. "Done" uses the
// agents card's rule (visibleRuns / FINISHED_TTL_MS): a finished run counts
// while it is still on the card.

import { visibleRuns, type AgentRun } from "./agents-card.ts";
import { isUnfinished, runStatus, type RunResult } from "./run-status.ts";

/** The part of a task's result the count reads (see `runStatus`): an unfinished placeholder has exit code -1 and no end time. */
export type StatusTask = Pick<RunResult, "exitCode" | "endedAt" | "queued" | "cancelled" | "stopReason">;

export interface StatusCounts {
	running: number;
	done: number;
}

/** Tasks that are queued or running across the launches in flight. */
export function activeTasks(launches: Iterable<readonly StatusTask[]>): number {
	let n = 0;
	for (const results of launches) for (const r of results) if (isUnfinished(runStatus(r))) n++;
	return n;
}

export function statusCounts(launches: Iterable<readonly StatusTask[]>, runs: readonly AgentRun[], now: number): StatusCounts {
	return { running: activeTasks(launches), done: visibleRuns(runs, now).filter((r) => r.state !== "running").length };
}

/** The footer text, or undefined (hidden) when there is nothing to report. */
export function formatStatus(counts: StatusCounts, shortcut = "alt+a"): string | undefined {
	const parts = [counts.running > 0 ? `${counts.running} running` : "", counts.done > 0 ? `${counts.done} done` : ""].filter(Boolean);
	return parts.length ? `agents: ${[...parts, shortcut].join(" · ")}` : undefined;
}
