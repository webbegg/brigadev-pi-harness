// What one subagent run is and where it stands: the run snapshot type and the one run-state rule
// (`runStatus`, `isUnfinished`, `toRunState`, `failed`) plus the text the parent is told (`finalText`, `output`).
// No child_process: the view modules read these without pulling in the process module (lib/child-run.ts re-exports them).
// It reaches node:fs only through lib/structured-output.ts (`formatStructured`).

import type { Message } from "@earendil-works/pi-ai";
import type { RunState } from "./agents-card.ts";
import type { Tally } from "./cost.ts";
import { formatStructured } from "./structured-output.ts";

export interface RunResult {
	agent: string;
	task: string;
	exitCode: number; // -1 while running
	messages: Message[];
	stderr: string;
	usage: Tally;
	model?: string;
	thinking?: string;
	/** Where the model came from: "profile:<name>/<key>", "definition", or "parent". */
	route?: string;
	/** True when the model came from the parent session (resolved route source), for the row's `↑`. */
	inherited?: boolean;
	/** Placeholder of a task that is waiting for a concurrency slot. */
	queued?: boolean;
	/** Settled without finishing: aborted while queued, or (with a real exit code) stopped by the user while running. */
	cancelled?: boolean;
	/** Who cancelled it, when a person did (the web UI's cancel); the result text says so. */
	cancelledBy?: "user";
	/** Epoch ms when the run was launched (first attempt); drives the row's elapsed time. */
	startedAt?: number;
	/** Epoch ms when the run settled; set for aborted placeholders too. */
	endedAt?: number;
	stopReason?: string;
	errorMessage?: string;
	/** Live text of the assistant message in progress (see lib/child-events.ts); never set on a settled run. */
	partial?: string;
	/** Validated structured_output payload, for agents that declare an output schema. */
	structured?: unknown;
	/** Id of this child attempt; names its saved folder (lib/run-artifacts.ts). */
	runId?: string;
	/** Folder holding task.md, transcript.json, and result.json for this attempt. */
	artifactsDir?: string;
}

/**
 * The abort reason of a task the user cancelled. A task's signal carries it (`AbortSignal.any` keeps the first reason), so
 * the child runner can tell a cancel, which ends only that task, from an abort of the whole launch, which throws.
 */
export const USER_CANCEL: Error = new Error("Cancelled by the user");

export function finalText(messages: Message[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant") continue;
		for (const part of msg.content) if (part.type === "text") return part.text;
	}
	return "";
}

export const failed = (r: Pick<RunResult, "exitCode" | "stopReason">) => r.exitCode > 0 || r.stopReason === "error" || r.stopReason === "aborted";

/** Where a run stands: what the card, the viewer, the footer count, and the result text all read. */
export type RunStatus = "queued" | "running" | "done" | "failed" | "cancelled";

/**
 * The one run-state rule. Exit code -1 is a placeholder: with no end time it is unfinished (queued until it gets a slot,
 * else running); with an end time it settled without finishing (cancelled when it never started, else failed).
 * Any other exit code is a real run: cancelled when the user stopped it, else failed per `failed`, else done.
 */
export function runStatus(r: Pick<RunResult, "exitCode" | "endedAt" | "queued" | "cancelled" | "stopReason">): RunStatus {
	if (r.exitCode === -1) {
		if (r.endedAt === undefined) return r.queued ? "queued" : "running";
		return r.cancelled ? "cancelled" : "failed";
	}
	if (r.cancelled) return "cancelled";
	return failed(r) ? "failed" : "done";
}

/** Queued or running: not finished yet. */
export const isUnfinished = (status: RunStatus): boolean => status === "queued" || status === "running";

/** The three-state view the card and the transcript row use: queued counts as running, cancelled as failed. */
export function toRunState(status: RunStatus): RunState {
	return isUnfinished(status) ? "running" : status === "done" ? "done" : "failed";
}

/** What the parent is told for one run: the error, the structured payload, or the final text. */
export const output = (r: RunResult) =>
	(failed(r) ? r.errorMessage || r.stderr.trim() || finalText(r.messages) : r.structured !== undefined ? formatStructured(r.structured) : finalText(r.messages)) || "(no output)";
