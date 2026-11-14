// Todo card model: rows and header for the visible ODD task list. Pure; the
// extension applies theme colors to the tones.

import type { Tone } from "./shell-bar.ts";

export const TODO_STATUSES = ["pending", "in_progress", "done", "blocked", "dropped"] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface Todo {
	id: string;
	text: string;
	status: TodoStatus;
	note?: string;
}

export const TODO_GLYPH: Record<TodoStatus, string> = { pending: "○", in_progress: "◐", done: "✓", blocked: "⊘", dropped: "✕" };
const TONE: Record<TodoStatus, Tone> = { pending: "text", in_progress: "accent", done: "success", blocked: "warning", dropped: "dim" };

/** A list goes stale after this many agent runs without a todo update while work is open. */
export const STALE_AFTER_RUNS = 2;

export const isOpen = (t: Todo) => t.status === "pending" || t.status === "in_progress" || t.status === "blocked";

export interface CardRow {
	text: string;
	tone: Tone;
}

export interface TodoCard {
	header: CardRow;
	rows: CardRow[];
}

function row(t: Todo): CardRow {
	return { text: `${TODO_GLYPH[t.status]} ${t.id} ${t.text}${t.note ? ` · ${t.note}` : ""}`, tone: TONE[t.status] };
}

/**
 * Builds the card. Collapsed shows only the task in progress (or the next
 * pending one). Finished tasks fold into one "✓ N done" row once the list is
 * longer than maxRows.
 */
export function todoCard(todos: readonly Todo[], options: { collapsed: boolean; staleRuns: number; maxRows?: number }): TodoCard | undefined {
	const visible = todos.filter((t) => t.status !== "dropped");
	if (visible.length === 0 || !todos.some(isOpen)) return undefined;
	const done = visible.filter((t) => t.status === "done").length;
	const stale = options.staleRuns >= STALE_AFTER_RUNS;
	const header: CardRow = { text: `Todo ${done}/${visible.length}${stale ? ` · stale ${options.staleRuns} runs` : ""}`, tone: stale ? "warning" : "accent" };

	if (options.collapsed) {
		const current = visible.find((t) => t.status === "in_progress") ?? visible.find((t) => t.status === "pending") ?? visible.find(isOpen);
		return { header, rows: current ? [row(current)] : [] };
	}

	const maxRows = options.maxRows ?? 10;
	if (visible.length <= maxRows || done === 0) return { header, rows: visible.slice(0, maxRows).map(row) };
	const open = visible.filter((t) => t.status !== "done");
	return { header, rows: [{ text: `✓ ${done} done`, tone: "success" }, ...open.slice(0, maxRows - 1).map(row)] };
}

/** Ids in `after` that are new or whose status, text, or note differ from `before`, in list order. */
export function changedIds(before: readonly Todo[], after: readonly Todo[]): string[] {
	const prev = new Map(before.map((t) => [t.id, t]));
	return after
		.filter((t) => {
			const p = prev.get(t.id);
			return !p || p.status !== t.status || p.text !== t.text || p.note !== t.note;
		})
		.map((t) => t.id);
}

/**
 * One transcript line for a todo call: progress, then what changed. The card
 * holds the full list, so the row never repeats it. Only the task in progress
 * keeps its text. Undefined when the result predates recorded changes.
 */
export function todoDeltaLine(after: readonly Todo[], changed: readonly string[] | undefined): CardRow | undefined {
	if (!changed) return undefined;
	const visible = after.filter((t) => t.status !== "dropped");
	const done = visible.filter((t) => t.status === "done").length;
	const ids = new Set(changed);
	const parts = after.filter((t) => ids.has(t.id)).map((t) => `${TODO_GLYPH[t.status]} ${t.id}${t.status === "in_progress" ? ` ${t.text}` : ""}`);
	return { text: [`Todo ${done}/${visible.length}`, ...parts].join(" · "), tone: "accent" };
}
