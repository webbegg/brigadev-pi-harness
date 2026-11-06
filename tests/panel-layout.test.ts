import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentRun } from "../lib/agents-card.ts";
import type { ChangeEntry } from "../lib/git-changes.ts";
import { renderPanel, type PanelInput, type PanelPainter } from "../lib/panel-layout.ts";
import type { Todo } from "../lib/todo-card.ts";

const plain: PanelPainter = {
	paint: (_tone, text) => text,
	bold: (text) => text,
	measure: (text) => text.length,
	truncate: (text, width) => text.slice(0, Math.max(0, width)),
	fill: (text) => text,
};

const NOW = 1_000_000;

const todos: Todo[] = [
	{ id: "T1", text: "parser", status: "done" },
	{ id: "T2", text: "extension", status: "in_progress" },
	{ id: "T3", text: "docs", status: "pending" },
];

const run = (over: Partial<AgentRun>): AgentRun => ({ id: "r", agent: "scout", task: "map the repo", state: "running", tokens: 0, cost: 0, startedAt: NOW - 12_000, ...over });

const change = (path: string, over: Partial<ChangeEntry> = {}): ChangeEntry => ({ path, status: "M", added: 1, deleted: 0, ...over });

const base = (over: Partial<PanelInput> = {}): PanelInput => ({
	width: 44,
	height: 60,
	now: NOW,
	todos: [],
	runs: [],
	changes: [],
	session: { model: "claude-sonnet-5-5", thinking: "medium", contextPercent: 45 },
	...over,
});

const render = (over: Partial<PanelInput> = {}, painter: PanelPainter = plain) => renderPanel(base(over), painter);
const indexOf = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle));

describe("renderPanel structure", () => {
	it("lists the sections in order with one-row headers", () => {
		const lines = render({ todos, runs: [run({})], changes: [change("a.ts")] });
		const order = ["▾ TODOS", "▾ AGENTS", "▾ CHANGES", "▾ SESSION"].map((h) => indexOf(lines, h));
		assert.ok(order.every((i) => i >= 0), `missing header in ${JSON.stringify(order)}`);
		assert.deepEqual(order, [...order].sort((a, b) => a - b));
	});

	it("starts every line with the muted left border", () => {
		const painter: PanelPainter = { ...plain, paint: (tone, text) => (tone === "borderMuted" ? `<${text}>` : text) };
		for (const line of render({ todos }, painter)) assert.ok(line.startsWith("<│>"), line);
	});

	it("shows muted idle rows for empty sections", () => {
		const lines = render();
		assert.ok(lines.some((l) => l.includes("none") && !l.includes("alt+a")), "todos idle");
		assert.ok(indexOf(lines, "none · alt+a history") >= 0, "agents idle");
		assert.ok(indexOf(lines, "clean") >= 0, "changes idle");
		const painter: PanelPainter = { ...plain, paint: (tone, text) => (tone === "dim" ? `<${text}>` : text) };
		assert.ok(render({}, painter).some((l) => l.includes("<clean>") || l.includes("clean>")), "idle rows use the dim tone");
	});

	it("reports git as unavailable instead of clean when there is no repository", () => {
		assert.ok(indexOf(render({ changes: undefined }), "not a git repo") >= 0);
	});
});

describe("renderPanel width", () => {
	const busy: Partial<PanelInput> = {
		todos: [...todos, { id: "T4", text: "a very long todo text that cannot possibly fit in a forty four column panel", status: "pending" }],
		runs: [run({ task: "investigate the extremely long task description that overflows" }), run({ id: "d", state: "done", endedAt: NOW - 1000 })],
		changes: [change("lib/some/deeply/nested/directory/with/a/very-long-file-name.ts", { added: 120, deleted: 33 }), change("b.ts", { status: "U" })],
		session: { model: "provider/some-extremely-long-model-identifier-name", thinking: "high", contextPercent: 97, cost: { cost: 12.5, apiEquivalent: true }, usage: { text: "5h 92% · week 55%", tone: "warning" }, profile: "economy", yolo: true },
	};

	for (const width of [44, 30, 20]) {
		it(`pads and truncates every line to exactly ${width} columns`, () => {
			const lines = render({ ...busy, width });
			assert.ok(lines.length > 0);
			for (const line of lines) assert.equal(line.length, width, JSON.stringify(line));
		});
	}

	it("clips a long path from the left so the file name stays", () => {
		const lines = render({ changes: [change("lib/some/deeply/nested/directory/with/a/very-long-file-name.ts", { added: 120, deleted: 33 })] });
		const row = lines.find((l) => l.includes("very-long-file-name.ts"));
		assert.ok(row, "file name survives");
		assert.ok(row.includes("…"), "marks the clipped part");
		assert.ok(row.includes("+120 −33"), "keeps the counts");
	});

	it("clips a long agent task and keeps the elapsed column", () => {
		const lines = render({ runs: [run({ task: "investigate the extremely long task description that overflows" })] });
		const row = lines.find((l) => l.includes("scout"));
		assert.ok(row);
		assert.ok(row.includes("…"));
		assert.ok(row.trimEnd().endsWith("12s"), row);
	});
});

