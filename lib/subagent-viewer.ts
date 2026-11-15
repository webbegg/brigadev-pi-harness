// Pure state for the Agents viewer: the list of runs (sync and async, queued,
// running, settled), selection that survives live updates, scroll pinning, and
// the detail pane of one run, and the takeover input line (steer / follow up /
// abort a running child). The extension owns the terminal and feeds this the
// runs it tracks; nothing here imports Pi or the TUI.

import { threadRows } from "./agent-thread.ts";
import { formatElapsed } from "./agents-card.ts";
import type { CommandOutcome } from "./child-rpc.ts";
import { failed, type RunResult } from "./child-run.ts";
import { formatCost, formatTokens } from "./cost.ts";
import type { Tone } from "./shell-bar.ts";
import { maxScroll, type Row } from "./two-pane.ts";

export type EntryState = "queued" | "running" | "done" | "failed" | "cancelled";

/** A run this process is tracking (in a launch in flight, or settled since the session started). `id` is stable across updates. */
export interface TrackedRun {
	id: string;
	result: RunResult;
}

/** A finished run recorded on the session branch (a sync call, or an async launch collected by wait/cancel). */
export interface RecordedRun {
	result: RunResult;
	/** Epoch ms of the branch entry. */
	at: number;
}

export interface ViewerEntry {
	key: string;
	result: RunResult;
	state: EntryState;
	/** Queued or running: its thread is still changing. */
	active: boolean;
	/** Empty when the run has not started or its start time is unknown. */
	elapsed: string;
}

const GLYPH: Record<EntryState, string> = { queued: "○", running: "◐", done: "✓", failed: "✗", cancelled: "⊘" };
const TONE: Record<EntryState, Tone> = { queued: "muted", running: "accent", done: "success", failed: "error", cancelled: "muted" };
const RANK: Record<EntryState, number> = { running: 0, queued: 1, done: 2, failed: 2, cancelled: 2 };

/** Exit -1 with no end time is unfinished (queued until it gets a slot); with an end time it settled without finishing. */
export function entryState(r: RunResult): EntryState {
	if (r.exitCode === -1) {
		if (r.endedAt === undefined) return r.queued ? "queued" : "running";
		return r.cancelled ? "cancelled" : "failed";
	}
	return failed(r) ? "failed" : "done";
}

/** Identity of a result across its in-process and recorded copies. */
const sameRunKey = (r: RunResult): string => (r.runId ? `id:${r.runId}` : ["", r.agent, r.task, r.startedAt ?? "", r.endedAt ?? ""].join("\u0000"));

/**
 * Every run in one list: running (newest start first), queued, then finished
 * (newest end first). A run known both in-process and on the branch appears once.
 */
export function buildEntries(input: { tracked: readonly TrackedRun[]; recorded: readonly RecordedRun[]; now: number }): ViewerEntry[] {
	const seen = new Set(input.tracked.map((t) => sameRunKey(t.result)));
	const items: Array<{ key: string; result: RunResult; sortAt: number }> = input.tracked.map((t) => ({ key: t.id, result: t.result, sortAt: t.result.endedAt ?? t.result.startedAt ?? 0 }));
	const copies = new Map<string, number>();
	for (const { result, at } of input.recorded) {
		const base = sameRunKey(result);
		if (seen.has(base)) continue;
		// Identical recorded results with no run id stay distinct.
		const n = copies.get(base) ?? 0;
		copies.set(base, n + 1);
		items.push({ key: `r:${base}#${n}`, result, sortAt: result.endedAt ?? at });
	}
	return items
		.map(({ key, result, sortAt }) => {
			const state = entryState(result);
			const active = state === "running" || state === "queued";
			const elapsed = state === "queued" || result.startedAt === undefined ? "" : formatElapsed((result.endedAt ?? input.now) - result.startedAt);
			return { entry: { key, result, state, active, elapsed } as ViewerEntry, sortAt, startedAt: result.startedAt ?? 0 };
		})
		.sort((a, b) => RANK[a.entry.state] - RANK[b.entry.state] || (a.entry.state === "running" ? b.startedAt - a.startedAt : a.entry.state === "queued" ? 0 : b.sortAt - a.sortAt))
		.map((x) => x.entry);
}

const firstLine = (text: string) => text.split("\n")[0];

