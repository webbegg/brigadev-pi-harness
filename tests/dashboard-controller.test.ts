import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { allEntries, buildMenu, DASHBOARD_HINT, GROUP_HINT, type DashboardAction, type DashboardEntry } from "../lib/dashboard.ts";
import {
	autoOpen,
	DASHBOARD_ENV,
	dashboardDisabledByEnv,
	dispatch,
	legacyKeys,
	openFailureMessage,
	reduceKey,
	renderState,
	scheduleAutoOpen,
	shouldOpenOnStart,
	START_COMMAND,
	startState,
	viewFor,
	type DashboardState,
	type DispatchDeps,
	type KeyMatcher,
	type LaunchReaders,
} from "../lib/dashboard-controller.ts";
import { CHILD_ENV, readSettings, runUiCommand, settingsPath, type BrigadevSettings } from "../lib/runtime.ts";
import type { Painter } from "../lib/two-pane.ts";
import type { Workflow } from "../lib/workflows.ts";

const plain: Painter = {
	paint: (_tone, text) => text,
	bold: (text) => text,
	measure: (text) => text.length,
	truncate: (text, width) => text.slice(0, width),
};

const workflow = (name: string, id: string, key?: string, group?: string): Workflow => ({ name, description: "d", order: 1, questions: [], body: "b", source: "package", filePath: `/w/${id}.md`, ...(key ? { key } : {}), ...(group ? { group } : {}) });
const SHIPPED: Array<[string, string, string | undefined, string]> = [
	["Quick change", "quick-change", undefined, "feature"],
	["Feature", "new-feature", undefined, "feature"],
	["Big feature (plan first)", "big-feature", undefined, "feature"],
	["Work on a ticket", "ticket", "j", "main"],
	["Review a team PR", "team-review", "r", "main"],
	["My PRs: feedback", "pr-feedback", "f", "main"],
	["Bug fix", "bug-fix", "b", "other"],
	["Review my branch", "review", "v", "other"],
	["Open a PR", "open-pr", "p", "other"],
	["Create an issue", "create-issue", "i", "other"],
	["UI change from a design or ticket", "ui-change", "u", "other"],
	["Refactor a component", "refactor", "x", "other"],
	["Upgrade dependencies", "upgrade-dependencies", "d", "other"],
];
const menu = buildMenu([...SHIPPED.map(([name, id, key, group]) => workflow(name, id, key, group)), workflow("Write docs", "write-docs", "w", "Docs")]);
const everything = allEntries(menu);
const CHAT: DashboardAction = { kind: "chat" };

const KEYS = { escape: "\x1b", enter: "\r", up: "\x1b[A", down: "\x1b[B", right: "\x1b[C", left: "\x1b[D", ctrlN: "\x0e", ctrlP: "\x10" };

// Top level: New feature, three main workflows, Other workflows, Docs, Tools, Commands, Chat, Quit.
const TOP = menu.top.map((entry) => entry.label);
const topIndex = (label: string) => TOP.indexOf(label);
const inGroup = (id: string, selected = 0): DashboardState => ({ level: "group", group: id, selected });
const atTop = (selected = 0): DashboardState => ({ level: "top", selected });
const groupItems = (id: string) => menu.groups.find((g) => g.id === id)!.items;

describe("viewFor", () => {
	it("the top level shows the top rows with the top hint and no heading", () => {
		const view = viewFor(menu, startState);
		assert.deepEqual(startState, atTop(0));
		assert.equal(view.entries, menu.top);
		assert.equal(view.heading, undefined);
		assert.equal(view.hint, DASHBOARD_HINT);
	});

	it("a group shows its rows under its name with the group hint", () => {
		const view = viewFor(menu, inGroup("tools"));
		assert.equal(view.entries, groupItems("tools"));
		assert.equal(view.heading, "Tools");
		assert.equal(view.hint, GROUP_HINT);
	});

	it("an unknown group falls back to the top level", () => {
		assert.equal(viewFor(menu, inGroup("nope")).entries, menu.top);
	});
});