describe("renderPanel sections", () => {
	it("summarizes todos as done/total and lists the card rows", () => {
		const lines = render({ todos });
		const header = lines.find((l) => l.includes("▾ TODOS"))!;
		assert.ok(header.includes("1/3"), header);
		assert.ok(indexOf(lines, "◐ T2 extension") >= 0);
		assert.ok(indexOf(lines, "○ T3 docs") >= 0);
	});

	it("shows a finished todo list as complete rather than empty", () => {
		const lines = render({ todos: [{ id: "T1", text: "x", status: "done" }] });
		assert.ok(lines.find((l) => l.includes("▾ TODOS"))!.includes("1/1"));
		assert.ok(indexOf(lines, "all done") >= 0);
	});

	it("lists running agents first, then recent finished ones, and counts the running", () => {
		const lines = render({
			runs: [
				run({ id: "a", agent: "judge", state: "done", endedAt: NOW - 5000, startedAt: NOW - 30_000 }),
				run({ id: "b", agent: "writer", state: "running" }),
				run({ id: "c", agent: "old", state: "done", endedAt: NOW - 120_000, startedAt: NOW - 200_000 }),
			],
		});
		assert.ok(lines.find((l) => l.includes("▾ AGENTS"))!.includes("1 running"));
		assert.ok(indexOf(lines, "writer") < indexOf(lines, "judge"));
		assert.equal(indexOf(lines, "old"), -1, "finished runs past their TTL are hidden");
		assert.ok(lines.find((l) => l.includes("judge"))!.includes("✓"));
		assert.ok(lines.find((l) => l.includes("writer"))!.includes("◐"));
	});

	it("summarizes changes with files and line totals", () => {
		const lines = render({ changes: [change("a.ts", { added: 3, deleted: 1 }), change("b.ts", { status: "A", added: 2, deleted: 0 })] });
		assert.ok(lines.find((l) => l.includes("▾ CHANGES"))!.includes("2 files +5 −1"));
		assert.ok(indexOf(lines, "M a.ts") >= 0);
		assert.ok(indexOf(lines, "A b.ts") >= 0);
	});

	it("shows at most 8 files and folds the rest into one row", () => {
		const lines = render({ changes: Array.from({ length: 12 }, (_, i) => change(`f${String(i).padStart(2, "0")}.ts`)) });
		assert.equal(lines.filter((l) => /M f\d\d\.ts/.test(l)).length, 8);
		assert.ok(indexOf(lines, "… 4 more · alt+g") >= 0);
	});

	it("shows model, thinking, gauge, cost, usage, profile and yolo in the session section", () => {
		const lines = render({
			session: { model: "claude-sonnet-5-5", thinking: "medium", contextPercent: 45, cost: { cost: 0.42, apiEquivalent: true }, usage: { text: "week 55%", tone: "muted" }, profile: "economy", yolo: true },
		});
		for (const needle of ["claude-sonnet-5-5 · medium", "ctx ▰▰▰▰▱▱▱▱ 45%", "$0.420 API-eq", "week 55%", "economy", "yolo"]) {
			assert.ok(indexOf(lines, needle) >= 0, `missing ${needle}`);
		}
	});

	it("leaves out the optional session rows when there is nothing to say", () => {
		const lines = render({ session: { contextPercent: null } });
		assert.ok(indexOf(lines, "no model") >= 0);
		assert.ok(indexOf(lines, "ctx ▱▱▱▱▱▱▱▱ ?%") >= 0);
		assert.equal(indexOf(lines, "yolo"), -1);
		assert.equal(indexOf(lines, "profile"), -1);
		assert.equal(indexOf(lines, "$"), -1);
	});
});

describe("renderPanel height budget", () => {
	const full: Partial<PanelInput> = {
		todos: Array.from({ length: 6 }, (_, i) => ({ id: `T${i + 1}`, text: "task", status: i < 2 ? "done" : "pending" }) as Todo),
		runs: [run({ id: "1" }), run({ id: "2", agent: "writer" }), run({ id: "3", agent: "judge" })],
		changes: Array.from({ length: 20 }, (_, i) => change(`file${i}.ts`)),
		session: { model: "m", thinking: "low", contextPercent: 10, cost: { cost: 1, apiEquivalent: false }, usage: { text: "week 5%", tone: "muted" }, profile: "p", yolo: true },
	};

	it("never exceeds the height, at any height", () => {
		for (let height = 0; height <= 60; height++) {
			const lines = render({ ...full, height });
			assert.ok(lines.length <= height, `height ${height} got ${lines.length}`);
			for (const line of lines) assert.equal(line.length, 44);
		}
	});

	it("folds changes before it touches todos and agents", () => {
		const roomy = render({ ...full, height: 60 });
		const tight = render({ ...full, height: roomy.length - 4 });
		assert.equal(tight.length, roomy.length - 4);
		for (const needle of ["T3 task", "T6 task", "writer", "judge"]) assert.ok(indexOf(tight, needle) >= 0, `${needle} kept`);
		assert.ok(tight.filter((l) => /M file\d+\.ts/.test(l)).length < roomy.filter((l) => /M file\d+\.ts/.test(l)).length);
		assert.ok(tight.some((l) => /… \d+ more · alt\+g/.test(l)));
	});

	it("keeps every section header while rows fold", () => {
		const lines = render({ ...full, height: 12 });
		for (const header of ["▾ TODOS", "▾ AGENTS", "▾ CHANGES", "▾ SESSION"]) assert.ok(indexOf(lines, header) >= 0, header);
	});

	it("returns only its content when there is spare room", () => {
		assert.ok(render({ height: 60 }).length < 60);
	});
});