export function listRow(entry: ViewerEntry): Row {
	const r = entry.result;
	return { text: `${GLYPH[entry.state]} ${r.agent}${entry.elapsed ? ` ${entry.elapsed}` : ""} · ${firstLine(r.task)}`, tone: TONE[entry.state] };
}

export function viewerTitle(entries: readonly ViewerEntry[]): string {
	const count = (s: EntryState) => entries.filter((e) => e.state === s).length;
	const running = count("running");
	const queued = count("queued");
	return `Agents · ${running} running${queued ? ` · ${queued} queued` : ""} · ${entries.length - running - queued} finished`;
}

const abbreviateHome = (dir: string, home?: string) => (home && dir.startsWith(`${home}/`) ? `~${dir.slice(home.length)}` : dir);

/** The detail pane of one run: status, model, usage, task, saved folder, then its thread (with the live text). */
export function entryDetail(entry: ViewerEntry | undefined, width: number, home?: string): Row[] {
	if (!entry) return [];
	const r = entry.result;
	const u = r.usage;
	const header = [
		`${r.agent} · ${entry.state}${entry.elapsed ? ` · ${entry.elapsed}` : ""}`,
		`${r.model ?? "?"}${r.thinking ? ` · ${r.thinking}` : ""}${r.route ? ` · ${r.route}` : ""}`,
		`${u.turns} turns · ↑${formatTokens(u.input + u.cacheRead + u.cacheWrite)} ↓${formatTokens(u.output)} · ${formatCost(u.cost)}`,
		`task: ${firstLine(r.task)}`,
		...(r.artifactsDir ? [`saved: ${abbreviateHome(r.artifactsDir, home)}`] : []),
	];
	const rows = threadRows(header, r.messages, width, r.partial);
	if (entry.state === "failed" && (r.errorMessage || r.stderr)) rows.push({ text: `error: ${firstLine(r.errorMessage || r.stderr)}`, tone: "error" });
	return rows;
}

export interface Selection {
	key: string | undefined;
	index: number;
}

/** Finds the selected run by key after the list changed; if it is gone, keeps the position. */
export function resolveSelection(entries: readonly ViewerEntry[], selection: Selection): Selection {
	if (entries.length === 0) return { key: undefined, index: 0 };
	const found = entries.findIndex((e) => e.key === selection.key);
	const index = found >= 0 ? found : Math.min(Math.max(selection.index, 0), entries.length - 1);
	return { key: entries[index].key, index };
}

export function moveSelection(entries: readonly ViewerEntry[], selection: Selection, delta: number): Selection {
	const current = resolveSelection(entries, selection);
	if (entries.length === 0) return current;
	const index = Math.min(Math.max(current.index + delta, 0), entries.length - 1);
	return { key: entries[index].key, index };
}

/** `follow`: stay on the newest lines as the thread grows. Scrolling up un-pins; reaching the end pins again. */
export interface ScrollState {
	scroll: number;
	follow: boolean;
}

export const scrollView = {
	/** A fresh selection: pinned, so an active run opens on its newest lines (a finished one shows its top). */
	initial: (): ScrollState => ({ scroll: 0, follow: true }),
	by(state: ScrollState, delta: number, total: number, visible: number): ScrollState {
		const max = maxScroll(total, visible);
		const scroll = Math.min(Math.max(state.scroll + delta, 0), max);
		return { scroll, follow: scroll >= max };
	},
	to(_state: ScrollState, where: "top" | "bottom", total: number, visible: number): ScrollState {
		return where === "top" ? { scroll: 0, follow: false } : { scroll: maxScroll(total, visible), follow: true };
	},
};

/** A key of the takeover input line, as the extension maps it from the terminal. */
export type TakeoverKey = { kind: "text"; text: string } | { kind: "backspace" } | { kind: "clear" } | { kind: "submit" } | { kind: "cancel" };

/** The input line open on one run (`key` is the entry key). */
export interface TakeoverState {
	key: string;
	text: string;
}

export const MAX_TAKEOVER_CHARS = 2000;

/** Only a running run whose child still takes input can be steered or aborted; finished runs are not restarted. */
export const canTakeOver = (entry: ViewerEntry | undefined, hasControl: boolean): entry is ViewerEntry => entry?.state === "running" && hasControl;

export const openTakeover = (entry: ViewerEntry | undefined, hasControl: boolean): TakeoverState | undefined => (canTakeOver(entry, hasControl) ? { key: entry.key, text: "" } : undefined);

