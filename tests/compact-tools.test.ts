import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	COMPACT_TOOLS,
	compactRow,
	compactToolResolver,
	diffStat,
	formatDuration,
	type CompactDeps,
	type RowInput,
	type RowLine,
} from "../lib/compact-tools.ts";

const text = (rows: RowLine[]) => rows.map((r) => r.text);
const done = (tool: string, args: Record<string, unknown>, extra: Partial<RowInput> = {}): RowInput => ({ tool, args, phase: "done", ...extra });

describe("formatDuration", () => {
	it("shows tenths under 10s, whole seconds under a minute, then minutes", () => {
		assert.equal(formatDuration(200), "0.2s");
		assert.equal(formatDuration(3200), "3.2s");
		assert.equal(formatDuration(14_000), "14s");
		assert.equal(formatDuration(90_000), "1m 30s");
		assert.equal(formatDuration(3_723_000), "1h 2m");
	});
});

describe("diffStat", () => {
	it("counts added and removed lines of a Pi display diff, ignoring context", () => {
		const diff = ["  9 keep", "-10 old a", "-11 old b", "+10 new a", "+11 new b", "+12 new c", " 13 keep", "   ..."].join("\n");
		assert.deepEqual(diffStat(diff), { added: 3, removed: 2 });
		assert.deepEqual(diffStat(undefined), { added: 0, removed: 0 });
	});
});

describe("compact rows: one line per tool when collapsed (S1, S7)", () => {
	it("grep: matches and duration", () => {
		const out = Array.from({ length: 6 }, (_, i) => `extensions/a.ts:${i + 1}: renderResult`).join("\n");
		const rows = compactRow(done("grep", { pattern: "renderResult", path: "extensions/" }, { text: out, elapsedMs: 200 }));
		assert.deepEqual(text(rows), ['✓ grep "renderResult" extensions/ → 6 matches · 0.2s']);
		assert.equal(rows[0]?.tone, "success");
	});

	it("grep: context lines and notices are not matches; none found says 0", () => {
		const out = "a.ts:1: x\na.ts-2- ctx\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";
		assert.deepEqual(text(compactRow(done("grep", { pattern: "x" }, { text: out }))), ['✓ grep "x" → 1 match']);
		assert.deepEqual(text(compactRow(done("grep", { pattern: "x" }, { text: "No matches found", elapsedMs: 100 }))), ['✓ grep "x" → 0 matches · 0.1s']);
	});

	it("find: files and duration", () => {
		const rows = compactRow(done("find", { pattern: "*.ts", path: "lib" }, { text: "a.ts\nb.ts\nc.ts", elapsedMs: 100 }));
		assert.deepEqual(text(rows), ['✓ find "*.ts" lib → 3 files · 0.1s']);
		assert.deepEqual(text(compactRow(done("find", { pattern: "*.zz" }, { text: "No files found matching pattern" }))), ['✓ find "*.zz" → 0 files']);
	});

	it("ls: entries", () => {
		assert.deepEqual(text(compactRow(done("ls", { path: "lib" }, { text: "a.ts\nb.ts/\n\n[500 entries limit reached. Use limit=1000 for more]" }))), ["✓ ls lib → 2 entries"]);
		assert.deepEqual(text(compactRow(done("ls", {}, { text: "(empty directory)" }))), ["✓ ls . → 0 entries"]);
	});

	it("bash: Ran <command> with duration; newlines collapse, long commands truncate", () => {
		assert.deepEqual(text(compactRow(done("bash", { command: "npm test" }, { text: "ok", elapsedMs: 3200 }))), ["✓ Ran npm test · 3.2s"]);
		const rows = compactRow(done("bash", { command: `echo one\necho two ${"x".repeat(200)}` }, { text: "" }));
		assert.equal(rows.length, 1);
		assert.ok(rows[0]!.text.length <= 90, rows[0]!.text);
		assert.match(rows[0]!.text, /^✓ Ran echo one echo two x+…/);
	});

	it("edit: diffstat from details.diff", () => {
		const diff = ["-1 a", "+1 b", "+2 c"].join("\n");
		assert.deepEqual(text(compactRow(done("edit", { path: "extensions/todo.ts" }, { details: { diff } }))), ["✓ Edited extensions/todo.ts +2 −1"]);
		assert.deepEqual(text(compactRow(done("edit", { file_path: "a.ts" }))), ["✓ Edited a.ts"]);
	});

	it("write: lines from the written content", () => {
		assert.deepEqual(text(compactRow(done("write", { path: "lib/x.ts", content: "a\nb\nc\n" }))), ["✓ Wrote lib/x.ts (3 lines)"]);
		assert.deepEqual(text(compactRow(done("write", { path: "lib/x.ts", content: "a" }))), ["✓ Wrote lib/x.ts (1 line)"]);
	});

	it("read: line count, with truncation details and an offset range", () => {
		const body = Array.from({ length: 142 }, (_, i) => `l${i}`).join("\n");
		assert.deepEqual(text(compactRow(done("read", { path: "lib/todo-card.ts" }, { text: body }))), ["✓ read lib/todo-card.ts (142 lines)"]);
		const truncated = { truncation: { truncated: true, outputLines: 2000, totalLines: 5000 } };
		assert.deepEqual(text(compactRow(done("read", { path: "big.log" }, { text: "x", details: truncated }))), ["✓ read big.log (2000 of 5000 lines)"]);
		assert.deepEqual(text(compactRow(done("read", { path: "a.ts", offset: 10, limit: 20 }, { text: "a\nb" }))), ["✓ read a.ts:10-29 (2 lines)"]);
	});

	it("paths under cwd are shown relative", () => {
		assert.deepEqual(text(compactRow(done("read", { path: "/repo/lib/a.ts" }, { text: "a", cwd: "/repo" }))), ["✓ read lib/a.ts (1 line)"]);
	});

	it("long paths and patterns are truncated with an ellipsis, row stays one line", () => {
		const rows = compactRow(done("grep", { pattern: "p".repeat(300), path: "d".repeat(300) }, { text: "No matches found" }));
		assert.equal(rows.length, 1);
		assert.ok(rows[0]!.text.length <= 130, String(rows[0]!.text.length));
		assert.match(rows[0]!.text, /…/);
	});

	it("every compact tool yields exactly one row on success", () => {
		for (const tool of COMPACT_TOOLS) assert.equal(compactRow(done(tool, {}, { text: "a\nb" })).length, 1, tool);
	});
});