describe("renderState", () => {
	const size = { width: 80, height: 40 };
	const render = (state: DashboardState) => renderState(menu, state, size, plain, "my-repo");
	const cursorRows = (lines: string[]) => lines.map((line) => line.trim()).filter((line) => line.startsWith("›"));

	it("a group shows its name, its rows with the cursor on the selection, and the group hint", () => {
		const lines = render(inGroup("tools", 2));
		const text = lines.join("\n");
		assert.equal(lines.length, size.height);
		assert.match(text, /brigadev · my-repo/);
		assert.ok(lines.some((line) => line.trim() === "Tools"), "heading");
		assert.ok(text.includes(GROUP_HINT), "group hint");
		assert.ok(!text.includes(DASHBOARD_HINT), "no top hint");
		for (const entry of groupItems("tools")) assert.ok(text.includes(entry.label), entry.label);
		for (const entry of groupItems("other")) assert.ok(!text.includes(entry.label), entry.label);
		const cursor = cursorRows(lines);
		assert.equal(cursor.length, 1);
		assert.ok(cursor[0].includes(groupItems("tools")[2].label), cursor[0]);
	});

	it("the cursor follows state.selected in the group", () => {
		for (const index of [0, 1, groupItems("feature").length - 1]) {
			const cursor = cursorRows(render(inGroup("feature", index)));
			assert.equal(cursor.length, 1);
			assert.ok(cursor[0].includes(groupItems("feature")[index].label), `${index}: ${cursor[0]}`);
		}
	});

	it("the top level shows the top rows and the top hint, with no heading", () => {
		const lines = render(atTop(topIndex("Chat")));
		const text = lines.join("\n");
		assert.ok(text.includes(DASHBOARD_HINT), "top hint");
		assert.ok(!text.includes(GROUP_HINT), "no group hint");
		for (const label of TOP) assert.ok(text.includes(label), label);
		assert.ok(!text.includes("Cost"), "group rows stay hidden");
		const cursor = cursorRows(lines);
		assert.equal(cursor.length, 1);
		assert.ok(cursor[0].includes("Chat"), cursor[0]);
	});

	it("a state pointing at a missing group renders the top level", () => {
		assert.deepEqual(render(inGroup("nope", 1)), render(atTop(1)));
	});
});

describe("reduceKey at the top level", () => {
	it("Esc goes to the chat from any row, leaving the state alone", () => {
		for (const selected of [0, 3, menu.top.length - 1]) {
			assert.deepEqual(reduceKey(atTop(selected), KEYS.escape, menu), { state: atTop(selected), done: CHAT });
		}
	});

	it("Enter on a group row opens it on its first row, without closing", () => {
		assert.deepEqual(reduceKey(atTop(topIndex("Tools")), KEYS.enter, menu), { state: inGroup("tools", 0) });
		assert.deepEqual(reduceKey(atTop(0), KEYS.enter, menu), { state: inGroup("feature", 0) });
		assert.deepEqual(reduceKey(atTop(topIndex("Docs")), KEYS.enter, menu), { state: inGroup("docs", 0) });
	});

	it("Enter on a main workflow row runs it without leaving the top level", () => {
		for (const label of ["Work on a ticket", "Review a team PR", "My PRs: feedback"]) {
			assert.deepEqual(reduceKey(atTop(topIndex(label)), KEYS.enter, menu), { state: atTop(topIndex(label)), done: { kind: "workflow", query: label } }, label);
		}
	});

	it("→ opens the group too, and does nothing on a workflow row, Commands, Chat, or Quit", () => {
		assert.deepEqual(reduceKey(atTop(topIndex("Other workflows")), KEYS.right, menu), { state: inGroup("other", 0) });
		for (const label of ["Work on a ticket", "Commands", "Chat", "Quit"]) assert.deepEqual(reduceKey(atTop(topIndex(label)), KEYS.right, menu), { state: atTop(topIndex(label)) }, label);
	});

	it("← does nothing at the top level", () => {
		assert.deepEqual(reduceKey(atTop(2), KEYS.left, menu), { state: atTop(2) });
	});

	it("Enter on Commands runs it, on Chat means chat, on Quit quits", () => {
		assert.deepEqual(reduceKey(atTop(topIndex("Commands")), KEYS.enter, menu).done, { kind: "command", command: "/brigadev:commands" });
		assert.deepEqual(reduceKey(atTop(topIndex("Chat")), KEYS.enter, menu).done, CHAT);
		assert.deepEqual(reduceKey(atTop(topIndex("Quit")), KEYS.enter, menu).done, { kind: "quit" });
	});

	it("moves with the arrows and ctrl+n / ctrl+p, wrapping at both ends", () => {
		const last = menu.top.length - 1;
		assert.deepEqual(reduceKey(atTop(0), KEYS.down, menu), { state: atTop(1) });
		assert.deepEqual(reduceKey(atTop(0), KEYS.ctrlN, menu), { state: atTop(1) });
		assert.deepEqual(reduceKey(atTop(5), KEYS.up, menu), { state: atTop(4) });
		assert.deepEqual(reduceKey(atTop(5), KEYS.ctrlP, menu), { state: atTop(4) });
		assert.deepEqual(reduceKey(atTop(0), KEYS.up, menu), { state: atTop(last) });
		assert.deepEqual(reduceKey(atTop(last), KEYS.down, menu), { state: atTop(0) });
	});
});

