// What `subagent_wait` and `subagent_cancel` decide, and the text the model reads about collecting an async
// launch. Pure: the extension registers the tools and passes the registry in; nothing here imports Pi.

import { deliveredNote } from "./result-delivery.ts";
import type { LaunchResult } from "./subagent-launch.ts";
import type { SubagentRegistry, WaitOutcome } from "./subagent-registry.ts";

export const WAIT_DEFAULT_SECONDS = 60;
export const WAIT_MAX_SECONDS = 300;
const WAIT_MIN_SECONDS = 1;

/** The part of the registry the tools use. */
export type LaunchRegistry = Pick<SubagentRegistry<LaunchResult>, "wait" | "cancel">;

/** Tool parameters: `launchId` is the name; `runId` is the old name, still accepted (it collides with the per-attempt run id). */
export interface LaunchRef {
	launchId?: string;
	runId?: string;
}

export interface WaitRequest extends LaunchRef {
	timeoutSeconds?: number;
}

/** The launch id of a call: exactly one of `launchId` / `runId` (the deprecated alias) must be a non-empty string. */
export function resolveLaunchId(params: LaunchRef): { id: string } | { error: string } {
	const launchId = params.launchId || undefined;
	const runId = params.runId || undefined;
	if (launchId !== undefined && runId !== undefined) return { error: "Pass launchId only; runId is its deprecated alias, not a second id." };
	const id = launchId ?? runId;
	return id === undefined ? { error: 'Missing launchId: pass the id from the async subagent call, as {"launchId":"…"}.' } : { id };
}

/** The wait time in seconds: 60 by default, at least 1, at most 300. */
export function clampWaitSeconds(requested?: number): number {
	const seconds = requested === undefined || !Number.isFinite(requested) ? WAIT_DEFAULT_SECONDS : requested;
	return Math.min(WAIT_MAX_SECONDS, Math.max(WAIT_MIN_SECONDS, seconds));
}

/** How the model collects a launch; shown wherever it is told to. */
export const collectHint = (id: string): string => `subagent_wait {"launchId":"${id}"}`;

/** What the async `subagent` call returns right away. */
export function startedText(id: string, taskCount: number, agents: readonly string[]): string {
	return `Started async launch ${id} (${taskCount} task${taskCount === 1 ? "" : "s"}: ${agents.join(", ")}). Collect it with ${collectHint(id)}; stop it with subagent_cancel.`;
}

const note = (text: string, id?: string, isError?: boolean): LaunchResult => ({
	content: [{ type: "text", text }],
	details: { mode: "single", results: [], pending: true, ...(id === undefined ? {} : { launchId: id }) },
	...(isError ? { isError } : {}),
});

/** What wait and cancel answer for each registry outcome. `waitedSeconds` is set by wait only. */
export function collectedResult(id: string, outcome: WaitOutcome<LaunchResult>, waitedSeconds?: number): LaunchResult {
	if (outcome.status === "unknown") return note(`Unknown launch id "${id}" (not started in this session, or pruned).`, id, true);
	if (outcome.status === "running") {
		const { done, total } = outcome.launch;
		return note(`Launch ${id} still running: ${done}/${total} done${waitedSeconds === undefined ? "" : ` after ${waitedSeconds}s`}. Call subagent_wait again, or subagent_cancel.`, id);
	}
	if (outcome.error !== undefined || !outcome.result) return note(`Launch ${id} failed: ${outcome.error ?? "no result"}`, id, true);
	return { ...outcome.result, details: { ...outcome.result.details, launchId: id } };
}

/** The idle delivery already put this result in the session: a short note pointing at the saved folders instead of repeating it (wait and cancel alike). */
function reply(id: string, outcome: WaitOutcome<LaunchResult>, waitedSeconds?: number): LaunchResult {
	const delivered = deliveredNote(id, outcome);
	return delivered === undefined ? collectedResult(id, outcome, waitedSeconds) : note(delivered, id);
}

/** `subagent_wait`: waits for the launch (clamped timeout), then answers the outcome. */
export async function waitForLaunch(registry: LaunchRegistry, params: WaitRequest, signal?: AbortSignal): Promise<LaunchResult> {
	const ref = resolveLaunchId(params);
	if ("error" in ref) return note(ref.error, undefined, true);
	const seconds = clampWaitSeconds(params.timeoutSeconds);
	return reply(ref.id, await registry.wait(ref.id, seconds * 1000, signal), seconds);
}

/** `subagent_cancel`: aborts the launch and answers its partial outcome. */
export async function cancelLaunch(registry: LaunchRegistry, params: LaunchRef): Promise<LaunchResult> {
	const ref = resolveLaunchId(params);
	if ("error" in ref) return note(ref.error, undefined, true);
	return reply(ref.id, await registry.cancel(ref.id));
}