describe("compact rows: running timer", () => {
	it("shows a live timer in the running row", () => {
		const rows = compactRow({ tool: "bash", args: { command: "npm test" }, phase: "running", elapsedMs: 14_000 });
		assert.deepEqual(text(rows), ["◐ Running npm test… 14s"]);
		assert.equal(rows[0]?.tone, "accent");
	});

	it("omits the timer before execution starts, and tolerates streaming args", () => {
		assert.deepEqual(text(compactRow({ tool: "bash", args: {}, phase: "running" })), ["◐ Running …"]);
		assert.deepEqual(text(compactRow({ tool: "grep", args: { pattern: "x" }, phase: "running", elapsedMs: 1500 })), ['◐ Searching "x"… 1.5s']);
		for (const tool of COMPACT_TOOLS) assert.equal(compactRow({ tool, args: undefined, phase: "running", elapsedMs: 1000 }).length, 1, tool);
	});
});

describe("compact rows: errors keep the header plus 1-3 error lines", () => {
	it("bash: exit code in the header, last error lines below, marker dropped", () => {
		const out = ["> build", "src/a.ts(1,1): noise", "error TS2345: Argument of type", "error TS2322: Type mismatch", "error TS2304: Cannot find name", "", "Command exited with code 1"].join("\n");
		const rows = compactRow({ tool: "bash", args: { command: "npm run build" }, phase: "error", text: out });
		assert.equal(rows[0]?.text, "✗ bash npm run build · exit 1");
		assert.equal(rows[0]?.tone, "error");
		assert.deepEqual(text(rows).slice(1), ["  error TS2345: Argument of type", "  error TS2322: Type mismatch", "  error TS2304: Cannot find name"]);
	});

	it("never more than 3 error lines, each truncated", () => {
		const out = Array.from({ length: 50 }, (_, i) => `${i} ${"e".repeat(300)}`).join("\n");
		for (const tool of COMPACT_TOOLS) {
			const rows = compactRow({ tool, args: { command: "x", path: "p", pattern: "q" }, phase: "error", text: out });
			assert.ok(rows.length >= 2 && rows.length <= 4, `${tool}: ${rows.length}`);
			for (const r of rows.slice(1)) assert.ok(r.text.length <= 104, `${tool}: ${r.text.length}`);
		}
	});

	it("non-bash errors show the first lines; timeout and abort markers become the reason", () => {
		const rows = compactRow({ tool: "edit", args: { path: "a.ts" }, phase: "error", text: "Could not find the text in a.ts.\nSecond line" });
		assert.deepEqual(text(rows), ["✗ edit a.ts", "  Could not find the text in a.ts.", "  Second line"]);
		const t = compactRow({ tool: "bash", args: { command: "sleep 9" }, phase: "error", text: "partial\n\nCommand timed out after 5 seconds" });
		assert.equal(t[0]?.text, "✗ bash sleep 9 · timed out after 5 seconds");
		assert.equal(compactRow({ tool: "bash", args: { command: "x" }, phase: "error", text: "" }).length, 1);
	});
});