/** A streaming child is steered (delivered before its next model call); one between turns is followed up. */
export const takeoverKind = (streaming: boolean): "steer" | "follow_up" => (streaming ? "steer" : "follow_up");

/** What the viewer tells the user once Pi answered (or will not answer) a steer / follow-up. */
export function takeoverNotice(kind: "steer" | "follow_up", outcome: CommandOutcome): string {
	const what = kind === "steer" ? "steering message" : "follow-up";
	if (outcome.status === "accepted") return `${kind === "steer" ? "Steering message" : "Follow-up"} accepted by Pi${outcome.disposition ? ` (${outcome.disposition})` : ""}`;
	if (outcome.status === "rejected") return `Pi rejected the ${what}: ${outcome.error}`;
	return "Not delivered: the run ended before Pi answered";
}

/** `x` aborts only when pressed twice on the same run within this time. */
export const ABORT_CONFIRM_MS = 3000;
export const ABORT_PROMPT = "press x again to abort";

/** The run whose abort is waiting for a second `x`, and when the first one was pressed. */
export interface AbortArm {
	key: string;
	at: number;
}

/** The arm that still holds: for the selected run, and not older than the timeout. Any other key or a selection change clears it by not passing it on. */
export const abortArmFor = (armed: AbortArm | undefined, selectedKey: string | undefined, now: number): AbortArm | undefined =>
	armed && selectedKey === armed.key && now - armed.at <= ABORT_CONFIRM_MS ? armed : undefined;

/** One `x` on the selected run: the first arms, a second within the timeout aborts (and disarms). */
export function pressAbort(armed: AbortArm | undefined, key: string, now: number): { armed?: AbortArm; abort: boolean } {
	return abortArmFor(armed, key, now) ? { abort: true } : { armed: { key, at: now }, abort: false };
}

/**
 * One key on the input line. `submit` is the trimmed text to send, and the input closes with it; blank text
 * stays open; `cancel` closes without sending. No `state` means the input is closed.
 */
export function takeoverKey(state: TakeoverState, key: TakeoverKey): { state?: TakeoverState; submit?: string } {
	switch (key.kind) {
		case "text":
			return { state: { ...state, text: (state.text + key.text).slice(0, MAX_TAKEOVER_CHARS) } };
		case "backspace":
			return { state: { ...state, text: Array.from(state.text).slice(0, -1).join("") } };
		case "clear":
			return { state: { ...state, text: "" } };
		case "submit":
			return state.text.trim() ? { submit: state.text.trim() } : { state };
		case "cancel":
			return {};
	}
}

/**
 * The text a key press types: typed or pasted characters. A pasted newline becomes a space (it must not send);
 * control keys and escape sequences (arrows, ctrl+c) are not text.
 */
export function printableText(data: string): string | undefined {
	if (!data || data.startsWith("\x1b")) return undefined;
	const text = data.replace(/\r\n|\r|\n/g, " ");
	return /[\u0000-\u001f\u007f]/.test(text) ? undefined : text;
}

/** The footer while the input line is open: what it will send, with the end of long text kept in view. */
export function takeoverFooter(state: TakeoverState, kind: "steer" | "follow_up", width: number): string {
	const prefix = `${kind === "steer" ? "steer" : "follow-up"} › `;
	const suffix = "▍ · enter send · esc back";
	// renderTwoPane indents the footer by one column.
	const room = Math.max(1, width - 1 - prefix.length - suffix.length);
	const chars = Array.from(state.text);
	const shown = chars.length > room ? `…${chars.slice(-(room - 1)).join("")}` : state.text;
	return `${prefix}${shown}${suffix}`;
}

const BASE_HINTS = ["j/k run", "space/J/K scroll", "g/G top/end", "F thread only"];

/** Key hints; `steer` and `abort` only appear where the selected run can take them. */
export const viewerFooter = (takeover: boolean): string => [...BASE_HINTS, ...(takeover ? ["enter steer", "x abort"] : []), "q close"].join(" · ");

/** The scroll offset to draw: the bottom for a pinned active run, otherwise the stored one kept inside the content. */
export function autoScroll(state: ScrollState, total: number, visible: number, active: boolean): number {
	const max = maxScroll(total, visible);
	return active && state.follow ? max : Math.min(state.scroll, max);
}
