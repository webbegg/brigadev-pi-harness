// What the launch dashboard does, as pure functions of plain inputs, so it runs
// in tests without the Pi packages that extensions/dashboard.ts imports. The
// extension supplies the key matcher, the Pi calls, and the timers; this file
// decides.

import { allEntries, DASHBOARD_HINT, entryForKey, GROUP_HINT, hasInitialPrompt, hasMessageEntries, shouldShowDashboard, wrapSelection, type DashboardAction, type DashboardEntry, type DashboardMenu, type EntryAction } from "./dashboard.ts";
import { isChildSession, readSettings, type BrigadevSettings } from "./runtime.ts";

export const START_COMMAND = "/brigadev:start";
/** `BRIGADEV_DASHBOARD=0` (or `off`/`false`) skips the automatic open, whatever the settings say. */
export const DASHBOARD_ENV = "BRIGADEV_DASHBOARD";

/** Which list is showing (the top level, or one group's rows) and the selected row in it. */
export type DashboardState = { level: "top"; selected: number } | { level: "group"; group: string; selected: number };

export const startState: DashboardState = { level: "top", selected: 0 };

export type DashboardKey = "escape" | "enter" | "up" | "down" | "left" | "right" | "ctrl+n" | "ctrl+p";
/** True when the raw terminal input is that key. The extension passes Pi's `matchesKey`, which also knows the Kitty protocol. */
export type KeyMatcher = (data: string, key: DashboardKey) => boolean;

const LEGACY_SEQUENCES: Record<DashboardKey, readonly string[]> = {
	escape: ["\x1b"],
	enter: ["\r", "\n"],
	up: ["\x1b[A", "\x1bOA"],
	down: ["\x1b[B", "\x1bOB"],
	left: ["\x1b[D", "\x1bOD"],
	right: ["\x1b[C", "\x1bOC"],
	"ctrl+n": ["\x0e"],
	"ctrl+p": ["\x10"],
};

/** Plain terminal sequences only; the default for tests and callers without a terminal library. */
export const legacyKeys: KeyMatcher = (data, key) => LEGACY_SEQUENCES[key].includes(data);

/** What the dashboard shows for a state: the rows, the open group's name, and the hint. */
export function viewFor(menu: DashboardMenu, state: DashboardState): { entries: readonly DashboardEntry[]; heading?: string; hint: string } {
	const group = state.level === "group" ? menu.groups.find((candidate) => candidate.id === state.group) : undefined;
	return group ? { entries: group.items, heading: group.label, hint: GROUP_HINT } : { entries: menu.top, hint: DASHBOARD_HINT };
}

const openGroup = (menu: DashboardMenu, id: string): { state: DashboardState } | undefined => (menu.groups.some((group) => group.id === id) ? { state: { level: "group", group: id, selected: 0 } } : undefined);

/** The top level with the selection on the group's own row. */
const backTo = (menu: DashboardMenu, id: string): DashboardState => ({ level: "top", selected: Math.max(0, menu.top.findIndex((entry) => entry.action.kind === "group" && entry.action.id === id)) });

/**
 * One key press. On the top level Esc leaves for the chat; inside a group ← and Esc go back to the top level, on
 * the group's row. Enter (or →, on a group row) opens a group or runs the selected row; the arrows and ctrl+n/ctrl+p
 * move (wrapping). A row's own letter runs it and a group's digit opens it, from either level. `done` is set when
 * the dashboard should close with that action.
 */
export function reduceKey(state: DashboardState, data: string, menu: DashboardMenu, matches: KeyMatcher = legacyKeys): { state: DashboardState; done?: DashboardAction } {
	const { entries } = viewFor(menu, state);
	const openId = state.level === "group" && entries !== menu.top ? state.group : undefined;
	const run = (action: EntryAction | undefined): { state: DashboardState; done?: DashboardAction } => {
		if (action?.kind === "group") return openGroup(menu, action.id) ?? { state };
		return { state, done: action ?? { kind: "chat" } };
	};

	if (matches(data, "escape") || matches(data, "left")) {
		if (openId !== undefined) return { state: backTo(menu, openId) };
		return matches(data, "escape") ? { state, done: { kind: "chat" } } : { state };
	}
	if (matches(data, "enter")) return run(entries[state.selected]?.action);
	if (matches(data, "right")) {
		const action = entries[state.selected]?.action;
		return action?.kind === "group" ? run(action) : { state };
	}
	if (matches(data, "down") || matches(data, "ctrl+n")) return { state: { ...state, selected: wrapSelection(state.selected, 1, entries.length) } };
	if (matches(data, "up") || matches(data, "ctrl+p")) return { state: { ...state, selected: wrapSelection(state.selected, -1, entries.length) } };
	const hit = entryForKey(allEntries(menu), data);
	return hit ? run(hit.action) : { state };
}

