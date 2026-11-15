import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { RunResult } from "../lib/child-run.ts";
import { emptyTally } from "../lib/cost.ts";
import { autoScroll, buildEntries, canTakeOver, entryDetail, listRow, moveSelection, openTakeover, printableText, resolveSelection, scrollView, takeoverFooter, takeoverKey, takeoverKind, viewerFooter, viewerTitle, type RecordedRun, type TrackedRun, type ViewerEntry } from "../lib/subagent-viewer.ts";

const NOW = 1_000_000;
const result = (over: Partial<RunResult> = {}): RunResult => ({ agent: "scout", task: "map the code", exitCode: 0, messages: [], stderr: "", usage: emptyTally(), stopReason: "stop", ...over });
const queuedRun = (over: Partial<RunResult> = {}) => result({ exitCode: -1, queued: true, stopReason: undefined, model: "m-q", ...over });
const runningRun = (over: Partial<RunResult> = {}) => result({ exitCode: -1, stopReason: undefined, startedAt: NOW - 5000, model: "anthropic/m-r", ...over });
const doneRun = (over: Partial<RunResult> = {}) => result({ startedAt: NOW - 60_000, endedAt: NOW - 30_000, model: "m-d", ...over });
const tracked = (id: string, r: RunResult): TrackedRun => ({ id, result: r });
const recorded = (r: RunResult, at: number): RecordedRun => ({ result: r, at });

describe("buildEntries: sync and async runs in one list", () => {
	it("derives the status of every kind of run", () => {
		const entries = buildEntries({
			tracked: [
				tracked("a", queuedRun()),
				tracked("b", runningRun()),
				tracked("c", doneRun()),
				tracked("d", doneRun({ exitCode: 1 })),
				tracked("e", doneRun({ stopReason: "error", errorMessage: "boom" })),
				tracked("f", result({ exitCode: -1, queued: true, cancelled: true, endedAt: NOW - 1000, stopReason: undefined })),
				tracked("g", result({ exitCode: -1, endedAt: NOW - 1000, stopReason: "aborted" })),
			],
			recorded: [],
			now: NOW,
		});
		const byKey = Object.fromEntries(entries.map((e) => [e.key, e.state]));
		assert.deepEqual(byKey, { a: "queued", b: "running", c: "done", d: "failed", e: "failed", f: "cancelled", g: "failed" });
	});

	it("lists async launches that settled without being collected, alongside recorded sync runs", () => {
		const entries = buildEntries({
			tracked: [tracked("async-1", doneRun({ runId: "run-async", agent: "async-scout" }))],
			recorded: [recorded(doneRun({ runId: "run-sync", agent: "sync-scout", endedAt: undefined, startedAt: undefined }), NOW - 90_000)],
			now: NOW,
		});
		assert.deepEqual(entries.map((e) => e.result.agent), ["async-scout", "sync-scout"]);
	});

	it("orders running first, then queued, then finished newest first", () => {
		const entries = buildEntries({
			tracked: [
				tracked("old-done", doneRun({ endedAt: NOW - 50_000, agent: "old-done" })),
				tracked("queued", queuedRun({ agent: "queued" })),
				tracked("new-done", doneRun({ endedAt: NOW - 10_000, agent: "new-done" })),
				tracked("run-early", runningRun({ startedAt: NOW - 20_000, agent: "run-early" })),
				tracked("run-late", runningRun({ startedAt: NOW - 2_000, agent: "run-late" })),
			],
			recorded: [recorded(doneRun({ runId: "r1", agent: "recorded", endedAt: undefined, startedAt: undefined }), NOW - 30_000)],
			now: NOW,
		});
		assert.deepEqual(entries.map((e) => e.result.agent), ["run-late", "run-early", "queued", "new-done", "recorded", "old-done"]);
		assert.deepEqual(entries.map((e) => e.active), [true, true, true, false, false, false]);
	});

	it("does not list a finished sync run twice (tracked in this process and recorded on the branch)", () => {
		const entries = buildEntries({
			tracked: [tracked("t", doneRun({ runId: "same" }))],
			recorded: [recorded(doneRun({ runId: "same" }), NOW - 30_000)],
			now: NOW,
		});
		assert.equal(entries.length, 1);
		assert.equal(entries[0].key, "t");
	});

	it("a cancelled placeholder without a run id is not duplicated by its recorded copy either", () => {
		const cancelled = () => result({ exitCode: -1, queued: true, cancelled: true, endedAt: NOW - 1000, stopReason: undefined });
		const entries = buildEntries({ tracked: [tracked("t", cancelled())], recorded: [recorded(JSON.parse(JSON.stringify(cancelled())), NOW - 500)], now: NOW });
		assert.equal(entries.length, 1);
	});

	it("two runs with the same task and no run id stay distinct entries", () => {
		const entries = buildEntries({ tracked: [], recorded: [recorded(doneRun(), NOW - 1), recorded(doneRun(), NOW - 2)], now: NOW });
		assert.equal(entries.length, 2);
		assert.notEqual(entries[0].key, entries[1].key);
	});

	it("elapsed ticks while running and freezes at the end time; queued and unknown start show none", () => {
		const entries = buildEntries({
			tracked: [tracked("r", runningRun({ startedAt: NOW - 65_000 })), tracked("d", doneRun({ startedAt: NOW - 60_000, endedAt: NOW - 30_000 })), tracked("q", queuedRun())],
			recorded: [recorded(doneRun({ runId: "x", startedAt: undefined, endedAt: undefined }), NOW - 1)],
			now: NOW,
		});
		assert.equal(entries.find((e) => e.key === "r")!.elapsed, "1m05s");
		assert.equal(entries.find((e) => e.key === "d")!.elapsed, "30s");
		assert.equal(entries.find((e) => e.key === "q")!.elapsed, "");
		assert.equal(entries.find((e) => e.key.startsWith("r:"))!.elapsed, "");
	});
});

