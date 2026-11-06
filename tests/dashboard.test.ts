import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEntries, DASHBOARD_HINT, entryForKey, hasInitialPrompt, hasMessageEntries, moveSelection, renderDashboard, shouldShowDashboard, type DashboardEntry, type LaunchConditions } from "../lib/dashboard.ts";
import type { Painter } from "../lib/two-pane.ts";
import type { Workflow } from "../lib/workflows.ts";

const plain: Painter = {
	paint: (_tone, text) => text,
	bold: (text) => text,
	measure: (text) => text.length,
	truncate: (text, width) => text.slice(0, width),
};

const workflow = (name: string, id: string, key?: string, source: Workflow["source"] = "package"): Workflow => ({
	name,
	description: `About ${name}`,
	order: 1,
	questions: [],
	body: "body",
	source,
	filePath: `/w/${id}.md`,
	...(key ? { key } : {}),
});

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
const nine = () => NINE.map(([name, id, key]) => workflow(name, id, key));

describe("buildEntries", () => {
	it("lists the workflows first, then Changes, Agents history, Model profile, Commands, Chat, Quit", () => {
		const entries = buildEntries(nine());
		assert.deepEqual(
			entries.map((e) => [e.label, e.key]),
			[...NINE.map(([name, , key]) => [name, key]), ["Changes", "g"], ["Agents history", "a"], ["Model profile", "m"], ["Commands", "k"], ["Chat", undefined], ["Quit", "q"]],
		);
	});

	it("maps workflows to the start command by key and tools to their actions", () => {
		const entries = buildEntries(nine());
		assert.deepEqual(entries[1].action, { kind: "workflow", query: "b" });
		const action = (label: string) => entries.find((e) => e.label === label)!.action;
		assert.deepEqual(action("Changes"), { kind: "command", command: "/brigadev:changes" });
		assert.deepEqual(action("Agents history"), { kind: "command", command: "/brigadev:runs" });
		assert.deepEqual(action("Model profile"), { kind: "command", command: "/brigadev:profile use" });
		assert.deepEqual(action("Commands"), { kind: "command", command: "/brigadev:commands" });
		assert.deepEqual(action("Chat"), { kind: "chat" });
		assert.deepEqual(action("Quit"), { kind: "quit" });
	});

	it("shows user workflows too, keyless ones start by file id", () => {
		const entries = buildEntries([...nine(), workflow("Add endpoint", "add-endpoint", "e", "user"), workflow("Release notes", "release-notes", undefined, "repo")]);
		const added = entries.slice(9, 11);
		assert.deepEqual(added.map((e) => [e.label, e.key, e.action]), [
			["Add endpoint", "e", { kind: "workflow", query: "e" }],
			["Release notes", undefined, { kind: "workflow", query: "release-notes" }],
		]);
		assert.equal(entries[11].label, "Changes");
	});

	it("gives every row an icon", () => {
		assert.ok(buildEntries([...nine(), workflow("Mine", "mine")]).every((e) => e.icon.length > 0));
	});
});

describe("entryForKey and moveSelection", () => {
	const entries = buildEntries(nine());
	it("finds a row by its key letter and ignores unknown input", () => {
		assert.equal(entryForKey(entries, "x")?.label, "Refactor a component");
		assert.equal(entryForKey(entries, "q")?.label, "Quit");
		assert.equal(entryForKey(entries, "z"), undefined);
		assert.equal(entryForKey(entries, "nn"), undefined);
		assert.equal(entryForKey(entries, "\r"), undefined);
	});

	it("wraps around at both ends", () => {
		assert.equal(moveSelection(0, -1, 15), 14);
		assert.equal(moveSelection(14, 1, 15), 0);
		assert.equal(moveSelection(3, 1, 15), 4);
		assert.equal(moveSelection(0, 1, 0), 0);
	});
});

