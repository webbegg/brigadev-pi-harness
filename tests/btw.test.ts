import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BTW_AGENT, BTW_ANSWER_MAX, BTW_CARD_LINES, BTW_ENTRY_TYPE, BTW_REASON, btwCard, btwEntry, btwTask, btwTitle, createAsideTracker, hideAsides } from "../lib/btw.ts";
import type { LaunchResult } from "../lib/subagent-launch.ts";
import type { LaunchSummary, SubagentRegistry, WaitOutcome } from "../lib/subagent-registry.ts";

const summary = (id: string, over: Partial<LaunchSummary> = {}): LaunchSummary => ({ id, status: "settled", total: 1, done: 1, startedAt: 0, settledAt: 1, consumed: false, error: undefined, ...over });
const answer = (text: string, isError = false): LaunchResult => ({ content: [{ type: "text", text }], details: { mode: "single", results: [] }, ...(isError ? { isError } : {}) });

describe("constants", () => {
	it("runs brigadev-explore for the reason 'by the way', recorded under its own entry type", () => {
		assert.equal(BTW_AGENT, "brigadev-explore");
		assert.equal(BTW_REASON, "by the way");
		assert.equal(BTW_ENTRY_TYPE, "brigadev-btw");
	});
});

describe("btwTitle / btwTask", () => {
	it("the title is the first non-empty line, whitespace collapsed, cut with an ellipsis at 60 characters", () => {
		assert.equal(btwTitle("\n  what   does\tthis do?\nsecond line"), "what does this do?");
		const long = btwTitle("x".repeat(100));
		assert.equal(Array.from(long).length, 60);
		assert.ok(long.endsWith("…"));
		assert.equal(btwTitle("   "), "by the way");
	});

	it("the task carries the question verbatim and asks for a direct, read-only answer", () => {
		const task = btwTask("where is the delivery buffer?");
		assert.match(task, /where is the delivery buffer\?/);
		assert.match(task, /read-only/i);
		assert.match(task, /directly/i);
	});
});

describe("aside tracker and model visibility", () => {
	it("a marked launch id is an aside with its question; others are model-visible", () => {
		const tracker = createAsideTracker();
		tracker.mark("L1", "why?");
		assert.equal(tracker.has("L1"), true);
		assert.equal(tracker.question("L1"), "why?");
		assert.equal(tracker.has("L2"), false);
		assert.equal(tracker.isModelVisible("L1"), false);
		assert.equal(tracker.isModelVisible("L2"), true);
		tracker.clear();
		assert.equal(tracker.has("L1"), false);
	});

	it("hideAsides: wait and cancel answer 'unknown' for an aside and never reach the registry; other ids pass through", async () => {
		const tracker = createAsideTracker();
		tracker.mark("BTW", "q");
		const calls: string[] = [];
		const settled: WaitOutcome<LaunchResult> = { status: "settled", launch: summary("OTHER"), result: answer("r") };
		const registry = {
			wait: async (id: string) => (calls.push(`wait ${id}`), settled),
			cancel: async (id: string) => (calls.push(`cancel ${id}`), settled),
		} as Pick<SubagentRegistry<LaunchResult>, "wait" | "cancel">;
		const view = hideAsides(registry, tracker);
		assert.deepEqual(await view.wait("BTW", 1000), { status: "unknown" });
		assert.deepEqual(await view.cancel("BTW"), { status: "unknown" });
		assert.deepEqual(calls, [], "an aside is neither waited for nor cancelled through the model's tools");
		assert.equal(await view.wait("OTHER", 1000), settled);
		assert.equal(await view.cancel("OTHER"), settled);
		assert.deepEqual(calls, ["wait OTHER", "cancel OTHER"]);
	});
});

describe("btwEntry", () => {
	it("an answered aside records the question, the answer and the launch id", () => {
		const entry = btwEntry({ id: "L1", question: "what is X?", launch: summary("L1"), result: answer("X is Y") });
		assert.deepEqual(entry, { id: "L1", title: "what is X?", question: "what is X?", status: "answered", answer: "X is Y" });
	});

	it("a launch that threw, or a result flagged as an error, is failed and says why", () => {
		const threw = btwEntry({ id: "L2", question: "q", launch: summary("L2", { error: "boom" }) });
		assert.equal(threw.status, "failed");
		assert.equal(threw.error, "boom");
		const flagged = btwEntry({ id: "L3", question: "q", launch: summary("L3"), result: answer("Agent error: nope", true) });
		assert.equal(flagged.status, "failed");
		assert.equal(flagged.error, "Agent error: nope");
		assert.equal(flagged.answer, undefined);
	});

	it("a settled launch with no result is failed, not an empty answer", () => {
		const entry = btwEntry({ id: "L4", question: "q", launch: summary("L4") });
		assert.equal(entry.status, "failed");
		assert.match(entry.error ?? "", /no answer/);
	});

	it("a very long answer is cut to BTW_ANSWER_MAX characters with a marker", () => {
		const entry = btwEntry({ id: "L5", question: "q", launch: summary("L5"), result: answer("a".repeat(BTW_ANSWER_MAX + 500)) });
		assert.ok(entry.answer !== undefined && entry.answer.length < BTW_ANSWER_MAX + 100);
		assert.match(entry.answer!, /\(answer cut at/);
	});
});

describe("btwCard", () => {
	const data = { id: "L1", title: "what is X?", question: "what is X?", status: "answered" as const, answer: Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n") };

	it("collapsed: a header and the first BTW_CARD_LINES lines, then how many are hidden", () => {
		const card = btwCard(data, false);
		assert.equal(card.lines[0].text, "■ by the way · what is X? · answered · L1");
		assert.equal(card.lines[0].tone, "success");
		assert.equal(card.lines.slice(1, 1 + BTW_CARD_LINES).length, BTW_CARD_LINES);
		assert.ok(card.lines[1].text.includes("line 1"));
		assert.equal(card.hidden, 12 - BTW_CARD_LINES);
		assert.match(card.lines.at(-1)!.text, new RegExp(`… ${12 - BTW_CARD_LINES} more lines`));
	});

	it("expanded: only the header, the whole answer is the body", () => {
		const card = btwCard(data, true);
		assert.equal(card.lines.length, 1);
		assert.equal(card.hidden, 0);
		assert.equal(card.body, data.answer);
	});

	it("a failed aside shows an error header and the error text", () => {
		const card = btwCard({ id: "L2", title: "t", question: "t", status: "failed", error: "boom" }, false);
		assert.equal(card.lines[0].text, "✗ by the way · t · failed · L2");
		assert.equal(card.lines[0].tone, "error");
		assert.ok(card.lines.some((l) => l.text.includes("Error: boom")));
	});

	it("an entry with no data still renders a header", () => {
		const card = btwCard(undefined, false);
		assert.match(card.lines[0].text, /by the way/);
	});
});
