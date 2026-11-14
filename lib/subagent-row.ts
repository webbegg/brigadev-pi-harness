// Subagent transcript row: a one-line header per run
// (`<status> <agent> · <model> · <thinking> · <elapsed> · <N calls> · <cost>`)
// plus the last few tool calls. Pure; the `subagent` tool renderer paints it.

import { argPreview } from "./agent-thread.ts";
import { formatElapsed, shortModel, type RunState } from "./agents-card.ts";
import { drawnTicker, type DrawnTicker, type TickerDeps } from "./compact-tools.ts";
import { formatCost } from "./cost.ts";
import type { Tone } from "./shell-bar.ts";

/** Calls kept in a collapsed row; older ones fold into `… N earlier calls`. */
export const COLLAPSED_CALLS = 3;

const GLYPH: Record<RunState, string> = { running: "◐", done: "✓", failed: "✗" };
const TONE: Record<RunState, Tone> = { running: "accent", done: "success", failed: "error" };
const QUEUED_TONE: Tone = "muted";

export interface CallLike {
	name: string;
	arguments?: Record<string, unknown>;
}

export interface RowInput {
	agent: string;
	state: RunState;
	model?: string;
	thinking?: string;
	/** Where the model came from: "profile:<name>/<key>", "definition", "parent" (+ " ↪ fallback"). */
	route?: string;
	/** True when the model came from the parent session (resolved route source), whatever the route label says. */
	inherited?: boolean;
	/** Waiting for a free concurrency slot: not started yet, no elapsed time. */
	queued?: boolean;
	/** Settled without ever starting (aborted while queued). */
	cancelled?: boolean;
	/** Earlier attempts that failed, as "<model> (<category>)". */
	fallbacks?: string[];
	startedAt?: number;
	endedAt?: number;
	cost: number;
	calls: readonly CallLike[];
	error?: string;
}

export interface RowLine {
	text: string;
	tone: Tone;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function parseAttempt(entry: string): { model: string; category: string } {
	const match = /^(.*) \(([^()]*)\)$/.exec(entry);
	return match ? { model: shortModel(match[1]), category: match[2] } : { model: shortModel(entry), category: "" };
}

/** `opus-5-5 ✗ quota ↪ sonnet-5-5`; the current model is not repeated when it is the one that just failed. */
export function modelSegment(input: Pick<RowInput, "model" | "fallbacks" | "route" | "inherited">): string {
	const current = shortModel(input.model);
	const attempts = (input.fallbacks ?? []).map(parseAttempt);
	const trail = attempts.map((a) => (a.category ? `${a.model} ✗ ${a.category}` : `${a.model} ✗`));
	const lastIsCurrent = attempts.length > 0 && current !== "" && attempts[attempts.length - 1].model === current;
	if (!lastIsCurrent) trail.push(current || (attempts.length ? "" : "default"));
	// The model came from the parent session only while no fallback replaced it.
	// The resolved route source decides; the label is only a fallback for rows without the flag.
	const inherited = (input.inherited ?? input.route === "parent") && attempts.length === 0 && current !== "";
	return `${trail.filter(Boolean).join(" ↪ ")}${inherited ? " ↑" : ""}`;
}

export function rowHeader(input: RowInput, now: number): string {
	const elapsed = input.startedAt === undefined ? "" : formatElapsed((input.endedAt ?? now) - input.startedAt);
	const glyph = input.queued && input.state === "running" ? "○" : GLYPH[input.state];
	return [
		`${glyph} ${input.agent}`,
		modelSegment(input),
		input.thinking,
		elapsed,
		input.queued && input.state === "running" ? "queued" : input.cancelled && input.state === "failed" ? "cancelled" : "",
		input.calls.length > 0 ? plural(input.calls.length, "call") : "",
		input.cost > 0 ? formatCost(input.cost) : "",
	]
		.filter(Boolean)
		.join(" · ");
}

/** Placeholder fields for a task that has not started: the routed model, thinking and route, flagged queued. */
export function queuedFields(route: { model?: string; thinking?: string; modelSource: string }, label: string) {
	return { model: route.model, thinking: route.thinking, route: label, inherited: route.modelSource === "parent", queued: true };
}

/** Row state of a run: exit -1 with an end time is a placeholder that settled without finishing. */
export function runState(r: { exitCode: number; endedAt?: number; stopReason?: string }, failed: boolean): RunState {
	if (r.exitCode === -1) return r.endedAt === undefined ? "running" : "failed";
	return failed ? "failed" : "done";
}

/** Settle placeholders that never started (aborted while queued); returns how many. */
export function settleQueued(results: Array<{ exitCode: number; queued?: boolean; cancelled?: boolean; endedAt?: number }>, at: number): number {
	let n = 0;
	for (const r of results) {
		if (r.exitCode !== -1 || !r.queued || r.endedAt !== undefined) continue;
		r.endedAt = at;
		r.cancelled = true;
		n++;
	}
	return n;
}

/** Per-row timer state kept on the tool's render context. */
export interface RowTimerState {
	ticker?: DrawnTicker;
	invalidate?: () => void;
}

/**
 * Keep the one-second redraw in step with the row: running while `live`, stopped when it settles,
 * and self-stopping once the row is not drawn (the returned `touch` belongs in the component's
 * render()). Without a state holder (export, replay) nothing starts.
 */
export function syncRowTimer(state: RowTimerState | undefined, options: { live: boolean; invalidate: () => void }, deps: TickerDeps = {}): () => void {
	if (!state) return () => {};
	state.invalidate = options.invalidate;
	state.ticker ??= drawnTicker(() => state.invalidate?.(), deps);
	if (options.live) state.ticker.start();
	else state.ticker.stop();
	return () => state.ticker?.touch();
}

const callLine = (call: CallLike): RowLine => {
	const preview = argPreview(call.name, call.arguments);
	return { text: `  → ${call.name}${preview ? ` ${preview.length > 70 ? `${preview.slice(0, 70)}…` : preview}` : ""}`, tone: "dim" };
};

/**
 * Collapsed: header, `… N earlier calls` when some are folded, the last `maxCalls`
 * calls, and one error line for a failed run. Expanded: header, the route source,
 * and every call. The full report is appended by the renderer.
 */
export function subagentRow(input: RowInput, options: { now: number; expanded: boolean; maxCalls?: number }): RowLine[] {
	const tone = input.queued && input.state === "running" ? QUEUED_TONE : TONE[input.state];
	const lines: RowLine[] = [{ text: rowHeader(input, options.now), tone }];
	if (options.expanded) {
		if (input.route) lines.push({ text: `  via ${input.route}`, tone: "muted" });
		lines.push(...input.calls.map(callLine));
	} else {
		const max = options.maxCalls ?? COLLAPSED_CALLS;
		const hidden = Math.max(0, input.calls.length - max);
		if (hidden > 0) lines.push({ text: `  … ${plural(hidden, "earlier call")}`, tone: "muted" });
		lines.push(...input.calls.slice(hidden).map(callLine));
	}
	const error = input.state === "failed" ? input.error?.split("\n").find((l) => l.trim()) : undefined;
	if (error) lines.push({ text: `  ${options.expanded || error.length <= 100 ? error : `${error.slice(0, 99)}…`}`, tone: "error" });
	return lines;
}
