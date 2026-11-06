import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	allEntries,
	buildMenu,
	DASHBOARD_HINT,
	entryForKey,
	GROUP_HINT,
	hasInitialPrompt,
	hasMessageEntries,
	renderDashboard,
	shouldShowDashboard,
	wrapSelection,
	type DashboardEntry,
	type DashboardGroup,
	type LaunchConditions,
} from "../lib/dashboard.ts";
import type { Painter } from "../lib/two-pane.ts";
import { RESERVED_KEYS, resolveWorkflow, type Workflow } from "../lib/workflows.ts";

const plain: Painter = {
	paint: (_tone, text) => text,
	bold: (text) => text,
	measure: (text) => text.length,
	truncate: (text, width) => text.slice(0, width),
};

const workflow = (name: string, id: string, key?: string, source: Workflow["source"] = "package", group?: string): Workflow => ({
	name,
	description: `About ${name}`,
	order: 1,
	questions: [],
	body: "body",
	source,
	filePath: `/w/${id}.md`,
	...(key ? { key } : {}),
	...(group ? { group } : {}),
});

const NINE: Array<[string, string, string, string]> = [
	["New feature", "new-feature", "n", "build"],
	["Bug fix", "bug-fix", "b", "build"],
	["Review a PR or branch", "review", "r", "ship"],
	["Open a PR", "open-pr", "p", "ship"],
	["Answer PR feedback", "pr-feedback", "f", "ship"],
	["Create an issue", "create-issue", "i", "ship"],
	["UI change from a design or ticket", "ui-change", "u", "build"],
	["Refactor a component", "refactor", "x", "build"],
	["Upgrade dependencies", "upgrade-dependencies", "d", "build"],
];
const nine = () => NINE.map(([name, id, key, group]) => workflow(name, id, key, "package", group));

const group = (menu: ReturnType<typeof buildMenu>, id: string): DashboardGroup => menu.groups.find((g) => g.id === id)!;
const labels = (entries: readonly DashboardEntry[]) => entries.map((e) => e.label);

