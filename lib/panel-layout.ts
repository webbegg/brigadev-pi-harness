// Side panel layout: Todos, Agents, Changes, and Session as dense rows in a
// fixed-width block with a left border. Pure: plain section data in, lines
// out. Painting, measuring, and the solid background come from the caller.

import { formatElapsed, visibleRuns, type AgentRun, type RunState } from "./agents-card.ts";
import { formatCost } from "./cost.ts";
import { statusTone, totals, type ChangeEntry } from "./git-changes.ts";
import { contextGauge, type Tone } from "./shell-bar.ts";
import { todoCard, type Todo } from "./todo-card.ts";
import type { Painter } from "./two-pane.ts";

export const PANEL_WIDTH = 44;
/** The panel only shows on terminals at least this wide. */
export const MIN_TERMINAL_WIDTH = 140;

const BORDER = "│";
const MAX_CHANGE_ROWS = 8;
const MAX_AGENT_ROWS = 6;
const MAX_TODO_ROWS = 10;

export interface PanelPainter extends Painter {
	/** Gives a whole line a solid background so nothing underneath shows through. */
	fill(text: string): string;
}

export interface SessionInfo {
	model?: string;
	thinking?: string;
	contextPercent?: number | null;
	cost?: { cost: number; apiEquivalent: boolean };
	usage?: { text: string; tone: Tone };
	profile?: string;
	yolo?: boolean;
}

export interface PanelInput {
	width: number;
	/** Most lines the panel may return. */
	height: number;
	now: number;
	todos: readonly Todo[];
	runs: readonly AgentRun[];
	/** Working-tree changes with counts, or undefined when git is unavailable. */
	changes: readonly ChangeEntry[] | undefined;
	session: SessionInfo;
}

interface Part {
	text: string;
	tone: Tone;
	bold?: boolean;
}

interface Row {
	left: Part[];
	right?: Part[];
}

interface Section {
	name: string;
	summary: Part[];
	items: Row[];
	/** Rows already left out before any height squeeze; shown in the fold row. */
	hidden: number;
	/** Appended to the fold row, e.g. " · alt+g". */
	hint: string;
}

const RUN_GLYPH: Record<RunState, string> = { running: "◐", done: "✓", failed: "✗" };
const RUN_TONE: Record<RunState, Tone> = { running: "accent", done: "success", failed: "error" };

const text = (value: string, tone: Tone = "text"): Row => ({ left: [{ text: value, tone }] });
const idle = (value: string): Row => text(value, "dim");

function clip(value: string, room: number, painter: Painter): string {
	if (room <= 0) return "";
	if (painter.measure(value) <= room) return value;
	return room === 1 ? "…" : `${painter.truncate(value, room - 1)}…`;
}

/** Keeps the tail of a path, which is the part that tells files apart. */
function clipPathStart(path: string, room: number, painter: Painter): string {
	if (room <= 0) return "";
	if (painter.measure(path) <= room) return path;
	let tail = path;
	while (tail.length > 1 && painter.measure(tail) + 1 > room) tail = tail.slice(1);
	return room === 1 ? "…" : `…${tail}`;
}

function todosSection(todos: readonly Todo[]): Section {
	const counted = todos.filter((t) => t.status !== "dropped");
	if (counted.length === 0) return { name: "TODOS", summary: [], items: [idle("none")], hidden: 0, hint: "" };
	const done = counted.filter((t) => t.status === "done").length;
	const card = todoCard(todos, { collapsed: false, staleRuns: 0, maxRows: MAX_TODO_ROWS });
	const items = card ? card.rows.map((r) => text(r.text, r.tone)) : [text("all done", "success")];
	return { name: "TODOS", summary: [{ text: `${done}/${counted.length}`, tone: "muted" }], items, hidden: 0, hint: "" };
}

function agentsSection(runs: readonly AgentRun[], now: number): Section {
	const shown = visibleRuns(runs, now);
	if (shown.length === 0) return { name: "AGENTS", summary: [], items: [idle("none · alt+a history")], hidden: 0, hint: " · alt+a" };
	const running = shown.filter((r) => r.state === "running").length;
	const items: Row[] = shown.slice(0, MAX_AGENT_ROWS).map((r) => ({
		left: [
			{ text: `${RUN_GLYPH[r.state]} ${r.agent}`, tone: RUN_TONE[r.state] },
			{ text: ` ${r.task}`, tone: "muted" },
		],
		right: [{ text: formatElapsed((r.endedAt ?? now) - r.startedAt), tone: "dim" }],
	}));
	return { name: "AGENTS", summary: [{ text: `${running} running`, tone: running > 0 ? "accent" : "dim" }], items, hidden: shown.length - items.length, hint: " · alt+a" };
}

function changeRow(entry: ChangeEntry, room: number, painter: Painter): Row {
	const tone = statusTone(entry.status);
	let right: Part[] | undefined;
	if (entry.binary) right = [{ text: "bin", tone: "dim" }];
	else if (entry.added !== undefined || entry.deleted !== undefined) {
		right = [
			{ text: `+${entry.added ?? 0}`, tone: "success" },
			{ text: " ", tone: "text" },
			{ text: `−${entry.deleted ?? 0}`, tone: "error" },
		];
	}
	const rightWidth = right ? painter.measure(right.map((p) => p.text).join("")) + 1 : 0;
	const path = clipPathStart(entry.path, room - 2 - rightWidth, painter);
	return { left: [{ text: `${entry.status} `, tone }, { text: path, tone: "text" }], right };
}

