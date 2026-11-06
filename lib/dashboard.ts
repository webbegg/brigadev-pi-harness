// Launch dashboard: the entry list, the launch condition, and the full-screen
// layout. Pure: painting and width measuring come from the caller's Painter,
// and nothing here imports Pi or the TUI.

import { windowStart, type Painter } from "./two-pane.ts";
import { workflowId, type Workflow } from "./workflows.ts";

export type DashboardAction =
	| { kind: "workflow"; query: string }
	| { kind: "command"; command: string }
	| { kind: "chat" }
	| { kind: "quit" };

export interface DashboardEntry {
	id: string;
	icon: string;
	label: string;
	/** One lowercase letter that runs the row directly. */
	key?: string;
	/** Shown at the end of the row instead of the key (the Chat row shows Enter). */
	keyLabel?: string;
	action: DashboardAction;
}

export const DASHBOARD_COMMAND = "brigadev:dashboard";
export const DASHBOARD_HINT = "key or ↑↓ Enter · Esc chat · q quit";

const DEFAULT_ICON = "◇";
const ENTER_LABEL = "↵";
const CURSOR = "›";
const ROW_WIDTH = 44;
const MIN_GAP = 2;
/** Terminal rows from which the title and hint get their own lines around the list. */
const FULL_CHROME_HEIGHT = 10;

/** Icons for the shipped workflows, by file id; other workflows get a neutral one. Plain BMP symbols, no Nerd Font glyphs. */
const WORKFLOW_ICONS: Record<string, string> = {
	"new-feature": "✦",
	"bug-fix": "✖",
	review: "◎",
	"open-pr": "↗",
	"pr-feedback": "✎",
	"create-issue": "◈",
	"ui-change": "▣",
	refactor: "↻",
	"upgrade-dependencies": "⇧",
};

const TOOLS: DashboardEntry[] = [
	{ id: "changes", icon: "±", label: "Changes", key: "g", action: { kind: "command", command: "/brigadev:changes" } },
	{ id: "runs", icon: "≡", label: "Agents history", key: "a", action: { kind: "command", command: "/brigadev:runs" } },
	{ id: "profile", icon: "⚙", label: "Model profile", key: "m", action: { kind: "command", command: "/brigadev:profile use" } },
	{ id: "commands", icon: "⌘", label: "Commands", key: "k", action: { kind: "command", command: "/brigadev:commands" } },
	{ id: "chat", icon: "❯", label: "Chat", keyLabel: ENTER_LABEL, action: { kind: "chat" } },
	{ id: "quit", icon: "✕", label: "Quit", key: "q", action: { kind: "quit" } },
];

/** Workflows in the order given (keyed or not), then the tools. A workflow starts through `/brigadev:start <key or file id>`. */
export function buildEntries(workflows: readonly Workflow[]): DashboardEntry[] {
	const rows = workflows.map((workflow): DashboardEntry => {
		const id = workflowId(workflow);
		return { id, icon: WORKFLOW_ICONS[id] ?? DEFAULT_ICON, label: workflow.name, key: workflow.key, action: { kind: "workflow", query: workflow.key ?? id } };
	});
	return [...rows, ...TOOLS];
}

/** The row a single typed letter runs, if any. */
export function entryForKey(entries: readonly DashboardEntry[], data: string): DashboardEntry | undefined {
	return data.length === 1 ? entries.find((entry) => entry.key === data) : undefined;
}

export function moveSelection(selected: number, delta: number, length: number): number {
	return length > 0 ? (((selected + delta) % length) + length) % length : 0;
}

/** Pi flags that take the next argument as their value (cli.md, Pi 1.5). */
const VALUE_FLAGS = new Set([
	"--provider", "--model", "--api-key", "--thinking", "--models",
	"--session", "--session-id", "--fork", "--session-dir", "-n", "--name",
	"-t", "--tools", "-xt", "--exclude-tools",
	"-e", "--extension", "--skill", "--prompt-template", "--theme", "--use-theme",
	"--system-prompt", "--append-system-prompt", "--tui-mode", "--mode",
]);

/**
 * True when the command line carries a message or an `@file`, i.e. Pi will
 * send a first prompt. Takes the arguments after the script (`process.argv.slice(2)`).
 * Pi exposes no other signal to extensions. Flags are skipped (with their value
 * for the documented value flags); the first other word, or any word after
 * `--`, is a prompt. An extension flag that takes a value is not known here, so
 * its value counts as a prompt: the dashboard stays away rather than cover a
 * real prompt.
 */
export function hasInitialPrompt(args: readonly string[]): boolean {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return i + 1 < args.length;
		if (arg.length > 1 && arg.startsWith("-")) {
			if (VALUE_FLAGS.has(arg)) i++;
			continue;
		}
		return true;
	}
	return false;
}