describe("buildMenu", () => {
	it("orders the groups Build, Review & ship, Inspect, Settings, with digits 1-4", () => {
		const menu = buildMenu(nine());
		assert.deepEqual(menu.groups.map((g) => [g.id, g.label, g.key]), [
			["build", "Build", "1"],
			["ship", "Review & ship", "2"],
			["inspect", "Inspect", "3"],
			["settings", "Settings", "4"],
		]);
	});

	it("puts the shipped workflows in their groups, in menu order, with their letters", () => {
		const menu = buildMenu(nine());
		assert.deepEqual(group(menu, "build").items.map((e) => [e.label, e.key]), [
			["New feature", "n"],
			["Bug fix", "b"],
			["UI change from a design or ticket", "u"],
			["Refactor a component", "x"],
			["Upgrade dependencies", "d"],
		]);
		assert.deepEqual(group(menu, "ship").items.map((e) => [e.label, e.key]), [
			["Review a PR or branch", "r"],
			["Open a PR", "p"],
			["Answer PR feedback", "f"],
			["Create an issue", "i"],
		]);
	});

	it("puts the tools in Inspect (g a c s t o) and Settings (m e h y)", () => {
		const menu = buildMenu(nine());
		assert.deepEqual(group(menu, "inspect").items.map((e) => [e.label, e.key]), [
			["Changes", "g"],
			["Agents history", "a"],
			["Cost", "c"],
			["Usage", "s"],
			["Status", "t"],
			["Panel", "o"],
		]);
		assert.deepEqual(group(menu, "settings").items.map((e) => [e.label, e.key]), [
			["Model profile", "m"],
			["Permission mode", "e"],
			["Launch dashboard on/off", "h"],
			["Doctor", "y"],
		]);
	});

	it("maps workflows to the start command by name and tools to their actions", () => {
		const menu = buildMenu(nine());
		assert.deepEqual(group(menu, "build").items[1].action, { kind: "workflow", query: "Bug fix" });
		const action = (label: string) => allEntries(menu).find((e) => e.label === label)!.action;
		assert.deepEqual(action("Changes"), { kind: "command", command: "/brigadev:changes" });
		assert.deepEqual(action("Agents history"), { kind: "command", command: "/brigadev:runs" });
		assert.deepEqual(action("Cost"), { kind: "command", command: "/brigadev:cost" });
		assert.deepEqual(action("Usage"), { kind: "command", command: "/brigadev:usage" });
		assert.deepEqual(action("Status"), { kind: "command", command: "/brigadev:status" });
		assert.deepEqual(action("Panel"), { kind: "command", command: "/brigadev:panel" });
		assert.deepEqual(action("Model profile"), { kind: "command", command: "/brigadev:profile use" });
		assert.deepEqual(action("Doctor"), { kind: "command", command: "/brigadev:doctor" });
		assert.deepEqual(action("Launch dashboard on/off"), { kind: "toggle-dashboard" });
		assert.deepEqual(action("Commands"), { kind: "command", command: "/brigadev:commands" });
		assert.deepEqual(action("Chat"), { kind: "chat" });
		assert.deepEqual(action("Quit"), { kind: "quit" });
	});

	it("only ever reads the permission mode: Permission mode runs `/brigadev:mode status`", () => {
		const entry = allEntries(buildMenu(nine())).find((e) => e.key === "e")!;
		assert.equal(entry.label, "Permission mode");
		assert.deepEqual(entry.action, { kind: "command", command: "/brigadev:mode status" });
	});

	it("top level: the four groups with their digit and ›, then Commands, Chat, Quit", () => {
		const { top } = buildMenu(nine());
		assert.deepEqual(top.map((e) => [e.label, e.key, e.keyLabel]), [
			["Build", "1", "1 ›"],
			["Review & ship", "2", "2 ›"],
			["Inspect", "3", "3 ›"],
			["Settings", "4", "4 ›"],
			["Commands", "k", undefined],
			["Chat", undefined, "↵"],
			["Quit", "q", undefined],
		]);
		assert.deepEqual(top[0].action, { kind: "group", id: "build" });
		assert.deepEqual(top[3].action, { kind: "group", id: "settings" });
	});

	it("a workflow with no group goes to Build, in menu order", () => {
		const menu = buildMenu([workflow("Mine", "mine", undefined, "user"), ...nine().slice(0, 1)]);
		assert.deepEqual(labels(group(menu, "build").items), ["Mine", "New feature"]);
	});

	it("an unknown group name becomes a new category after Review & ship, with the next digit", () => {
		const menu = buildMenu([...nine(), workflow("Write docs", "write-docs", "w", "user", "Docs"), workflow("Spell check", "spell", "z", "user", "docs")]);
		assert.deepEqual(menu.groups.map((g) => [g.id, g.label, g.key]), [
			["build", "Build", "1"],
			["ship", "Review & ship", "2"],
			["docs", "Docs", "5"],
			["inspect", "Inspect", "3"],
			["settings", "Settings", "4"],
		]);
		assert.deepEqual(labels(group(menu, "docs").items), ["Write docs", "Spell check"]);
		assert.deepEqual(menu.top.map((e) => e.label), ["Build", "Review & ship", "Docs", "Inspect", "Settings", "Commands", "Chat", "Quit"]);
		assert.deepEqual(menu.top[2].action, { kind: "group", id: "docs" });
		assert.equal(menu.top[2].keyLabel, "5 ›");
	});

	it("several new categories take 5, 6, … in the order they first appear; beyond 9 they have no digit", () => {
		const extra = Array.from({ length: 7 }, (_, i) => workflow(`W${i}`, `w${i}`, undefined, "user", `Cat ${i}`));
		const menu = buildMenu([...nine(), ...extra]);
		const custom = menu.groups.filter((g) => g.id.startsWith("cat "));
		assert.deepEqual(custom.map((g) => g.key), ["5", "6", "7", "8", "9", undefined, undefined]);
		const top = menu.top.filter((e) => e.label.startsWith("Cat "));
		assert.deepEqual(top.map((e) => [e.key, e.keyLabel]), [["5", "5 ›"], ["6", "6 ›"], ["7", "7 ›"], ["8", "8 ›"], ["9", "9 ›"], [undefined, "›"], [undefined, "›"]]);
		assert.deepEqual(menu.groups.slice(0, 2).map((g) => g.id), ["build", "ship"]);
		assert.deepEqual(menu.groups.slice(-2).map((g) => g.id), ["inspect", "settings"]);
	});

	it("a workflow can name a shipped group by id or label, and joins its tools there", () => {
		const menu = buildMenu([workflow("Audit", "audit", undefined, "user", "Review & Ship"), workflow("Health", "health", undefined, "user", "inspect")]);
		assert.deepEqual(labels(group(menu, "ship").items), ["Audit"]);
		assert.deepEqual(labels(group(menu, "inspect").items), ["Health", "Changes", "Agents history", "Cost", "Usage", "Status", "Panel"]);
		assert.deepEqual(menu.groups.map((g) => g.id), ["ship", "inspect", "settings"]);
	});

	it("leaves out a group with no rows (no workflows loaded) but keeps the other digits", () => {
		const menu = buildMenu([]);
		assert.deepEqual(menu.groups.map((g) => [g.id, g.key]), [["inspect", "3"], ["settings", "4"]]);
		assert.deepEqual(menu.top.map((e) => e.label), ["Inspect", "Settings", "Commands", "Chat", "Quit"]);
	});

	it("shows user workflows too, keyless ones included, each started by its own name", () => {
		const menu = buildMenu([...nine(), workflow("Add endpoint", "add-endpoint", "w", "user"), workflow("Release notes", "release-notes", undefined, "repo")]);
		const added = group(menu, "build").items.slice(-2);
		assert.deepEqual(added.map((e) => [e.label, e.key, e.action]), [
			["Add endpoint", "w", { kind: "workflow", query: "Add endpoint" }],
			["Release notes", undefined, { kind: "workflow", query: "Release notes" }],
		]);
	});

	it("starts exactly its own workflow even when two keyless workflows share a file id", () => {
		const shipped = workflow("Bug fix", "bug-fix");
		const mine = workflow("Defect triage", "bug-fix", undefined, "user");
		const workflows = [shipped, mine];
		const items = group(buildMenu(workflows), "build").items;
		for (const [index, expected] of workflows.entries()) {
			const action = items[index].action;
			assert.equal(action.kind, "workflow");
			assert.equal(resolveWorkflow(workflows, (action as { query: string }).query), expected);
		}
	});

	it("keeps the reserved workflow keys equal to the letter keys of the tool rows", () => {
		const toolKeys = allEntries(buildMenu([])).flatMap((entry) => (entry.key && /[a-z]/.test(entry.key) ? [entry.key] : []));
		assert.deepEqual([...RESERVED_KEYS].sort(), toolKeys.sort());
		assert.deepEqual([...RESERVED_KEYS].sort(), ["a", "c", "e", "g", "h", "k", "m", "o", "q", "s", "t", "y"]);
	});

	it("gives every row an icon and no two rows the same key", () => {
		const entries = allEntries(buildMenu([...nine(), workflow("Mine", "mine", undefined, "user", "Docs")]));
		assert.ok(entries.every((e) => e.icon.length > 0));
		const keys = entries.flatMap((e) => (e.key ? [e.key] : []));
		assert.equal(new Set(keys).size, keys.length);
	});
});

