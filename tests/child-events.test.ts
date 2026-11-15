import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySnapshot, foldChildEvent, parseChildLine, type ChildEvent } from "../lib/child-events.ts";

const line = (event: unknown) => JSON.stringify(event);
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
	role: "assistant",
	content,
	usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
	provider: "anthropic",
	model: "claude-sonnet-5-5",
	stopReason: "stop",
	...extra,
});

describe("parseChildLine: one shared event format for a child's JSON stream", () => {
	it("ignores blank lines and lines that are not JSON", () => {
		assert.deepEqual(parseChildLine(""), []);
		assert.deepEqual(parseChildLine("   "), []);
		assert.deepEqual(parseChildLine("not json {"), []);
	});

	it("turns any non-message event into activity named by its type", () => {
		assert.deepEqual(parseChildLine(line({ type: "turn_start" })), [{ type: "activity", label: "turn_start" }]);
		assert.deepEqual(parseChildLine(line({})), [{ type: "activity", label: "event" }]);
	});

	it("an assistant message with tool calls starts each tool, then carries the message", () => {
		const message = assistant([{ type: "text", text: "looking" }, { type: "toolCall", id: "c1", name: "read" }, { type: "toolCall", id: "c2", name: "grep" }]);
		assert.deepEqual(parseChildLine(line({ type: "message_end", message })), [
			{ type: "tool_start", id: "c1", name: "read" },
			{ type: "tool_start", id: "c2", name: "grep" },
			{ type: "message", message },
		]);
	});

	it("an assistant message without tool calls is activity, then the message", () => {
		const message = assistant([{ type: "text", text: "done" }]);
		assert.deepEqual(parseChildLine(line({ type: "message_end", message })), [
			{ type: "activity", label: "assistant message" },
			{ type: "message", message },
		]);
	});

	it("a tool result ends its tool, then carries the message", () => {
		const message = { role: "toolResult", toolCallId: "c1", toolName: "read", content: [] };
		assert.deepEqual(parseChildLine(line({ type: "message_end", message })), [
			{ type: "tool_end", id: "c1", name: "read" },
			{ type: "message", message },
		]);
		const unnamed = { role: "toolResult", toolCallId: "c9", content: [] };
		assert.deepEqual(parseChildLine(line({ type: "message_end", message: unnamed }))[0], { type: "tool_end", id: "c9", name: "tool" });
	});

	it("message_end without a message is plain activity", () => {
		assert.deepEqual(parseChildLine(line({ type: "message_end" })), [{ type: "activity", label: "message_end" }]);
	});
});

describe("foldChildEvent: the single fold that builds a run snapshot", () => {
	it("only message events change the snapshot", () => {
		const snap = emptySnapshot();
		const noise: ChildEvent[] = [
			{ type: "activity", label: "x" },
			{ type: "tool_start", id: "a", name: "read" },
			{ type: "tool_end", id: "a", name: "read" },
		];
		for (const event of noise) assert.equal(foldChildEvent(snap, event), false);
		assert.deepEqual(snap, emptySnapshot());
	});

	it("an assistant message adds usage, model, stop reason, and error", () => {
		const snap = emptySnapshot();
		const message = assistant([{ type: "text", text: "hi" }], { stopReason: "error", errorMessage: "boom" });
		assert.equal(foldChildEvent(snap, { type: "message", message: message as any }), true);
		assert.equal(snap.messages.length, 1);
		assert.equal(snap.model, "anthropic/claude-sonnet-5-5");
		assert.equal(snap.stopReason, "error");
		assert.equal(snap.errorMessage, "boom");
		assert.equal(snap.usage.input, 10);
		assert.equal(snap.usage.output, 5);
	});

	it("a model without a provider is kept bare; non-assistant messages only append", () => {
		const snap = emptySnapshot();
		foldChildEvent(snap, { type: "message", message: assistant([], { provider: undefined, model: "local" }) as any });
		assert.equal(snap.model, "local");
		foldChildEvent(snap, { type: "message", message: { role: "toolResult", toolCallId: "c1", content: [] } as any });
		assert.equal(snap.messages.length, 2);
		assert.equal(snap.usage.input, 10);
	});

	it("parse then fold reproduces a recorded stream", () => {
		const stream = [
			line({ type: "agent_start" }),
			line({ type: "message_end", message: assistant([{ type: "toolCall", id: "c1", name: "read" }], { stopReason: "toolUse" }) }),
			line({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "read", content: [] } }),
			line({ type: "message_end", message: assistant([{ type: "text", text: "answer" }]) }),
		];
		const snap = emptySnapshot();
		let updates = 0;
		for (const raw of stream) for (const event of parseChildLine(raw)) if (foldChildEvent(snap, event)) updates++;
		assert.equal(updates, 3);
		assert.equal(snap.messages.length, 3);
		assert.equal(snap.stopReason, "stop");
		assert.equal(snap.usage.input, 20);
	});
});