describe("reduceKey inside a group", () => {
	it("Enter runs the selected row; the selection starts on the first row", () => {
		assert.deepEqual(reduceKey(inGroup("feature", 0), KEYS.enter, menu), { state: inGroup("feature", 0), done: { kind: "workflow", query: "Quick change" } });
		assert.deepEqual(reduceKey(inGroup("feature", 1), KEYS.enter, menu).done, { kind: "workflow", query: "Feature" });
		assert.deepEqual(reduceKey(inGroup("feature", 2), KEYS.enter, menu).done, { kind: "workflow", query: "Big feature (plan first)" });
		assert.deepEqual(reduceKey(inGroup("other", 0), KEYS.enter, menu).done, { kind: "workflow", query: "Bug fix" });
		assert.deepEqual(reduceKey(inGroup("tools", 2), KEYS.enter, menu).done, { kind: "command", command: "/brigadev:cost" });
		assert.deepEqual(reduceKey(inGroup("tools", 8), KEYS.enter, menu).done, { kind: "toggle-dashboard" });
		assert.deepEqual(reduceKey(inGroup("docs", 0), KEYS.enter, menu).done, { kind: "workflow", query: "Write docs" });
	});

	it("← and Esc go back to the top level, on the row of the group they came from", () => {
		for (const [id, label] of [["feature", "New feature"], ["other", "Other workflows"], ["docs", "Docs"], ["tools", "Tools"]]) {
			for (const back of [KEYS.left, KEYS.escape]) {
				assert.deepEqual(reduceKey(inGroup(id, 1), back, menu), { state: atTop(topIndex(label)) }, `${id} ${JSON.stringify(back)}`);
			}
		}
	});

	it("Esc in a group does not go to the chat", () => {
		assert.equal(reduceKey(inGroup("feature"), KEYS.escape, menu).done, undefined);
	});

	it("→ does nothing on a row", () => {
		assert.deepEqual(reduceKey(inGroup("feature", 1), KEYS.right, menu), { state: inGroup("feature", 1) });
	});

	it("moves within the group's rows, wrapping at both ends", () => {
		const count = groupItems("tools").length;
		assert.equal(count, 10);
		assert.deepEqual(reduceKey(inGroup("tools", 0), KEYS.down, menu), { state: inGroup("tools", 1) });
		assert.deepEqual(reduceKey(inGroup("tools", 0), KEYS.up, menu), { state: inGroup("tools", count - 1) });
		assert.deepEqual(reduceKey(inGroup("tools", count - 1), KEYS.down, menu), { state: inGroup("tools", 0) });
		assert.deepEqual(reduceKey(inGroup("tools", 2), KEYS.ctrlN, menu), { state: inGroup("tools", 3) });
		assert.deepEqual(reduceKey(inGroup("tools", 2), KEYS.ctrlP, menu), { state: inGroup("tools", 1) });
	});

	it("an unknown group behaves like the top level", () => {
		assert.deepEqual(reduceKey(inGroup("nope", 0), KEYS.escape, menu).done, CHAT);
	});
});