describe("listRow and viewerTitle", () => {
	const entries = buildEntries({
		tracked: [tracked("q", queuedRun({ agent: "qa" })), tracked("r", runningRun({ agent: "ra", task: "line one\nline two" })), tracked("d", doneRun({ agent: "da" })), tracked("f", doneRun({ agent: "fa", exitCode: 1 }))],
		recorded: [],
		now: NOW,
	});
	const row = (key: string) => listRow(entries.find((e) => e.key === key)!);

	it("shows glyph, agent, elapsed and the first task line", () => {
		assert.deepEqual(row("r"), { text: "◐ ra 5s · line one", tone: "accent" });
		assert.deepEqual(row("d"), { text: "✓ da 30s · map the code", tone: "success" });
		assert.deepEqual(row("f"), { text: "✗ fa 30s · map the code", tone: "error" });
		assert.deepEqual(row("q"), { text: "○ qa · map the code", tone: "muted" });
	});

	it("titles with running, queued and finished counts", () => {
		assert.equal(viewerTitle(entries), "Agents · 1 running · 1 queued · 2 finished");
		assert.equal(viewerTitle([]), "Agents · 0 running · 0 finished");
	});
});

describe("entryDetail: header, saved folder, live thread", () => {
	const entry = (r: RunResult, state = "running") => buildEntries({ tracked: [tracked("x", r)], recorded: [], now: NOW })[0];

	it("shows status, elapsed, model, usage, and task", () => {
		const rows = entryDetail(entry(runningRun({ model: "anthropic/m-r", thinking: "low", route: "definition", task: "do it" })), 60);
		assert.deepEqual(rows.slice(0, 4).map((r) => r.text), ["scout · running · 5s", "anthropic/m-r · low · definition", "0 turns · ↑0 ↓0 · $0", "task: do it"]);
	});

	it("shows the saved folder for a finished run, with the home folder abbreviated", () => {
		const rows = entryDetail(entry(doneRun({ artifactsDir: "/home/u/.brigadev/repo/runs/scout-1" })), 60, "/home/u");
		assert.ok(rows.some((r) => r.text === "saved: ~/.brigadev/repo/runs/scout-1"));
		const absolute = entryDetail(entry(doneRun({ artifactsDir: "/elsewhere/runs/x" })), 60, "/home/u");
		assert.ok(absolute.some((r) => r.text === "saved: /elsewhere/runs/x"));
	});

	it("has no saved line while the folder does not exist yet", () => {
		assert.ok(!entryDetail(entry(runningRun()), 60).some((r) => r.text.startsWith("saved:")));
	});

	it("shows in-progress assistant text after the finished messages", () => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "first answer" }] }] as any;
		const texts = entryDetail(entry(runningRun({ messages, partial: "typing right now" })), 60).map((r) => r.text);
		assert.ok(texts.indexOf("first answer") < texts.findIndex((t) => t.includes("typing right now")));
	});

	it("a failed run ends with its error", () => {
		const rows = entryDetail(entry(doneRun({ exitCode: 1, stderr: "bad thing\nmore" })), 60);
		assert.deepEqual(rows.at(-1), { text: "error: bad thing", tone: "error" });
	});
});

