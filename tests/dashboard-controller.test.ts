import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { buildEntries, type DashboardAction, type DashboardEntry } from "../lib/dashboard.ts";
import {
	autoOpen,
	DASHBOARD_ENV,
	dashboardDisabledByEnv,
	dispatch,
	legacyKeys,
	openFailureMessage,
	reduceKey,
	scheduleAutoOpen,
	shouldOpenOnStart,
	START_COMMAND,
	type DispatchDeps,
	type KeyMatcher,
	type LaunchReaders,
} from "../lib/dashboard-controller.ts";
import { CHILD_ENV, readSettings, runUiCommand, settingsPath, type BrigadevSettings } from "../lib/runtime.ts";
import type { Workflow } from "../lib/workflows.ts";

const workflow = (name: string, id: string, key?: string): Workflow => ({ name, description: "d", order: 1, questions: [], body: "b", source: "package", filePath: `/w/${id}.md`, ...(key ? { key } : {}) });
const NINE: Array<[string, string, string]> = [
	["New feature", "new-feature", "n"],
	["Bug fix", "bug-fix", "b"],
	["Review a PR or branch", "review", "r"],
	["Open a PR", "open-pr", "p"],
	["Answer PR feedback", "pr-feedback", "f"],
	["Create an issue", "create-issue", "i"],
	["UI change from a design or ticket", "ui-change", "u"],
	["Refactor a component", "refactor", "x"],
	["Upgrade dependencies", "upgrade-dependencies", "d"],
];
const entries: DashboardEntry[] = buildEntries(NINE.map(([name, id, key]) => workflow(name, id, key)));
const rowIndex = (label: string) => entries.findIndex((entry) => entry.label === label);
const CHAT: DashboardAction = { kind: "chat" };

const KEYS = { escape: "\x1b", enter: "\r", up: "\x1b[A", down: "\x1b[B", ctrlN: "\x0e", ctrlP: "\x10" };

describe("reduceKey", () => {
	it("Esc goes to the chat from any row", () => {
		for (const selected of [0, 5, entries.length - 1]) {
			assert.deepEqual(reduceKey({ selected }, KEYS.escape, entries), { state: { selected }, done: CHAT });
		}
	});

	it("Enter runs the selected row's action; the Chat row means chat", () => {
		assert.deepEqual(reduceKey({ selected: 0 }, KEYS.enter, entries).done, { kind: "workflow", query: "New feature" });
		assert.deepEqual(reduceKey({ selected: rowIndex("Bug fix") }, KEYS.enter, entries).done, { kind: "workflow", query: "Bug fix" });
		assert.deepEqual(reduceKey({ selected: rowIndex("Changes") }, KEYS.enter, entries).done, { kind: "command", command: "/brigadev:changes" });
		assert.deepEqual(reduceKey({ selected: rowIndex("Chat") }, KEYS.enter, entries).done, CHAT);
		assert.deepEqual(reduceKey({ selected: rowIndex("Quit") }, KEYS.enter, entries).done, { kind: "quit" });
	});

	it("Enter does not pick row 0 when another row is selected", () => {
		assert.notDeepEqual(reduceKey({ selected: 3 }, KEYS.enter, entries).done, entries[0].action);
		assert.deepEqual(reduceKey({ selected: 3 }, KEYS.enter, entries).done, entries[3].action);
	});

	it("each row's letter runs that row, whatever is selected", () => {
		const keyed = entries.filter((entry) => entry.key);
		assert.equal(keyed.length, 14);
		for (const entry of keyed) {
			const result = reduceKey({ selected: 2 }, entry.key!, entries);
			assert.deepEqual(result.done, entry.action, entry.label);
			assert.deepEqual(result.state, { selected: 2 }, entry.label);
		}
	});

	it("ignores unknown letters and multi-character input without closing", () => {
		for (const data of ["z", "nn", "N", "1", " ", "\t"]) assert.deepEqual(reduceKey({ selected: 4 }, data, entries), { state: { selected: 4 } }, JSON.stringify(data));
	});

	it("moves with the arrows and ctrl+n / ctrl+p, wrapping at both ends", () => {
		assert.deepEqual(reduceKey({ selected: 0 }, KEYS.down, entries), { state: { selected: 1 } });
		assert.deepEqual(reduceKey({ selected: 0 }, KEYS.ctrlN, entries), { state: { selected: 1 } });
		assert.deepEqual(reduceKey({ selected: 5 }, KEYS.up, entries), { state: { selected: 4 } });
		assert.deepEqual(reduceKey({ selected: 5 }, KEYS.ctrlP, entries), { state: { selected: 4 } });
		assert.deepEqual(reduceKey({ selected: 0 }, KEYS.up, entries), { state: { selected: entries.length - 1 } });
		assert.deepEqual(reduceKey({ selected: entries.length - 1 }, KEYS.down, entries), { state: { selected: 0 } });
	});

	it("does not touch the state it was given", () => {
		const state = { selected: 1 };
		reduceKey(state, KEYS.down, entries);
		assert.deepEqual(state, { selected: 1 });
	});

	it("asks the injected key matcher, so the adapter can use Pi's (Kitty-aware) one", () => {
		const asked: string[] = [];
		const matcher: KeyMatcher = (data, key) => {
			asked.push(key);
			return data === "<esc>" ? key === "escape" : data === "<down>" ? key === "down" : false;
		};
		assert.deepEqual(reduceKey({ selected: 0 }, "<esc>", entries, matcher).done, CHAT);
		assert.deepEqual(reduceKey({ selected: 0 }, "<down>", entries, matcher).state, { selected: 1 });
		assert.ok(asked.includes("escape") && asked.includes("down"));
		// Without a match, a plain letter still runs its row.
		assert.deepEqual(reduceKey({ selected: 0 }, "q", entries, matcher).done, { kind: "quit" });
	});

	it("is safe on an empty list", () => {
		assert.deepEqual(reduceKey({ selected: 0 }, KEYS.enter, []), { state: { selected: 0 }, done: CHAT });
		assert.deepEqual(reduceKey({ selected: 0 }, KEYS.down, []), { state: { selected: 0 } });
	});

	it("legacy key sequences are distinct", () => {
		assert.ok(legacyKeys(KEYS.escape, "escape") && !legacyKeys(KEYS.escape, "enter"));
		assert.ok(legacyKeys("\n", "enter"));
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