describe("reduceKey keys from any level", () => {
	const levels: Array<[string, DashboardState]> = [["top", atTop(2)], ...menu.groups.map((g): [string, DashboardState] => [g.id, inGroup(g.id, 1)])];

	it("every letter runs its row from the top and from inside any group, keeping the state", () => {
		const letters = everything.filter((entry) => entry.key && /[a-z]/.test(entry.key) && entry.action.kind !== "group");
		// 10 keyed workflows + Write docs + 10 tools + Commands + Quit
		assert.equal(letters.length, 23);
		for (const [name, state] of levels) {
			for (const entry of letters) {
				assert.deepEqual(reduceKey(state, entry.key!, menu), { state, done: entry.action }, `${name}: ${entry.label}`);
			}
		}
	});

	it("the new tool letters run their commands from the top level", () => {
		const commandFor = (key: string) => reduceKey(atTop(0), key, menu).done;
		assert.deepEqual(commandFor("c"), { kind: "command", command: "/brigadev:cost" });
		assert.deepEqual(commandFor("s"), { kind: "command", command: "/brigadev:usage" });
		assert.deepEqual(commandFor("t"), { kind: "command", command: "/brigadev:status" });
		assert.deepEqual(commandFor("o"), { kind: "command", command: "/brigadev:panel" });
		assert.deepEqual(commandFor("e"), { kind: "command", command: "/brigadev:mode status" });
		assert.deepEqual(commandFor("h"), { kind: "toggle-dashboard" });
		assert.deepEqual(commandFor("y"), { kind: "command", command: "/brigadev:doctor" });
		assert.deepEqual(commandFor("q"), { kind: "quit" });
	});

	it("a digit opens its group from any level, on the first row", () => {
		for (const [name, state] of levels) {
			assert.deepEqual(reduceKey(state, "1", menu), { state: inGroup("other", 0) }, name);
			assert.deepEqual(reduceKey(state, "2", menu), { state: inGroup("tools", 0) }, name);
			assert.deepEqual(reduceKey(state, "3", menu), { state: inGroup("docs", 0) }, name);
		}
	});

	it("n opens New feature from any level, on its first row", () => {
		for (const [name, state] of levels) assert.deepEqual(reduceKey(state, "n", menu), { state: inGroup("feature", 0) }, name);
	});

	it("the main workflow letters run from any level", () => {
		for (const [name, state] of levels) {
			assert.deepEqual(reduceKey(state, "j", menu), { state, done: { kind: "workflow", query: "Work on a ticket" } }, name);
			assert.deepEqual(reduceKey(state, "r", menu), { state, done: { kind: "workflow", query: "Review a team PR" } }, name);
			assert.deepEqual(reduceKey(state, "f", menu), { state, done: { kind: "workflow", query: "My PRs: feedback" } }, name);
			assert.deepEqual(reduceKey(state, "v", menu), { state, done: { kind: "workflow", query: "Review my branch" } }, name);
		}
	});

	it("going back after jumping by digit lands on the group you jumped to", () => {
		const jumped = reduceKey(inGroup("tools", 4), "1", menu).state;
		assert.deepEqual(reduceKey(jumped, KEYS.left, menu).state, atTop(topIndex("Other workflows")));
		const fromN = reduceKey(inGroup("tools", 4), "n", menu).state;
		assert.deepEqual(reduceKey(fromN, KEYS.escape, menu).state, atTop(topIndex("New feature")));
	});

	it("ignores unknown letters, digits with no group, and multi-character input without closing", () => {
		for (const [name, state] of levels) {
			for (const data of ["z", "nn", "N", "6", "0", " ", "\t"]) assert.deepEqual(reduceKey(state, data, menu), { state }, `${name} ${JSON.stringify(data)}`);
		}
	});

	it("does not touch the state it was given", () => {
		const state = atTop(1);
		reduceKey(state, KEYS.down, menu);
		reduceKey(state, KEYS.enter, menu);
		assert.deepEqual(state, atTop(1));
	});

	it("asks the injected key matcher, so the adapter can use Pi's (Kitty-aware) one", () => {
		const asked: string[] = [];
		const matcher: KeyMatcher = (data, key) => {
			asked.push(key);
			return data === "<esc>" ? key === "escape" : data === "<down>" ? key === "down" : data === "<left>" ? key === "left" : data === "<right>" ? key === "right" : false;
		};
		assert.deepEqual(reduceKey(atTop(0), "<esc>", menu, matcher).done, CHAT);
		assert.deepEqual(reduceKey(atTop(0), "<down>", menu, matcher).state, atTop(1));
		assert.deepEqual(reduceKey(atTop(0), "<right>", menu, matcher).state, inGroup("feature", 0));
		assert.deepEqual(reduceKey(inGroup("feature", 1), "<left>", menu, matcher).state, atTop(0));
		assert.ok(["escape", "down", "left", "right"].every((key) => asked.includes(key)));
		// Without a match, a plain letter still runs its row.
		assert.deepEqual(reduceKey(atTop(0), "q", menu, matcher).done, { kind: "quit" });
	});

	it("is safe on an empty menu", () => {
		const empty = { groups: [], top: [] };
		assert.deepEqual(reduceKey(atTop(0), KEYS.enter, empty), { state: atTop(0), done: CHAT });
		assert.deepEqual(reduceKey(atTop(0), KEYS.down, empty), { state: atTop(0) });
		assert.deepEqual(reduceKey(atTop(0), KEYS.right, empty), { state: atTop(0) });
	});

	it("legacy key sequences are distinct", () => {
		assert.ok(legacyKeys(KEYS.escape, "escape") && !legacyKeys(KEYS.escape, "enter"));
		assert.ok(legacyKeys("\n", "enter"));
		assert.ok(legacyKeys(KEYS.left, "left") && !legacyKeys(KEYS.left, "right"));
		assert.ok(legacyKeys(KEYS.right, "right") && !legacyKeys(KEYS.right, "left"));
		assert.ok(legacyKeys("\x1bOD", "left") && legacyKeys("\x1bOC", "right"));
	});
});