/** True when the session branch already holds a message (a resumed or continued session). */
export const hasMessageEntries = (branch: readonly { type?: unknown }[]): boolean => branch.some((entry) => entry.type === "message");

export interface LaunchConditions {
	/** `session_start` reason. */
	reason: string;
	/** `ctx.mode`. */
	mode: string;
	branchHasMessages: boolean;
	hasInitialPrompt: boolean;
	/** The `ui.dashboard` setting. */
	enabled: boolean;
	/** A brigadev subagent process. */
	child: boolean;
}

/** The dashboard opens by itself only on a fresh interactive startup with nothing else to do. */
export const shouldShowDashboard = (c: LaunchConditions): boolean =>
	c.reason === "startup" && c.mode === "tui" && !c.branchHasMessages && !c.hasInitialPrompt && c.enabled && !c.child;

export interface DashboardInput {
	width: number;
	height: number;
	title: string;
	/** Shown after the title, dimmed (the repo name). */
	subtitle?: string;
	entries: readonly DashboardEntry[];
	selected: number;
	hint?: string;
}

const shownKey = (entry: DashboardEntry): string => entry.keyLabel ?? entry.key ?? "";

/**
 * Exactly `height` lines of `width` columns: the list centered both ways, with
 * a title above and a hint below when the terminal is tall enough. Rows are
 * separated by a blank line when they fit that way, else sit on consecutive
 * lines, else scroll around the selection.
 */
export function renderDashboard(input: DashboardInput, p: Painter): string[] {
	const width = Math.max(1, input.width);
	const height = Math.max(0, input.height);
	if (height === 0) return [];
	const { entries } = input;
	const selected = Math.max(0, Math.min(entries.length - 1, input.selected));

	const full = height >= FULL_CHROME_HEIGHT;
	const chrome = full ? 4 : height >= 3 ? 1 : 0;
	const available = Math.max(1, height - chrome);
	const spaced = entries.length * 2 - 1 <= available;
	const visible = Math.min(entries.length, spaced ? entries.length : available);
	const start = windowStart(selected, entries.length, visible);

	const widest = (measure: (entry: DashboardEntry) => number) => entries.reduce((max, entry) => Math.max(max, measure(entry)), 1);
	const iconWidth = widest((entry) => p.measure(entry.icon));
	const keyWidth = widest((entry) => p.measure(shownKey(entry)));
	const fixed = 2 + iconWidth + 2 + keyWidth;
	const rowWidth = Math.min(width, Math.max(ROW_WIDTH, fixed + MIN_GAP + widest((entry) => p.measure(entry.label))));
	const lead = " ".repeat(Math.floor((width - rowWidth) / 2));

	const row = (index: number): string => {
		const entry = entries[index];
		const active = index === selected;
		const label = p.truncate(entry.label, Math.max(0, rowWidth - fixed - MIN_GAP));
		const key = shownKey(entry);
		const gap = " ".repeat(Math.max(1, rowWidth - fixed - p.measure(label)));
		const icon = entry.icon + " ".repeat(iconWidth - p.measure(entry.icon));
		const keyText = " ".repeat(keyWidth - p.measure(key)) + key;
		return [
			lead,
			active ? p.paint("accent", p.bold(CURSOR)) : " ",
			" ",
			p.paint(active ? "accent" : "muted", icon),
			"  ",
			active ? p.paint("accent", p.bold(label)) : p.paint("text", label),
			gap,
			p.paint(active ? "accent" : "dim", keyText),
		].join("");
	};

	const centered = (text: string): string => {
		const cut = p.truncate(text, width);
		return " ".repeat(Math.max(0, Math.floor((width - p.measure(cut)) / 2))) + cut;
	};

	const content: string[] = [];
	if (full) {
		const subtitle = input.subtitle ? p.paint("dim", ` · ${input.subtitle}`) : "";
		content.push(centered(p.paint("accent", p.bold(input.title)) + subtitle), "");
	}
	for (let i = 0; i < visible; i++) {
		if (spaced && i > 0) content.push("");
		content.push(row(start + i));
	}
	if (chrome > 0) {
		if (full) content.push("");
		content.push(centered(p.paint("dim", input.hint ?? DASHBOARD_HINT)));
	}

	const top = Math.floor((height - content.length) / 2);
	const lines = [...Array<string>(top).fill(""), ...content];
	while (lines.length < height) lines.push("");
	return lines.map((line) => {
		const cut = p.truncate(line, width);
		return cut + " ".repeat(Math.max(0, width - p.measure(cut)));
	});
}
