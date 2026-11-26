// What the add-on shows as T3 Code status chips (Pi's ctx.ui.setStatus, which T3 renders per thread): the loop phase
// while a run is active, the todo progress (T3 does not show the harness's todo widget), and the last check. Subagents
// already have the harness's own `brigadev-agents` chip. Pure: bus snapshots in, chip texts out; undefined clears a chip.

import type { CheckSnapshot, PhaseSnapshot, TodoSnapshot } from "./channels.ts";

export const STATUS_KEYS = {
	phase: "brigadev-t3-phase",
	todo: "brigadev-t3-todo",
	check: "brigadev-t3-check",
} as const;
export type StatusKey = (typeof STATUS_KEYS)[keyof typeof STATUS_KEYS];

const SETTLED_TODO = new Set(["done", "dropped"]);

export function phaseText(phase: PhaseSnapshot | undefined): string | undefined {
	if (!phase?.running || !phase.phase || phase.phase === "idle") return undefined;
	return `brigadev ▸ ${phase.phase}`;
}

/** Done (or dropped) over total, while any item is open. */
export function todoText(todo: TodoSnapshot | undefined): string | undefined {
	const todos = Array.isArray(todo?.todos) ? todo.todos : [];
	const settled = todos.filter((t) => SETTLED_TODO.has(t.status)).length;
	if (todos.length === 0 || settled === todos.length) return undefined;
	return `todo ${settled}/${todos.length}`;
}

export function checkText(check: CheckSnapshot | undefined): string | undefined {
	if (!check) return undefined;
	const { pass, fail } = check.counts ?? {};
	if (check.outcome === "pass") return pass === undefined ? "check ✓" : `check ✓ ${pass} passed`;
	if (check.outcome === "fail") return fail ? `check ✗ ${fail} failed` : "check ✗";
	return "check ?";
}

/** The add-on's state: the latest snapshot of each channel. */
export interface StatusState {
	phase?: PhaseSnapshot;
	todo?: TodoSnapshot;
	check?: CheckSnapshot;
}

/** Every chip's text for `state`. */
export function statusTexts(state: StatusState): Record<StatusKey, string | undefined> {
	return {
		[STATUS_KEYS.phase]: phaseText(state.phase),
		[STATUS_KEYS.todo]: todoText(state.todo),
		[STATUS_KEYS.check]: checkText(state.check),
	};
}