describe("dispatch", () => {
	const make = () => {
		const calls: Array<[string, ...unknown[]]> = [];
		const deps: DispatchDeps = {
			sendUserMessage: (text, options) => void calls.push(["send", text, options]),
			shutdown: () => void calls.push(["shutdown"]),
			notify: (message, level) => void calls.push(["notify", message, level]),
		};
		return { calls, deps };
	};

	it("starts a workflow through /brigadev:start with prompt templates expanded", () => {
		const { calls, deps } = make();
		dispatch({ kind: "workflow", query: "Bug fix" }, deps);
		assert.equal(START_COMMAND, "/brigadev:start");
		assert.deepEqual(calls, [["send", "/brigadev:start Bug fix", { expandPromptTemplates: true }]]);
	});

	it("runs a tool's command the same way", () => {
		const { calls, deps } = make();
		dispatch({ kind: "command", command: "/brigadev:changes" }, deps);
		assert.deepEqual(calls, [["send", "/brigadev:changes", { expandPromptTemplates: true }]]);
	});

	it("runs every new tool row as its own command", () => {
		const sent = (label: string) => {
			const { calls, deps } = make();
			dispatch(everything.find((entry) => entry.label === label)!.action as DashboardAction, deps);
			return calls;
		};
		for (const [label, command] of [["Cost", "/brigadev:cost"], ["Usage", "/brigadev:usage"], ["Status", "/brigadev:status"], ["Panel", "/brigadev:panel"], ["Doctor", "/brigadev:doctor"], ["Permission mode", "/brigadev:mode status"], ["Model profile", "/brigadev:profile use"], ["Changes", "/brigadev:changes"], ["Agents history", "/brigadev:runs"]]) {
			assert.deepEqual(sent(label), [["send", command, { expandPromptTemplates: true }]], label);
		}
	});

	it("the launch dashboard row turns the automatic start off when it is on", () => {
		for (const settings of [{}, { ui: {} }, { ui: { dashboard: true } }, { ui: { footer: false } }] as BrigadevSettings[]) {
			const { calls, deps } = make();
			dispatch({ kind: "toggle-dashboard" }, { ...deps, readSettings: () => settings });
			assert.deepEqual(calls, [["send", "/brigadev:ui dashboard off", { expandPromptTemplates: true }]], JSON.stringify(settings));
		}
	});

	it("the launch dashboard row turns it on when it is off", () => {
		const { calls, deps } = make();
		dispatch({ kind: "toggle-dashboard" }, { ...deps, readSettings: () => ({ ui: { dashboard: false } }) });
		assert.deepEqual(calls, [["send", "/brigadev:ui dashboard on", { expandPromptTemplates: true }]]);
	});

	it("reads the setting when the row runs, not when the menu was built", () => {
		let settings: BrigadevSettings = { ui: { dashboard: true } };
		const { calls, deps } = make();
		const withSettings = { ...deps, readSettings: () => settings };
		dispatch({ kind: "toggle-dashboard" }, withSettings);
		settings = { ui: { dashboard: false } };
		dispatch({ kind: "toggle-dashboard" }, withSettings);
		assert.deepEqual(calls.map((call) => call[1]), ["/brigadev:ui dashboard off", "/brigadev:ui dashboard on"]);
	});

	it("BRIGADEV_DASHBOARD turning the dashboard off makes the row send nothing and say why", () => {
		for (const value of ["0", "off", "false"]) {
			for (const settings of [{}, { ui: { dashboard: false } }] as BrigadevSettings[]) {
				const { calls, deps } = make();
				dispatch({ kind: "toggle-dashboard" }, { ...deps, readSettings: () => settings, env: () => ({ [DASHBOARD_ENV]: value }) });
				assert.deepEqual(calls, [["notify", `brigadev: the launch dashboard is off for this shell (BRIGADEV_DASHBOARD=${value}); unset it to use the setting`, "info"]], `${value} ${JSON.stringify(settings)}`);
			}
		}
	});

	it("an environment that does not disable the dashboard leaves the toggle as it was", () => {
		for (const env of [{}, { [DASHBOARD_ENV]: "1" }, { [DASHBOARD_ENV]: "" }] as NodeJS.ProcessEnv[]) {
			const { calls, deps } = make();
			dispatch({ kind: "toggle-dashboard" }, { ...deps, readSettings: () => ({}), env: () => env });
			assert.deepEqual(calls, [["send", "/brigadev:ui dashboard off", { expandPromptTemplates: true }]], JSON.stringify(env));
		}
	});

	it("a failing settings read is reported, nothing is sent", () => {
		const { calls, deps } = make();
		dispatch({ kind: "toggle-dashboard" }, { ...deps, readSettings: () => { throw new Error("EACCES"); } });
		assert.deepEqual(calls, [["notify", "Could not toggle the launch dashboard: EACCES", "error"]]);
	});

	it("no row changes the permission mode: the only mode command sent is `/brigadev:mode status`", () => {
		const sentTexts: string[] = [];
		for (const entry of everything) {
			if (entry.action.kind === "group") continue;
			const { calls, deps } = make();
			dispatch(entry.action, { ...deps, readSettings: () => ({}) });
			for (const call of calls) if (call[0] === "send") sentTexts.push(call[1] as string);
		}
		const modeCommands = sentTexts.filter((text) => text.includes("/brigadev:mode") || /\b(yolo|normal)\b/.test(text));
		assert.deepEqual(modeCommands, ["/brigadev:mode status"]);
	});

	it("quit shuts the session down and sends nothing", () => {
		const { calls, deps } = make();
		dispatch({ kind: "quit" }, deps);
		assert.deepEqual(calls, [["shutdown"]]);
	});

	it("chat and a closed dashboard do nothing", () => {
		const { calls, deps } = make();
		dispatch(CHAT, deps);
		dispatch(undefined, deps);
		assert.deepEqual(calls, []);
	});

	it("a failing send is reported with the command, not thrown", () => {
		const { calls, deps } = make();
		dispatch({ kind: "command", command: "/brigadev:runs" }, { ...deps, sendUserMessage: () => { throw new Error("boom"); } });
		assert.deepEqual(calls, [["notify", "Could not run /brigadev:runs: boom", "error"]]);
	});

	it("a failing shutdown is reported too, and non-Error throws are stringified", () => {
		const { calls, deps } = make();
		dispatch({ kind: "quit" }, { ...deps, shutdown: () => { throw "nope"; } });
		dispatch({ kind: "workflow", query: "x" }, { ...deps, sendUserMessage: () => { throw "bad"; } });
		assert.deepEqual(calls, [
			["notify", "Could not quit: nope", "error"],
			["notify", "Could not run /brigadev:start x: bad", "error"],
		]);
	});
});