describe("renderDashboard", () => {
	const entries = buildEntries(nine());
	const input = (over: Partial<Parameters<typeof renderDashboard>[0]> = {}) => ({ width: 100, height: 40, title: "brigadev", subtitle: "mai-pi-harness", entries, selected: 0, hint: DASHBOARD_HINT, ...over });
	const rowOf = (lines: string[], label: string) => lines.findIndex((l) => l.includes(label));

	it("fills exactly the terminal, every line padded to the width", () => {
		const lines = renderDashboard(input(), plain);
		assert.equal(lines.length, 40);
		assert.ok(lines.every((l) => l.length === 100));
	});

	it("shows the title with the repo above the list and the hint below it", () => {
		const lines = renderDashboard(input(), plain);
		const title = lines.findIndex((l) => l.includes("brigadev · mai-pi-harness"));
		assert.ok(title >= 0);
		assert.ok(title < rowOf(lines, "New feature"));
		const hint = lines.findIndex((l) => l.includes(DASHBOARD_HINT));
		assert.ok(hint > rowOf(lines, "Quit"));
	});

	it("is centered: the list block sits in the middle both ways", () => {
		const lines = renderDashboard(input(), plain);
		const first = lines.findIndex((l) => l.trim());
		const last = lines.length - 1 - [...lines].reverse().findIndex((l) => l.trim());
		assert.ok(Math.abs(first - (lines.length - 1 - last)) <= 1);
		const row = lines[rowOf(lines, "New feature")];
		const left = row.length - row.trimStart().length;
		const right = row.length - row.trimEnd().length;
		assert.ok(Math.abs(left - right) <= 1, `left ${left} right ${right}`);
	});

	it("right-aligns the key letters on one column, at the end of each row", () => {
		const lines = renderDashboard(input(), plain);
		const columns = new Set<number>();
		for (const [name, , key] of NINE) {
			const row = lines[rowOf(lines, name)].trimEnd();
			assert.ok(row.endsWith(key), row);
			columns.add(row.length);
		}
		for (const label of ["Changes", "Agents history", "Model profile", "Commands", "Quit"]) columns.add(lines[rowOf(lines, label)].trimEnd().length);
		assert.equal(columns.size, 1);
	});

	it("marks only the selected row with the cursor", () => {
		const lines = renderDashboard(input({ selected: 2 }), plain);
		assert.equal(lines.filter((l) => l.includes("›")).length, 1);
		assert.match(lines[rowOf(lines, "Review a PR or branch")], /› .*Review a PR or branch/);
	});

	it("keeps one blank line between rows when there is room", () => {
		const lines = renderDashboard(input({ height: 40 }), plain);
		const first = rowOf(lines, "New feature");
		assert.equal(rowOf(lines, "Bug fix") - first, 2);
		assert.equal(lines[first + 1].trim(), "");
	});

	it("drops to one line per row on a short terminal and still shows everything", () => {
		const lines = renderDashboard(input({ height: 22 }), plain);
		assert.equal(lines.length, 22);
		assert.equal(rowOf(lines, "Bug fix") - rowOf(lines, "New feature"), 1);
		for (const entry of entries) assert.ok(rowOf(lines, entry.label) >= 0, entry.label);
		assert.ok(lines.some((l) => l.includes("brigadev")));
	});

	it("never exceeds the screen and keeps the selected row visible at any size", () => {
		for (let height = 1; height <= 45; height++) {
			for (const selected of [0, 7, 14]) {
				const lines = renderDashboard(input({ height, width: 60, selected }), plain);
				assert.equal(lines.length, height, `height ${height}`);
				assert.ok(lines.some((l) => l.includes(entries[selected].label)), `height ${height} selected ${selected}`);
			}
		}
		assert.deepEqual(renderDashboard(input({ height: 0 }), plain), []);
	});

	it("never exceeds the width, down to a very narrow terminal", () => {
		for (const width of [1, 5, 12, 20, 33, 40, 44, 50, 80, 200]) {
			const lines = renderDashboard(input({ width, selected: 6 }), plain);
			assert.ok(lines.every((l) => l.length <= width), `width ${width}`);
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
