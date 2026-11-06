// Launch dashboard: the entry list, the launch condition, and the full-screen
// layout. Pure: painting and width measuring come from the caller's Painter,
// and nothing here imports Pi or the TUI.

import { pad, windowStart, type Painter } from "./two-pane.ts";
import { workflowGroup, workflowId, type Workflow } from "./workflows.ts";

/** What closes the dashboard and runs. */
export type DashboardAction =
	| { kind: "workflow"; query: string }
	| { kind: "command"; command: string }
	/** Turns the automatic start off when it is on, and on when it is off (decided when the row runs). */
	| { kind: "toggle-dashboard" }
	| { kind: "chat" }
	| { kind: "quit" };

/** What a row does: run something, or open a group's rows (the dashboard stays open). */
export type EntryAction = DashboardAction | { kind: "group"; id: string };

export interface DashboardEntry {
	id: string;
	icon: string;
	label: string;
	/** One lowercase letter (or a digit, for a group) that runs the row directly. */
	key?: string;
	/** Shown at the end of the row instead of the key (the Chat row shows Enter, a group its digit and ›). */
	keyLabel?: string;
	action: EntryAction;
}

/** A category: a row on the top level, and its own list of rows. */
export interface DashboardGroup {
	id: string;
	label: string;
	icon: string;
	/** A digit, for the first nine groups. */
	key?: string;
	items: DashboardEntry[];
}

export interface DashboardMenu {
	/** In display order. */
	groups: DashboardGroup[];
	/** The top level: one row per group, then Commands, Chat, Quit. */
	top: DashboardEntry[];
}

export const DASHBOARD_COMMAND = "brigadev:dashboard";
export const DASHBOARD_HINT = "key or ↑↓ Enter · Esc chat · q quit";
export const GROUP_HINT = "key or ↑↓ Enter · ← or Esc back · q quit";

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

const command = (id: string, icon: string, label: string, key: string, text: string): DashboardEntry => ({ id, icon, label, key, action: { kind: "command", command: text } });

/** Tool rows by the group they sit in (after that group's workflows). Their letters are the workflows' RESERVED_KEYS. */
const GROUP_TOOLS: Record<string, DashboardEntry[]> = {
	inspect: [
		command("changes", "±", "Changes", "g", "/brigadev:changes"),
		command("runs", "≡", "Agents history", "a", "/brigadev:runs"),
		command("cost", "$", "Cost", "c", "/brigadev:cost"),
		command("usage", "◔", "Usage", "s", "/brigadev:usage"),
		command("status", "●", "Status", "t", "/brigadev:status"),
		command("panel", "▯", "Panel", "o", "/brigadev:panel"),
	],
	settings: [
		command("profile", "◇", "Model profile", "m", "/brigadev:profile use"),
		// Status only: the permission mode (and the yolo switch with it) stays a typed command.
		command("mode", "⚑", "Permission mode", "e", "/brigadev:mode status"),
		{ id: "dashboard", icon: "◐", label: "Launch dashboard on/off", key: "h", action: { kind: "toggle-dashboard" } },
		command("doctor", "✚", "Doctor", "y", "/brigadev:doctor"),
	],
};

/** Rows under the groups on the top level. */
const TOP_TOOLS: DashboardEntry[] = [
	command("commands", "⌘", "Commands", "k", "/brigadev:commands"),
	{ id: "chat", icon: "❯", label: "Chat", keyLabel: ENTER_LABEL, action: { kind: "chat" } },
	{ id: "quit", icon: "✕", label: "Quit", key: "q", action: { kind: "quit" } },
];

const GROUP_ICONS: Record<string, string> = { build: "⊞", ship: "⇡", inspect: "◉", settings: "⚙" };
/** Digits of the shipped groups; new categories take the next ones. */
const GROUP_DIGITS: Record<string, string> = { build: "1", ship: "2", inspect: "3", settings: "4" };
const FIRST_CUSTOM_DIGIT = 5;
const LAST_DIGIT = 9;

const workflowRow = (workflow: Workflow): DashboardEntry => {
	const id = workflowId(workflow);
	return { id, icon: WORKFLOW_ICONS[id] ?? DEFAULT_ICON, label: workflow.name, key: workflow.key, action: { kind: "workflow", query: workflow.name } };
};

/**
 * The groups in display order (Build, Review & ship, any new categories, Inspect, Settings), each with its workflows
 * in the order given (keyed or not) and then its tools; a group with no rows is left out. A new category (a `group:`
 * name that is none of the shipped ones) takes the next free digit, 5 to 9, in order of first appearance. The top level
 * is a row per group, then Commands, Chat, Quit. A workflow starts through `/brigadev:start <name>`: the name is the
 * only identity that stays unique after the layers merge (file ids and keys can repeat or be absent).
 */
export function buildMenu(workflows: readonly Workflow[]): DashboardMenu {
	const byGroup = new Map<string, { label: string; rows: DashboardEntry[] }>();
	for (const workflow of workflows) {
		const { id, label } = workflowGroup(workflow);
		const bucket = byGroup.get(id) ?? { label, rows: [] };
		bucket.rows.push(workflowRow(workflow));
		byGroup.set(id, bucket);
	}
	const shipped = (id: string, label: string): DashboardGroup => ({ id, label, icon: GROUP_ICONS[id], key: GROUP_DIGITS[id], items: [] });
	const order = [shipped("build", "Build"), shipped("ship", "Review & ship")];
	const custom = [...byGroup.entries()].filter(([id]) => !Object.hasOwn(GROUP_DIGITS, id));
	custom.forEach(([id, { label }], index) => {
		const digit = FIRST_CUSTOM_DIGIT + index;
		order.push({ id, label, icon: DEFAULT_ICON, key: digit <= LAST_DIGIT ? String(digit) : undefined, items: [] });
	});
	order.push(shipped("inspect", "Inspect"), shipped("settings", "Settings"));

	const groups = order
		.map((group) => ({ ...group, items: [...(byGroup.get(group.id)?.rows ?? []), ...(Object.hasOwn(GROUP_TOOLS, group.id) ? GROUP_TOOLS[group.id] : [])] }))
		.filter((group) => group.items.length > 0);
	const groupRows = groups.map((group): DashboardEntry => ({
		id: `group:${group.id}`,
		icon: group.icon,
		label: group.label,
		key: group.key,
		keyLabel: group.key ? `${group.key} ${CURSOR}` : CURSOR,
		action: { kind: "group", id: group.id },
	}));
	return { groups, top: [...groupRows, ...TOP_TOOLS] };
}

/** Every row on any level; a key works from anywhere. A group's digit comes from its row on the top level. */
export const allEntries = (menu: DashboardMenu): DashboardEntry[] => [...menu.groups.flatMap((group) => group.items), ...menu.top];

/** The row a single typed letter runs, if any. */
export function entryForKey(entries: readonly DashboardEntry[], data: string): DashboardEntry | undefined {
	return data.length === 1 ? entries.find((entry) => entry.key === data) : undefined;
}

/** Moves the selection by `delta`, wrapping around at both ends. */
export function wrapSelection(selected: number, delta: number, length: number): number {
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
	/** The open group's name, shown above its rows (when the terminal has room for it). */
	heading?: string;
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
	const headed = input.heading !== undefined && height >= 3;
	const chrome = (full ? 4 : height >= 3 ? 1 : 0) + (headed ? (full ? 2 : 1) : 0);
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
	if (headed) {
		content.push(centered(p.paint("accent", p.bold(input.heading!))));
		if (full) content.push("");
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
	return lines.map((line) => pad(p, line, width));
}
