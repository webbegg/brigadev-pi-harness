// Agents card layout: one row per subagent run with right-aligned columns
// (model · thinking, tokens, cost, elapsed). On narrow terminals columns
// drop one at a time, the same way for every row: task text, then model,
// then tokens, then cost. Elapsed always stays.

import { formatCost, formatTokens } from "./cost.ts";
import type { Tone } from "./shell-bar.ts";

export type RunState = "running" | "done" | "failed";

export interface AgentRun {
	id: string;
	agent: string;
	task: string;
	state: RunState;
	model?: string;
	thinking?: string;
	tokens: number;
	cost: number;
	startedAt: number;
	endedAt?: number;
}

/** Finished runs stay on the card this long. */
export const FINISHED_TTL_MS = 60_000;

const GLYPH: Record<RunState, string> = { running: "◐", done: "✓", failed: "✗" };
const TONE: Record<RunState, Tone> = { running: "accent", done: "success", failed: "error" };

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
}

function shortModel(model: string | undefined): string {
	return model ? (model.includes("/") ? model.slice(model.indexOf("/") + 1) : model) : "";
}

export interface CardLine {
	text: string;
	tone: Tone;
}

/** Visible runs: running first, then recently finished, newest first. */
export function visibleRuns(runs: readonly AgentRun[], now: number): AgentRun[] {
	const live = runs.filter((r) => r.state === "running" || (r.endedAt !== undefined && now - r.endedAt < FINISHED_TTL_MS));
	return live.sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || b.startedAt - a.startedAt);
}

export function agentsCard(runs: readonly AgentRun[], options: { width: number; now: number; collapsed: boolean; maxRows?: number; measure?: (s: string) => number }): CardLine[] {
	const measure = options.measure ?? ((s: string) => s.length);
	const shown = visibleRuns(runs, options.now);
	if (shown.length === 0) return [];
	const running = shown.filter((r) => r.state === "running").length;
	const header: CardLine = { text: `Agents · ${running} running · ${shown.length - running} done${options.collapsed ? "  (ctrl+shift+a)" : ""}`, tone: "accent" };
	if (options.collapsed) return [header];

	const maxRows = options.maxRows ?? 6;
	const rows = shown.slice(0, maxRows).map((r) => ({
		run: r,
		cells: {
			model: [shortModel(r.model), r.thinking].filter(Boolean).join(" · "),
			tokens: r.tokens ? formatTokens(r.tokens) : "",
			cost: r.cost ? formatCost(r.cost) : "",
			elapsed: formatElapsed((r.endedAt ?? options.now) - r.startedAt),
		},
	}));
	const columns = ["model", "tokens", "cost", "elapsed"] as const;
	const widthOf = (c: (typeof columns)[number]) => Math.max(0, ...rows.map((r) => measure(r.cells[c])));
	const nameWidth = Math.max(...rows.map((r) => measure(r.run.agent)));

	// Drop columns until the fixed part leaves room for at least a short task text.
	let active = [...columns];
	const fixedWidth = () => 2 + nameWidth + active.reduce((sum, c) => sum + 2 + widthOf(c), 0);
	for (const drop of ["model", "tokens", "cost"] as const) {
		if (fixedWidth() + 12 <= options.width) break;
		active = active.filter((c) => c !== drop);
	}

	const lines: CardLine[] = [header];
	for (const { run, cells } of rows) {
		const right = active.map((c) => cells[c].padStart(widthOf(c))).join("  ");
		const left = `${GLYPH[run.state]} ${run.agent.padEnd(nameWidth)}`;
		const room = options.width - measure(left) - measure(right) - 4;
		const task = room >= 6 ? (measure(run.task) > room ? `${run.task.slice(0, room - 1)}…` : run.task.padEnd(room)) : "";
		lines.push({ text: `${left}  ${task}${task ? "  " : ""}${right}`, tone: TONE[run.state] });
	}
	if (shown.length > maxRows) lines.push({ text: `… ${shown.length - maxRows} more`, tone: "dim" });
	return lines;
}