describe("dashboardDisabledByEnv", () => {
	it("is true for BRIGADEV_DASHBOARD=0, off, or false in any case, and false otherwise", () => {
		assert.equal(DASHBOARD_ENV, "BRIGADEV_DASHBOARD");
		for (const value of ["0", "off", "false", "OFF", "False", " 0 "]) assert.equal(dashboardDisabledByEnv({ [DASHBOARD_ENV]: value }), true, value);
		for (const value of ["1", "on", "true", "", "yes"]) assert.equal(dashboardDisabledByEnv({ [DASHBOARD_ENV]: value }), false, value);
		assert.equal(dashboardDisabledByEnv({}), false);
	});
});

describe("shouldOpenOnStart (settings read from a temp PI_CODING_AGENT_DIR)", () => {
	let scratch: string;
	let previous: string | undefined;
	const fresh = { reason: "startup", mode: "tui", branch: [] as Array<{ type?: unknown }> };
	const readers = (over: Partial<{ argv: string[]; env: NodeJS.ProcessEnv }> = {}): LaunchReaders => ({ readSettings, argv: () => over.argv ?? [], env: () => over.env ?? {} });
	const settingsFile = () => settingsPath();
	const writeFile = (settings: BrigadevSettings) => writeFileSync(settingsFile(), JSON.stringify(settings));

	before(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-dashboard-launch-")));
		previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = scratch;
	});
	after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(scratch, { recursive: true, force: true });
	});

	it("opens on a fresh startup with no settings file", () => {
		rmSync(settingsFile(), { force: true });
		assert.equal(shouldOpenOnStart(fresh, readers()), true);
	});

	it("opens when the setting is on, and does not when `ui.dashboard` is false in brigadev.json", () => {
		writeFile({ ui: { dashboard: true } });
		assert.equal(shouldOpenOnStart(fresh, readers()), true);
		writeFile({ ui: { dashboard: false } });
		assert.equal(shouldOpenOnStart(fresh, readers()), false);
		writeFile({ ui: { footer: false } });
		assert.equal(shouldOpenOnStart(fresh, readers()), true);
	});

	it("treats an unreadable settings file as the defaults", () => {
		writeFileSync(settingsFile(), "{ not json");
		assert.equal(shouldOpenOnStart(fresh, readers()), true);
	});

	it("BRIGADEV_DASHBOARD=0 skips the auto-open whatever the settings say", () => {
		writeFile({ ui: { dashboard: true } });
		for (const value of ["0", "off", "false"]) assert.equal(shouldOpenOnStart(fresh, readers({ env: { [DASHBOARD_ENV]: value } })), false, value);
		assert.equal(shouldOpenOnStart(fresh, readers({ env: { [DASHBOARD_ENV]: "1" } })), true);
	});

	it("skips for a reload, a non-terminal mode, a session with messages, and an initial prompt", () => {
		writeFile({});
		assert.equal(shouldOpenOnStart({ ...fresh, reason: "reload" }, readers()), false);
		assert.equal(shouldOpenOnStart({ ...fresh, reason: "resume" }, readers()), false);
		assert.equal(shouldOpenOnStart({ ...fresh, mode: "rpc" }, readers()), false);
		assert.equal(shouldOpenOnStart({ ...fresh, branch: [{ type: "model_change" }, { type: "message" }] }, readers()), false);
		assert.equal(shouldOpenOnStart({ ...fresh, branch: [{ type: "model_change" }] }, readers()), true);
		assert.equal(shouldOpenOnStart(fresh, readers({ argv: ["fix the login bug"] })), false);
		assert.equal(shouldOpenOnStart(fresh, readers({ argv: ["--continue", "--model", "sonnet"] })), true);
	});

	it("skips inside a subagent", () => {
		assert.equal(shouldOpenOnStart(fresh, readers({ env: { [CHILD_ENV.CHILD]: "1" } })), false);
	});

	it("the toggle row reads the real settings file by default", () => {
		const sent: string[] = [];
		const deps: DispatchDeps = { sendUserMessage: (text) => void sent.push(text), shutdown: () => {}, notify: () => {}, env: () => ({}) };
		writeFile({ ui: { dashboard: false } });
		dispatch({ kind: "toggle-dashboard" }, deps);
		writeFile({ ui: { dashboard: true } });
		dispatch({ kind: "toggle-dashboard" }, deps);
		rmSync(settingsFile(), { force: true });
		dispatch({ kind: "toggle-dashboard" }, deps);
		assert.deepEqual(sent, ["/brigadev:ui dashboard on", "/brigadev:ui dashboard off", "/brigadev:ui dashboard off"]);
	});

	it("`/brigadev:ui dashboard off` then a fresh start does not open; `on` brings it back", () => {
		rmSync(settingsFile(), { force: true });
		runUiCommand("dashboard off");
		assert.equal(shouldOpenOnStart(fresh, readers()), false);
		runUiCommand("dashboard on");
		assert.equal(shouldOpenOnStart(fresh, readers()), true);
	});
});