export type NotifyLevel = "info" | "warning" | "error";

export interface DispatchDeps {
	/** Pi's `sendUserMessage`; only `expandPromptTemplates` makes Pi run the text as a command. */
	sendUserMessage: (text: string, options: { expandPromptTemplates: boolean }) => void;
	shutdown: () => void;
	notify: (message: string, level: NotifyLevel) => void;
	/** Reads the brigadev settings when the dashboard toggle runs. Defaults to the settings file. */
	readSettings?: () => BrigadevSettings;
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Runs the chosen action once the dashboard is closed. Chat and a closed dashboard do nothing; any failure becomes a notification. */
export function dispatch(action: DashboardAction | undefined, deps: DispatchDeps): void {
	const send = (text: string) => {
		try {
			deps.sendUserMessage(text, { expandPromptTemplates: true });
		} catch (error) {
			deps.notify(`Could not run ${text}: ${errorText(error)}`, "error");
		}
	};
	if (action?.kind === "workflow") send(`${START_COMMAND} ${action.query}`);
	else if (action?.kind === "command") send(action.command);
	else if (action?.kind === "toggle-dashboard") {
		let enabled: boolean;
		try {
			enabled = (deps.readSettings ?? readSettings)().ui?.dashboard !== false;
		} catch (error) {
			return deps.notify(`Could not toggle the launch dashboard: ${errorText(error)}`, "error");
		}
		send(`/brigadev:ui dashboard ${enabled ? "off" : "on"}`);
	}
	else if (action?.kind === "quit") {
		try {
			deps.shutdown();
		} catch (error) {
			deps.notify(`Could not quit: ${errorText(error)}`, "error");
		}
	}
}

/** True when `BRIGADEV_DASHBOARD` asks for no automatic open. */
export function dashboardDisabledByEnv(env: NodeJS.ProcessEnv): boolean {
	return ["0", "off", "false"].includes((env[DASHBOARD_ENV] ?? "").trim().toLowerCase());
}

/** Where the launch decision reads its facts from. */
export interface LaunchReaders {
	readSettings: () => BrigadevSettings;
	/** The command-line arguments after the script. */
	argv: () => readonly string[];
	env: () => NodeJS.ProcessEnv;
}

export const processReaders: LaunchReaders = { readSettings, argv: () => process.argv.slice(2), env: () => process.env };

export interface StartSession {
	/** `session_start` reason. */
	reason: string;
	/** `ctx.mode`. */
	mode: string;
	/** The session branch entries. */
	branch: readonly { type?: unknown }[];
}

/** Whether the dashboard opens by itself for this session start. */
export function shouldOpenOnStart(session: StartSession, readers: LaunchReaders = processReaders): boolean {
	const env = readers.env();
	return shouldShowDashboard({
		reason: session.reason,
		mode: session.mode,
		branchHasMessages: hasMessageEntries(session.branch),
		hasInitialPrompt: hasInitialPrompt(readers.argv()),
		enabled: readers.readSettings().ui?.dashboard !== false && !dashboardDisabledByEnv(env),
		child: isChildSession(env),
	});
}

export const openFailureMessage = (error: unknown): string => `brigadev: dashboard could not open: ${errorText(error)} (turn it off with /brigadev:ui dashboard off)`;

/** Opens the dashboard on its own; a failure is reported instead of swallowed. */
export async function autoOpen(open: () => Promise<void>, notify: DispatchDeps["notify"]): Promise<void> {
	try {
		await open();
	} catch (error) {
		notify(openFailureMessage(error), "error");
	}
}

export interface Timers {
	set: (run: () => void) => unknown;
	clear: (handle: unknown) => void;
}

const realTimers: Timers = { set: (run) => setTimeout(run, 0), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) };

/**
 * Opens the dashboard on the next tick, so the rest of startup is not held up. Returns a function that cancels
 * the open if it has not happened yet (`session_shutdown`).
 */
export function scheduleAutoOpen(open: () => Promise<void>, notify: DispatchDeps["notify"], timers: Timers = realTimers): () => void {
	const handle = timers.set(() => void autoOpen(open, notify));
	return () => timers.clear(handle);
}