describe("entryForKey and wrapSelection", () => {
	const entries = allEntries(buildMenu(nine()));
	it("finds a row by its key letter or digit and ignores unknown input", () => {
		assert.equal(entryForKey(entries, "x")?.label, "Refactor a component");
		assert.equal(entryForKey(entries, "q")?.label, "Quit");
		assert.equal(entryForKey(entries, "c")?.label, "Cost");
		assert.equal(entryForKey(entries, "2")?.label, "Review & ship");
		assert.equal(entryForKey(entries, "z"), undefined);
		assert.equal(entryForKey(entries, "nn"), undefined);
		assert.equal(entryForKey(entries, "\r"), undefined);
	});

	it("wraps around at both ends", () => {
		assert.equal(wrapSelection(0, -1, 15), 14);
		assert.equal(wrapSelection(14, 1, 15), 0);
		assert.equal(wrapSelection(3, 1, 15), 4);
		assert.equal(wrapSelection(0, 1, 0), 0);
	});
});

describe("renderDashboard", () => {
	const menu = buildMenu(nine());
	const entries = menu.top;
	const input = (over: Partial<Parameters<typeof renderDashboard>[0]> = {}) => ({ width: 100, height: 40, title: "brigadev", subtitle: "mai-pi-harness", entries, selected: 0, hint: DASHBOARD_HINT, ...over });
	const rowOf = (lines: string[], label: string) => lines.findIndex((l) => l.includes(label));
	const synthetic = (count: number): DashboardEntry[] => Array.from({ length: count }, (_, i) => ({ id: `r${i}`, icon: "◇", label: `Row ${i}`, key: String.fromCharCode(97 + i), action: { kind: "chat" } }));

	it("fills exactly the terminal, every line padded to the width", () => {
		const lines = renderDashboard(input(), plain);
		assert.equal(lines.length, 40);
		assert.ok(lines.every((l) => l.length === 100));
	});

	it("shows the title with the repo above the list and the hint below it", () => {
		const lines = renderDashboard(input(), plain);
		const title = lines.findIndex((l) => l.includes("brigadev · mai-pi-harness"));
		assert.ok(title >= 0);
		assert.ok(title < rowOf(lines, "Build"));
		const hint = lines.findIndex((l) => l.includes(DASHBOARD_HINT));
		assert.ok(hint > rowOf(lines, "Quit"));
	});

	it("top level: the four groups with their digit and ›, then Commands, Chat, Quit, keys right-aligned on one column", () => {
		const lines = renderDashboard(input(), plain);
		const columns = new Set<number>();
		for (const entry of entries) columns.add(lines[rowOf(lines, entry.label)].trimEnd().length);
		assert.equal(columns.size, 1);
		assert.match(lines[rowOf(lines, "Review & ship")].trimEnd(), /Review & ship +2 ›$/);
		assert.match(lines[rowOf(lines, "Commands")].trimEnd(), /Commands +k$/);
		assert.match(lines[rowOf(lines, "Chat")].trimEnd(), /Chat +↵$/);
		assert.match(lines[rowOf(lines, "Quit")].trimEnd(), /Quit +q$/);
	});

	it("a group: its name as a heading, its rows with their letters, and the group hint", () => {
		const inspect = group(menu, "inspect");
		const lines = renderDashboard(input({ entries: inspect.items, heading: inspect.label, hint: GROUP_HINT }), plain);
		assert.equal(lines.length, 40);
		assert.ok(lines.every((l) => l.length === 100));
		const heading = lines.findIndex((l) => l.trim() === "Inspect");
		assert.ok(heading >= 0, "heading line");
		assert.ok(heading < rowOf(lines, "Changes"));
		const columns = new Set<number>();
		for (const item of inspect.items) {
			const row = lines[rowOf(lines, item.label)].trimEnd();
			assert.ok(row.endsWith(item.key!), row);
			columns.add(row.length);
		}
		assert.equal(columns.size, 1);
		assert.ok(lines.some((l) => l.includes(GROUP_HINT)));
		assert.ok(!lines.some((l) => l.includes("Commands")));
	});

	it("the group hint says that ← and Esc go back", () => {
		assert.match(GROUP_HINT, /←/);
		assert.match(GROUP_HINT, /Esc back/);
	});

	it("is centered: the list block sits in the middle both ways", () => {
		const lines = renderDashboard(input(), plain);
		const first = lines.findIndex((l) => l.trim());
		const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim());
		assert.ok(Math.abs(first - (lines.length - 1 - last)) <= 1);
		const row = lines[rowOf(lines, "Build")];
		const left = row.length - row.trimStart().length;
		const right = row.length - row.trimEnd().length;
		assert.ok(Math.abs(left - right) <= 1, `left ${left} right ${right}`);
	});

	it("marks only the selected row with the cursor", () => {
		const lines = renderDashboard(input({ selected: 2 }), plain);
		assert.equal(lines.filter((l) => /^ *› /.test(l)).length, 1);
		assert.match(lines[rowOf(lines, "Inspect")], /^ *› .*Inspect/);
	});

	it("keeps one blank line between rows when there is room", () => {
		const lines = renderDashboard(input({ height: 40 }), plain);
		const first = rowOf(lines, "Build");
		assert.equal(rowOf(lines, "Review & ship") - first, 2);
		assert.equal(lines[first + 1].trim(), "");
	});

	it("drops to one line per row on a short terminal and still shows everything", () => {
		const lines = renderDashboard(input({ height: 16 }), plain);
		assert.equal(lines.length, 16);
		assert.equal(rowOf(lines, "Review & ship") - rowOf(lines, "Build"), 1);
		for (const entry of entries) assert.ok(rowOf(lines, entry.label) >= 0, entry.label);
		assert.ok(lines.some((l) => l.includes("brigadev")));
	});

	it("never exceeds the screen and keeps the selected row visible at any size, with and without a heading", () => {
		const long = synthetic(15);
		for (let height = 1; height <= 45; height++) {
			for (const selected of [0, 3, 6]) {
				const lines = renderDashboard(input({ height, width: 60, selected }), plain);
				assert.equal(lines.length, height, `top height ${height}`);
				assert.ok(lines.some((l) => l.includes(entries[selected].label)), `top height ${height} selected ${selected}`);
			}
			for (const selected of [0, 7, 14]) {
				const lines = renderDashboard(input({ height, width: 60, selected, entries: long, heading: "Many", hint: GROUP_HINT }), plain);
				assert.equal(lines.length, height, `group height ${height}`);
				assert.ok(lines.some((l) => l.includes(long[selected].label)), `group height ${height} selected ${selected}`);
			}
		}
		assert.deepEqual(renderDashboard(input({ height: 0 }), plain), []);
	});

	it("never exceeds the width, down to a very narrow terminal", () => {
		const inspect = group(menu, "inspect");
		for (const width of [1, 5, 12, 20, 33, 40, 44, 50, 80, 200]) {
			for (const over of [{}, { entries: inspect.items, heading: inspect.label, hint: GROUP_HINT }]) {
				const lines = renderDashboard(input({ width, selected: 3, ...over }), plain);
				assert.ok(lines.every((l) => l.length <= width), `width ${width}`);
			}
		}
	});

	it("shows the Chat row's Enter key and clamps an out-of-range selection", () => {
		const lines = renderDashboard(input({ selected: 99 }), plain);
		assert.match(lines[rowOf(lines, "Quit")], /› .*Quit/);
		assert.match(lines[rowOf(lines, "Chat")].trimEnd(), /↵$/);
	});

	it("measures with the painter, so wide glyphs keep the keys aligned", () => {
		const wide: Painter = { ...plain, measure: (text) => [...text].reduce((sum, ch) => sum + (ch === "✦" ? 2 : 1), 0) };
		const wideEntries: DashboardEntry[] = [
			{ id: "a", icon: "✦", label: "Alpha", key: "a", action: { kind: "chat" } },
			{ id: "b", icon: "·", label: "Beta", key: "b", action: { kind: "chat" } },
		];
		const lines = renderDashboard({ width: 60, height: 10, title: "t", entries: wideEntries, selected: 0 }, wide);
		const [a, b] = ["Alpha", "Beta"].map((label) => lines.find((l) => l.includes(label))!.trimEnd());
		assert.equal(wide.measure(a), wide.measure(b));
	});
});