describe("runUiCommand", () => {
	const store = (initial: BrigadevSettings = {}) => {
		const writes: BrigadevSettings[] = [];
		return { writes, read: () => initial, write: (update: BrigadevSettings) => void writes.push(update) };
	};

	it("writes the dashboard setting off and on, keeping the other ui settings", () => {
		const off = store({ ui: { footer: false } });
		assert.deepEqual(runUiCommand("dashboard off", off), { feature: "dashboard", message: "brigadev dashboard off" });
		assert.deepEqual(off.writes, [{ ui: { footer: false, dashboard: false } }]);
		const on = store({ ui: { dashboard: false } });
		assert.deepEqual(runUiCommand("  dashboard   on ", on), { feature: "dashboard", message: "brigadev dashboard on" });
		assert.deepEqual(on.writes, [{ ui: { dashboard: true } }]);
	});

	it("handles footer and phase the same way", () => {
		const s = store();
		assert.equal(runUiCommand("footer off", s).feature, "footer");
		assert.equal(runUiCommand("phase on", s).feature, "phase");
		assert.deepEqual(s.writes, [{ ui: { footer: false } }, { ui: { phase: true } }]);
	});

	it("shows the current state and the usage, and writes nothing, for anything else", () => {
		for (const args of ["", "dashboard", "dashboard maybe", "colors on", "on"]) {
			const s = store({ ui: { phase: false } });
			const result = runUiCommand(args, s);
			assert.equal(result.feature, undefined, args);
			assert.equal(result.message, "footer: on · phase: off · dashboard: on\nUsage: /brigadev:ui footer|phase|dashboard on|off", args);
			assert.deepEqual(s.writes, [], args);
		}
	});

	it("writes through to brigadev.json by default", () => {
		const scratch = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-ui-command-")));
		const previous = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = join(scratch, "agent");
		try {
			runUiCommand("dashboard off");
			assert.deepEqual(JSON.parse(readFileSync(settingsPath(), "utf8")), { ui: { dashboard: false } });
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("auto-open", () => {
	it("words the failure with the reason and how to turn the dashboard off", () => {
		assert.equal(openFailureMessage(new Error("EACCES: permission denied")), "brigadev: dashboard could not open: EACCES: permission denied (turn it off with /brigadev:ui dashboard off)");
		assert.equal(openFailureMessage("plain"), "brigadev: dashboard could not open: plain (turn it off with /brigadev:ui dashboard off)");
	});

	it("autoOpen reports a failed open instead of swallowing it", async () => {
		const notes: Array<[string, string]> = [];
		await autoOpen(async () => { throw new Error("no terminal"); }, (message, level) => void notes.push([message, level]));
		assert.deepEqual(notes, [["brigadev: dashboard could not open: no terminal (turn it off with /brigadev:ui dashboard off)", "error"]]);
	});

	it("autoOpen stays quiet when the dashboard opens", async () => {
		const notes: string[] = [];
		await autoOpen(async () => undefined, (message) => void notes.push(message));
		assert.deepEqual(notes, []);
	});

	const fakeTimers = () => {
		const pending = new Map<number, () => void>();
		let next = 1;
		return {
			pending,
			timers: {
				set: (run: () => void) => { pending.set(next, run); return next++; },
				clear: (handle: unknown) => void pending.delete(handle as number),
			},
			fire: () => { for (const [id, run] of [...pending]) { pending.delete(id); run(); } },
		};
	};

	it("scheduleAutoOpen opens once when the timer fires", async () => {
		const clock = fakeTimers();
		let opened = 0;
		scheduleAutoOpen(async () => void opened++, () => undefined, clock.timers);
		assert.equal(opened, 0);
		clock.fire();
		assert.equal(opened, 1);
	});

	it("cancelling before the timer fires means the dashboard never opens (session_shutdown)", () => {
		const clock = fakeTimers();
		let opened = 0;
		const cancel = scheduleAutoOpen(async () => void opened++, () => undefined, clock.timers);
		cancel();
		assert.equal(clock.pending.size, 0);
		clock.fire();
		assert.equal(opened, 0);
	});

	it("a failure in the scheduled open is notified", async () => {
		const clock = fakeTimers();
		const notes: string[] = [];
		scheduleAutoOpen(async () => { throw new Error("late"); }, (message) => void notes.push(message), clock.timers);
		clock.fire();
		await new Promise((resolve) => setImmediate(resolve));
		assert.deepEqual(notes, ["brigadev: dashboard could not open: late (turn it off with /brigadev:ui dashboard off)"]);
	});
});
