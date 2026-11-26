// The brigadev bus channels this add-on reads, and the payload fields it uses. The harness defines them in lib/bus.ts;
// the add-on keeps its own copy so it never imports harness code, and tests/t3-contract.test.ts fails when the two drift.

export const CHANNELS = {
	phase: "brigadev:phase",
	todo: "brigadev:todo",
	check: "brigadev:check",
} as const;

/** brigadev:phase: the loop's inferred phase (a full snapshot each time). */
export interface PhaseSnapshot {
	phase: string;
	running: boolean;
}

/** brigadev:todo: the whole todo list. */
export interface TodoSnapshot {
	todos: Array<{ id: string; status: string }>;
}

/** brigadev:check: one finished `check` run. */
export interface CheckSnapshot {
	outcome: string;
	counts?: { pass?: number; fail?: number; skipped?: number };
}