function changesSection(changes: readonly ChangeEntry[] | undefined, room: number, painter: Painter): Section {
	if (!changes) return { name: "CHANGES", summary: [], items: [idle("not a git repo")], hidden: 0, hint: " · alt+g" };
	if (changes.length === 0) return { name: "CHANGES", summary: [], items: [idle("clean")], hidden: 0, hint: " · alt+g" };
	const sum = totals(changes);
	const summary: Part[] = [
		{ text: `${sum.files} ${sum.files === 1 ? "file" : "files"} `, tone: "muted" },
		{ text: `+${sum.added}`, tone: "success" },
		{ text: " ", tone: "text" },
		{ text: `−${sum.deleted}`, tone: "error" },
	];
	const items = changes.slice(0, MAX_CHANGE_ROWS).map((e) => changeRow(e, room, painter));
	return { name: "CHANGES", summary, items, hidden: changes.length - items.length, hint: " · alt+g" };
}

function sessionSection(info: SessionInfo): Section {
	const items: Row[] = [];
	items.push(info.model ? text(info.thinking ? `${info.model} · ${info.thinking}` : info.model) : idle("no model"));
	const gauge = contextGauge(info.contextPercent);
	items.push(text(gauge.text, gauge.tone));
	if (info.cost && info.cost.cost > 0) items.push(text(`${formatCost(info.cost.cost)}${info.cost.apiEquivalent ? " API-eq" : ""}`, "muted"));
	if (info.usage) items.push(text(`◷ ${info.usage.text}`, info.usage.tone));
	if (info.profile) items.push(text(`profile ${info.profile}`, "dim"));
	if (info.yolo) items.push(text("🚀 yolo", "warning"));
	return { name: "SESSION", summary: [], items, hidden: 0, hint: "" };
}

/** Paints one row into exactly `room` columns: the right cells stay, the left side gives way. */
function fitRow(row: Row, room: number, painter: PanelPainter): string {
	let right = row.right ?? [];
	const rightWidth = painter.measure(right.map((p) => p.text).join(""));
	if (right.length && rightWidth >= room - 1) right = [];
	const rightRoom = right.length ? rightWidth + 1 : 0;
	const leftRoom = room - rightRoom;
	const paint = (part: Part, value: string) => (part.bold ? painter.bold(painter.paint(part.tone, value)) : painter.paint(part.tone, value));

	let used = 0;
	let line = "";
	for (const part of row.left) {
		const available = leftRoom - used;
		if (available <= 0) break;
		const value = clip(part.text, available, painter);
		if (!value) continue;
		line += paint(part, value);
		used += painter.measure(value);
	}
	if (right.length) {
		line += " ".repeat(Math.max(1, room - used - rightWidth));
		for (const part of right) line += paint(part, part.text);
		used = room;
	}
	return line + " ".repeat(Math.max(0, room - used));
}

function headerRow(section: Section): Row {
	return { left: [{ text: "▾ ", tone: "dim" }, { text: section.name, tone: "accent", bold: true }], right: section.summary.length ? section.summary : undefined };
}

/** Rows a section shows with `alloc` lines: all of them, or fewer plus one fold row. */
function bodyRows(section: Section, alloc: number): Row[] {
	const wanted = section.items.length + (section.hidden > 0 ? 1 : 0);
	const fold = (count: number): Row => text(`… ${count} more${section.hint}`, "dim");
	if (alloc >= wanted) return section.hidden > 0 ? [...section.items, fold(section.hidden)] : section.items;
	const shown = Math.max(0, alloc - 1);
	return [...section.items.slice(0, shown), fold(section.hidden + section.items.length - shown)];
}

/**
 * Squeezes sections into the height. Changes fold first, then Session, and
 * Agents and Todos give up rows last. Each section keeps its header and at
 * least one row (a fold row when it is cut).
 */
function allocate(sections: readonly Section[], height: number): number[] {
	const alloc = sections.map((s) => s.items.length + (s.hidden > 0 ? 1 : 0));
	let excess = alloc.reduce((a, b) => a + b, 0) + sections.length - height;
	for (const name of ["CHANGES", "SESSION", "AGENTS", "TODOS"]) {
		if (excess <= 0) break;
		const index = sections.findIndex((s) => s.name === name);
		const cut = Math.min(excess, alloc[index] - 1);
		alloc[index] -= cut;
		excess -= cut;
	}
	return alloc;
}

export function renderPanel(input: PanelInput, painter: PanelPainter): string[] {
	const { width, height } = input;
	if (width <= 0 || height <= 0) return [];
	// Border, a space on each side of the text.
	const room = Math.max(0, width - 3);
	const sections = [todosSection(input.todos), agentsSection(input.runs, input.now), changesSection(input.changes, room, painter), sessionSection(input.session)];
	const alloc = allocate(sections, height);

	const border = painter.paint("borderMuted", BORDER);
	const line = (row: Row) => painter.fill(`${border} ${fitRow(row, room, painter)} `);
	const lines: string[] = [];
	sections.forEach((section, i) => {
		lines.push(line(headerRow(section)));
		for (const row of bodyRows(section, alloc[i])) lines.push(line(row));
	});
	return lines.slice(0, height);
}