// --- resolver ---------------------------------------------------------------

type Comp = { kind: string; lines?: () => string[]; base?: string };
const fakeDeps = (clock = { now: 0 }, timers: Array<{ fn: () => void; stopped: boolean }> = []): CompactDeps<Comp, string> => ({
	row: (get) => ({ kind: "row", lines: () => get().map((r) => r.text) }),
	empty: () => ({ kind: "empty" }),
	now: () => clock.now,
	every: (fn) => {
		const t = { fn, stopped: false };
		timers.push(t);
		return () => {
			t.stopped = true;
		};
	},
});

const ctx = (over: Record<string, unknown> = {}) => ({
	args: { command: "npm test" },
	state: {} as Record<string, unknown>,
	cwd: "/repo",
	expanded: false,
	isPartial: false,
	isError: false,
	executionStarted: true,
	durationMs: undefined as number | undefined,
	lastComponent: undefined as unknown,
	invalidate: () => {},
	...over,
});

const baseRenderers = {
	renderShell: "default" as const,
	renderCall: (_a: unknown, _t: string, c: { lastComponent?: unknown }): Comp => ({ kind: "base-call", base: String(c.lastComponent ?? "") }),
	renderResult: (): Comp => ({ kind: "base-result" }),
};

describe("compactToolResolver", () => {
	it("returns next() unchanged for tools that are not built in", () => {
		const resolve = compactToolResolver(fakeDeps());
		const sentinel = { renderCall: baseRenderers.renderCall };
		let calls = 0;
		const next = () => (calls++, sentinel);
		assert.equal(resolve("subagent", next), sentinel);
		assert.equal(resolve("mcp__x", () => undefined), undefined);
		assert.equal(calls, 1);
	});

	it("wraps every built-in tool and keeps the base shell", () => {
		const resolve = compactToolResolver(fakeDeps());
		for (const tool of COMPACT_TOOLS) {
			const r = resolve(tool, () => baseRenderers);
			assert.ok(r?.renderCall && r.renderResult, tool);
			assert.equal(r.renderShell, "default");
		}
	});

	it("expanded delegates to the base renderers", () => {
		const r = compactToolResolver(fakeDeps())("bash", () => baseRenderers)!;
		const c = ctx({ expanded: true });
		assert.equal((r.renderCall!({}, "theme", c as never) as Comp).kind, "base-call");
		assert.equal((r.renderResult!({ content: [] }, { expanded: true, isPartial: false }, "theme", c as never) as Comp).kind, "base-result");
	});

	it("collapsed renders one lazy row in the call slot and nothing in the result slot", () => {
		const r = compactToolResolver(fakeDeps())("bash", () => baseRenderers)!;
		const c = ctx({ durationMs: 3200 });
		const call = r.renderCall!(c.args, "theme", c as never) as Comp;
		const result = r.renderResult!({ content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: false }, "theme", c as never) as Comp;
		assert.equal(call.kind, "row");
		assert.equal(result.kind, "empty");
		assert.deepEqual(call.lines!(), ["✓ Ran npm test · 3.2s"]);
	});

	it("a row never hands its own component to the base renderer after toggling", () => {
		const r = compactToolResolver(fakeDeps())("bash", () => baseRenderers)!;
		const c = ctx();
		const own = r.renderCall!(c.args, "t", c as never);
		const expanded = r.renderCall!(c.args, "t", { ...c, expanded: true, lastComponent: own } as never) as Comp;
		assert.equal(expanded.base, "");
	});

	it("falls back to the compact row when next() returns undefined", () => {
		const r = compactToolResolver(fakeDeps())("grep", () => undefined)!;
		const c = ctx({ args: { pattern: "x" }, executionStarted: false });
		const call = r.renderCall!(c.args, "t", c as never) as Comp;
		r.renderResult!({ content: [{ type: "text", text: "a:1: x" }] }, { expanded: false, isPartial: false }, "t", c as never);
		assert.deepEqual(call.lines!(), ['✓ grep "x" → 1 match']);
		const e = { ...c, expanded: true };
		assert.equal((r.renderCall!(c.args, "t", e as never) as Comp).kind, "empty");
		assert.equal((r.renderResult!({ content: [] }, { expanded: true, isPartial: false }, "t", e as never) as Comp).kind, "empty");
	});

	it("errors use the result text and the isError flag", () => {
		const r = compactToolResolver(fakeDeps())("bash", () => baseRenderers)!;
		const c = ctx({ isError: true });
		const call = r.renderCall!(c.args, "t", c as never) as Comp;
		r.renderResult!({ content: [{ type: "text", text: "boom\n\nCommand exited with code 2" }] }, { expanded: false, isPartial: false }, "t", c as never);
		assert.deepEqual(call.lines!(), ["✗ bash npm test · exit 2", "  boom"]);
	});

	it("runs a live timer while the tool runs and clears it once the row settles", () => {
		const clock = { now: 1_000 };
		const timers: Array<{ fn: () => void; stopped: boolean }> = [];
		const r = compactToolResolver(fakeDeps(clock, timers))("bash", () => baseRenderers)!;
		let invalidated = 0;
		const running = ctx({ isPartial: true, invalidate: () => invalidated++ });
		const call = r.renderCall!(running.args, "t", running as never) as Comp;
		assert.equal(timers.length, 1);
		assert.equal(timers[0]!.stopped, false);
		clock.now = 15_000;
		timers[0]!.fn();
		assert.equal(invalidated, 1);
		assert.deepEqual(call.lines!(), ["◐ Running npm test… 14s"]);
		// repeated renders while running do not start more timers
		r.renderCall!(running.args, "t", running as never);
		r.renderResult!({ content: [{ type: "text", text: "partial" }] }, { expanded: false, isPartial: true }, "t", running as never);
		assert.equal(timers.length, 1);
		// settle
		clock.now = 18_000;
		const settled = { ...running, isPartial: false, durationMs: 17_000 };
		r.renderCall!(settled.args, "t", settled as never);
		r.renderResult!({ content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: false }, "t", settled as never);
		assert.equal(timers[0]!.stopped, true);
		assert.deepEqual(call.lines!(), ["✓ Ran npm test · 17s"]);
		clock.now = 99_000;
		assert.deepEqual(call.lines!(), ["✓ Ran npm test · 17s"]);
	});

	it("the timer also stops when a settled row is first seen by a result-only render", () => {
		const timers: Array<{ fn: () => void; stopped: boolean }> = [];
		const r = compactToolResolver(fakeDeps({ now: 0 }, timers))("bash", () => baseRenderers)!;
		const state = {};
		const running = ctx({ isPartial: true, state });
		r.renderCall!(running.args, "t", running as never);
		const settled = ctx({ isPartial: false, state });
		r.renderResult!({ content: [{ type: "text", text: "ok" }] }, { expanded: true, isPartial: false }, "t", settled as never);
		assert.equal(timers[0]!.stopped, true);
	});

	it("a replayed result without a start time or duration shows no timer", () => {
		const r = compactToolResolver(fakeDeps())("bash", () => baseRenderers)!;
		const c = ctx({ executionStarted: false });
		const call = r.renderCall!(c.args, "t", c as never) as Comp;
		r.renderResult!({ content: [{ type: "text", text: "ok" }] }, { expanded: false, isPartial: false }, "t", c as never);
		assert.deepEqual(call.lines!(), ["✓ Ran npm test"]);
	});
});