describe("scroll pinning: follow the newest lines unless the user scrolled up", () => {
	const visible = 10;

	it("a pinned active run follows the bottom as content grows", () => {
		const state = scrollView.initial();
		assert.equal(autoScroll(state, 30, visible, true), 20);
		assert.equal(autoScroll(state, 45, visible, true), 35);
	});

	it("scrolling up un-pins; new content then leaves the view where it was", () => {
		let state = scrollView.to(scrollView.initial(), "bottom", 30, visible);
		assert.equal(state.follow, true);
		state = scrollView.by(state, -10, 30, visible);
		assert.deepEqual(state, { scroll: 10, follow: false });
		assert.equal(autoScroll(state, 60, visible, true), 10, "stays where the user left it");
	});

	it("paging back to the bottom pins again", () => {
		let state = { scroll: 10, follow: false };
		state = scrollView.by(state, 10, 30, visible);
		assert.deepEqual(state, { scroll: 20, follow: true });
		state = scrollView.by(state, 10, 30, visible);
		assert.deepEqual(state, { scroll: 20, follow: true }, "clamped to the end");
	});

	it("top unpins, bottom pins", () => {
		assert.deepEqual(scrollView.to({ scroll: 5, follow: true }, "top", 30, visible), { scroll: 0, follow: false });
		assert.deepEqual(scrollView.to({ scroll: 5, follow: false }, "bottom", 30, visible), { scroll: 20, follow: true });
	});

	it("a finished run does not auto-follow, and the scroll is clamped to the content", () => {
		assert.equal(autoScroll({ scroll: 0, follow: true }, 30, visible, false), 0);
		assert.equal(autoScroll({ scroll: 50, follow: false }, 30, visible, false), 20);
	});

	it("a fresh selection starts at the top, pinned (so an active run opens on its newest lines)", () => {
		assert.deepEqual(scrollView.initial(), { scroll: 0, follow: true });
	});
});

describe("selection survives live updates", () => {
	const entries = (...keys: string[]) => buildEntries({ tracked: keys.map((k, i) => tracked(k, doneRun({ endedAt: NOW - i * 1000 }))), recorded: [], now: NOW });

	it("keeps the selected run when new runs appear above it", () => {
		const before = entries("a", "b");
		const sel = resolveSelection(before, { key: "b", index: 1 });
		assert.deepEqual(sel, { key: "b", index: 1 });
		const after = buildEntries({ tracked: [tracked("new", runningRun()), tracked("a", doneRun({ endedAt: NOW - 1000 })), tracked("b", doneRun({ endedAt: NOW - 2000 }))], recorded: [], now: NOW });
		assert.deepEqual(resolveSelection(after, sel), { key: "b", index: 2 });
	});

	it("falls back to the same position when the run is gone, and to nothing when the list is empty", () => {
		assert.deepEqual(resolveSelection(entries("a", "b"), { key: "gone", index: 5 }), { key: "b", index: 1 });
		assert.deepEqual(resolveSelection([], { key: "a", index: 0 }), { key: undefined, index: 0 });
	});

	it("moves by one and stops at both ends", () => {
		const list = entries("a", "b", "c");
		assert.deepEqual(moveSelection(list, { key: "a", index: 0 }, 1), { key: "b", index: 1 });
		assert.deepEqual(moveSelection(list, { key: "c", index: 2 }, 1), { key: "c", index: 2 });
		assert.deepEqual(moveSelection(list, { key: "a", index: 0 }, -1), { key: "a", index: 0 });
	});
});

describe("entryDetail: messages sent to the child show once in the transcript (S4)", () => {
	const entry = (r: RunResult) => buildEntries({ tracked: [tracked("x", r)], recorded: [], now: NOW })[0];
	const said = (text: string) => ({ role: "assistant", content: [{ type: "text", text }] });
	const texts = (r: RunResult, width = 60) => entryDetail(entry(r), width).map((row) => row.text);

	it("shows a steering message where the child received it, and only once", () => {
		const messages = [{ role: "user", content: "THE TASK" }, said("working"), { role: "user", content: "go left instead" }, said("going left")] as any;
		const rows = texts(runningRun({ messages }));
		assert.equal(rows.filter((t) => t.includes("go left instead")).length, 1);
		assert.ok(rows.indexOf("working") < rows.findIndex((t) => t.includes("go left instead")));
		assert.ok(rows.findIndex((t) => t.includes("go left instead")) < rows.indexOf("going left"));
		assert.equal(entryDetail(entry(runningRun({ messages })), 60).find((row) => row.text.includes("go left instead"))?.tone, "accent");
	});

	it("does not repeat the task itself, which the header shows", () => {
		assert.ok(!texts(runningRun({ messages: [{ role: "user", content: "THE TASK, long" }, said("ok")] as any })).some((t) => t.includes("THE TASK, long")));
	});

	it("reads text parts of an array content and wraps long messages", () => {
		const messages = [{ role: "user", content: "task" }, { role: "user", content: [{ type: "text", text: "please also check the migration files carefully" }] }] as any;
		const rows = texts(runningRun({ messages }), 24);
		const at = rows.findIndex((t) => t.startsWith("▸ you: "));
		assert.ok(at >= 0);
		assert.ok(rows.slice(at).filter(Boolean).every((t) => t.length <= 24));
		assert.ok(rows.join(" ").includes("migration"));
	});

	it("a thread that starts with the child's own message still shows a later steering message", () => {
		assert.ok(texts(runningRun({ messages: [said("hi"), { role: "user", content: "late steer" }] as any })).some((t) => t.includes("late steer")));
	});
});