describe("hasInitialPrompt", () => {
	it("is false for a bare launch and for flags only", () => {
		assert.equal(hasInitialPrompt([]), false);
		assert.equal(hasInitialPrompt(["--continue"]), false);
		assert.equal(hasInitialPrompt(["-c", "--no-session", "--verbose", "-ne", "-nt"]), false);
	});

	it("is false when the only extra words are values of Pi's documented value flags", () => {
		assert.equal(hasInitialPrompt(["--model", "sonnet:high", "--thinking", "high", "--session", "abc", "-e", "./x.ts", "--mode", "text"]), false);
		assert.equal(hasInitialPrompt(["-n", "my session", "--tools", "read,grep", "--tui-mode", "regular"]), false);
		assert.equal(hasInitialPrompt(["--model=sonnet", "--session-dir=/tmp/s"]), false);
	});

	it("is true for a message, an @file, or anything after --", () => {
		assert.equal(hasInitialPrompt(["fix the login bug"]), true);
		assert.equal(hasInitialPrompt(["@notes.md"]), true);
		assert.equal(hasInitialPrompt(["--model", "sonnet", "review this"]), true);
		assert.equal(hasInitialPrompt(["--", "-weird prompt"]), true);
		assert.equal(hasInitialPrompt(["--continue", "--"]), false);
	});

	it("treats a value after an unknown flag as a prompt (the safe side)", () => {
		assert.equal(hasInitialPrompt(["--some-extension-flag", "value"]), true);
	});
});

describe("hasMessageEntries", () => {
	it("is true only when the branch holds a message", () => {
		assert.equal(hasMessageEntries([]), false);
		assert.equal(hasMessageEntries([{ type: "model_change" }, { type: "thinking_level_change" }, { type: "custom" }]), false);
		assert.equal(hasMessageEntries([{ type: "model_change" }, { type: "message" }]), true);
	});
});

describe("shouldShowDashboard", () => {
	const base: LaunchConditions = { reason: "startup", mode: "tui", branchHasMessages: false, hasInitialPrompt: false, enabled: true, child: false };

	it("shows on a fresh interactive startup", () => {
		assert.equal(shouldShowDashboard(base), true);
	});

	for (const [name, over] of Object.entries({
		"a reload": { reason: "reload" },
		"a new session": { reason: "new" },
		"a resume": { reason: "resume" },
		"a fork": { reason: "fork" },
		rpc: { mode: "rpc" },
		print: { mode: "print" },
		json: { mode: "json" },
		"a non-empty session": { branchHasMessages: true },
		"an initial prompt": { hasInitialPrompt: true },
		"the setting off": { enabled: false },
		"a subagent": { child: true },
	}) as Array<[string, Partial<LaunchConditions>]>) {
		it(`skips for ${name}`, () => {
			assert.equal(shouldShowDashboard({ ...base, ...over }), false);
		});
	}
});