describe("takeover: steer, follow up, abort (pure state)", () => {
	const entryOf = (r: RunResult): ViewerEntry => buildEntries({ tracked: [tracked("x", r)], recorded: [], now: NOW })[0];

	it("only a running run with a live handle can be taken over", () => {
		assert.equal(canTakeOver(entryOf(runningRun()), true), true);
		assert.equal(canTakeOver(entryOf(runningRun()), false), false, "no handle: the child is finished or not started");
		assert.equal(canTakeOver(entryOf(queuedRun()), true), false);
		assert.equal(canTakeOver(entryOf(doneRun()), true), false, "finished runs are not restarted");
		assert.equal(canTakeOver(entryOf(doneRun({ exitCode: 1 })), true), false);
		assert.equal(canTakeOver(undefined, true), false);
	});

	it("opening starts an empty input for that run; nothing opens for a run that cannot be taken over", () => {
		assert.deepEqual(openTakeover(entryOf(runningRun()), true), { key: "x", text: "" });
		assert.equal(openTakeover(entryOf(doneRun()), true), undefined);
		assert.equal(openTakeover(entryOf(runningRun()), false), undefined);
	});

	it("a streaming child is steered, an idle one is followed up", () => {
		assert.equal(takeoverKind(true), "steer");
		assert.equal(takeoverKind(false), "follow_up");
	});

	it("typing appends, backspace removes one character, ctrl+u clears", () => {
		let state = { key: "x", text: "" };
		state = takeoverKey(state, { kind: "text", text: "hel" }).state!;
		state = takeoverKey(state, { kind: "text", text: "lo" }).state!;
		assert.equal(state.text, "hello");
		assert.equal(takeoverKey(state, { kind: "backspace" }).state!.text, "hell");
		assert.equal(takeoverKey({ key: "x", text: "" }, { kind: "backspace" }).state!.text, "");
		assert.equal(takeoverKey({ key: "x", text: "a😀" }, { kind: "backspace" }).state!.text, "a", "one character, not half a surrogate pair");
		assert.equal(takeoverKey(state, { kind: "clear" }).state!.text, "");
	});

	it("the input is bounded", () => {
		const long = takeoverKey({ key: "x", text: "a".repeat(1990) }, { kind: "text", text: "b".repeat(50) }).state!;
		assert.equal(long.text.length, 2000);
	});

	it("submit hands the trimmed text out and closes the input; blank text stays open", () => {
		assert.deepEqual(takeoverKey({ key: "x", text: "  go left " }, { kind: "submit" }), { submit: "go left" });
		assert.deepEqual(takeoverKey({ key: "x", text: "   " }, { kind: "submit" }), { state: { key: "x", text: "   " } });
	});

	it("cancel closes the input without sending anything", () => {
		assert.deepEqual(takeoverKey({ key: "x", text: "draft" }, { kind: "cancel" }), {});
	});

	it("printableText accepts typed and pasted text, and rejects control sequences", () => {
		assert.equal(printableText("a"), "a");
		assert.equal(printableText("héllo wörld"), "héllo wörld");
		assert.equal(printableText("line one\nline two"), "line one line two", "a pasted newline does not send");
		assert.equal(printableText("a\r\nb"), "a b");
		assert.equal(printableText("\x1b[A"), undefined, "an arrow key");
		assert.equal(printableText("\x03"), undefined, "ctrl+c");
		assert.equal(printableText("\t"), undefined);
		assert.equal(printableText(""), undefined);
	});

	it("the footer shows the input line with what it will send, keeping the end of long text visible", () => {
		assert.equal(takeoverFooter({ key: "x", text: "go left" }, "steer", 80), "steer › go left▍ · enter send · esc back");
		assert.equal(takeoverFooter({ key: "x", text: "" }, "follow_up", 80), "follow-up › ▍ · enter send · esc back");
		const narrow = takeoverFooter({ key: "x", text: "0123456789abcdefghij" }, "steer", 40);
		assert.ok(narrow.length <= 39, "one column is left for the footer's indent");
		assert.ok(narrow.includes("…fghij▍"), narrow);
	});

	it("the key hints list steering and abort only where they work", () => {
		assert.ok(!viewerFooter(false).includes("steer"));
		assert.ok(viewerFooter(true).includes("enter steer") && viewerFooter(true).includes("x abort"));
		assert.ok(viewerFooter(false).includes("q close") && viewerFooter(true).includes("q close"));
	});
});
