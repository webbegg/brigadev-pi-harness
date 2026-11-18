import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { emptySnapshot, foldChildEvent, MAX_PARTIAL_CHARS, parseChildLine, type ChildEvent } from "../lib/child-events.ts";

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

describe("parseChildLine: streaming events (Pi json.md: message_update, text_delta)", () => {
	const update = (assistantMessageEvent: unknown) => line({ type: "message_update", usage: {}, assistantMessageEvent });

	it("a text delta is a sign of life and a partial", () => {
		assert.deepEqual(parseChildLine(update({ type: "text_delta", contentIndex: 0, delta: "Hel" })), [
			{ type: "activity", label: "message_update" },
			{ type: "partial", delta: "Hel" },
		]);
	});

	it("thinking, tool-call, and other updates are plain activity", () => {
		for (const type of ["thinking_delta", "toolcall_delta", "text_start", "text_end", "start"]) {
			assert.deepEqual(parseChildLine(update({ type, contentIndex: 0, delta: "x" })), [{ type: "activity", label: "message_update" }], type);
		}
		assert.deepEqual(parseChildLine(line({ type: "message_update" })), [{ type: "activity", label: "message_update" }]);
	});

	it("an empty or non-string delta adds nothing", () => {
		assert.deepEqual(parseChildLine(update({ type: "text_delta", contentIndex: 0, delta: "" })), [{ type: "activity", label: "message_update" }]);
		assert.deepEqual(parseChildLine(update({ type: "text_delta", contentIndex: 0, delta: 5 })), [{ type: "activity", label: "message_update" }]);
	});

	it("an assistant message_start resets the live text; other roles do not", () => {
		assert.deepEqual(parseChildLine(line({ type: "message_start", message: { role: "assistant", content: [] } })), [
			{ type: "activity", label: "message_start" },
			{ type: "partial", delta: "", reset: true },
		]);
		assert.deepEqual(parseChildLine(line({ type: "message_start", message: { role: "user", content: "hi" } })), [{ type: "activity", label: "message_start" }]);
	});
});

describe("foldChildEvent: live partial text", () => {
	const partial = (delta: string, reset?: boolean): ChildEvent => ({ type: "partial", delta, ...(reset ? { reset } : {}) });

	it("deltas accumulate in snapshot.partial and report a change", () => {
		const snap = emptySnapshot();
		assert.equal(foldChildEvent(snap, partial("Hel")), true);
		assert.equal(foldChildEvent(snap, partial("lo")), true);
		assert.equal(snap.partial, "Hello");
		assert.deepEqual(snap.messages, [], "a partial is not a message");
	});

	it("the matching assistant message_end clears it and the final message replaces it", () => {
		const snap = emptySnapshot();
		foldChildEvent(snap, partial("Hello wor"));
		const final = assistant([{ type: "text", text: "Hello world" }]);
		assert.equal(foldChildEvent(snap, { type: "message", message: final as any }), true);
		assert.equal(snap.partial, undefined);
		assert.equal(snap.messages.length, 1);
	});

	it("a reset clears it; resetting an empty buffer changes nothing", () => {
		const snap = emptySnapshot();
		assert.equal(foldChildEvent(snap, partial("", true)), false);
		foldChildEvent(snap, partial("old"));
		assert.equal(foldChildEvent(snap, partial("", true)), true);
		assert.equal(snap.partial, undefined);
	});

	it("a tool result message does not clear the next message's live text", () => {
		const snap = emptySnapshot();
		foldChildEvent(snap, partial("next"));
		foldChildEvent(snap, { type: "message", message: { role: "toolResult", toolCallId: "c1", content: [] } as any });
		assert.equal(snap.partial, "next");
	});

	it("is bounded: past the cap only the newest text is kept, marked with a leading ellipsis", () => {
		const snap = emptySnapshot();
		foldChildEvent(snap, partial("a".repeat(MAX_PARTIAL_CHARS)));
		assert.equal(snap.partial!.length, MAX_PARTIAL_CHARS);
		foldChildEvent(snap, partial("END"));
		assert.equal(snap.partial!.length, MAX_PARTIAL_CHARS + 1);
		assert.ok(snap.partial!.startsWith("…") && snap.partial!.endsWith("aaaEND"));
		for (let i = 0; i < 5; i++) foldChildEvent(snap, partial("b".repeat(MAX_PARTIAL_CHARS)));
		assert.ok(snap.partial!.length <= MAX_PARTIAL_CHARS + 1, "stays bounded however much streams");
		foldChildEvent(snap, { type: "message", message: assistant([]) as any });
		assert.equal(snap.partial, undefined, "the cap does not outlive the message");
	});

	it("parse then fold reproduces a streamed message", () => {
		const stream = [
			line({ type: "message_start", message: { role: "assistant", content: [] } }),
			line({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } }),
			line({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "lo" } }),
		];
		const snap = emptySnapshot();
		for (const raw of stream) for (const event of parseChildLine(raw)) foldChildEvent(snap, event);
		assert.equal(snap.partial, "Hello");
		for (const event of parseChildLine(line({ type: "message_end", message: assistant([{ type: "text", text: "Hello" }]) }))) foldChildEvent(snap, event);
		assert.equal(snap.partial, undefined);
		assert.equal(snap.messages.length, 1);
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

describe("parseChildLine: JSON mode records (Pi json.md)", () => {
	it("agent_start, agent_end and agent_settled become run phases after the sign of life", () => {
		assert.deepEqual(parseChildLine(line({ type: "agent_start" })), [{ type: "activity", label: "agent_start" }, { type: "run", phase: "start" }]);
		assert.deepEqual(parseChildLine(line({ type: "agent_end", messages: [], willRetry: false })), [{ type: "activity", label: "agent_end" }, { type: "run", phase: "end" }]);
		assert.deepEqual(parseChildLine(line({ type: "agent_settled", aborted: false })), [{ type: "activity", label: "agent_settled" }, { type: "run", phase: "settled", aborted: false }]);
		assert.deepEqual(parseChildLine(line({ type: "agent_settled", aborted: true })).at(-1), { type: "run", phase: "settled", aborted: true });
	});

	it("the session header is a sign of life, never a transcript message", () => {
		assert.deepEqual(parseChildLine(line({ type: "session", version: 3, id: "u", timestamp: "t", cwd: "/p" })), [{ type: "activity", label: "session" }]);
	});

	it("records that are not session events are signs of life that change nothing", () => {
		const snap = emptySnapshot();
		const stream = [line({ type: "response", command: "get_messages", success: true, data: { messages: [assistant([{ type: "text", text: "x" }])] } }), line({ type: "extension_ui_request", id: "u1", method: "confirm" })];
		for (const raw of stream) for (const event of parseChildLine(raw)) assert.equal(foldChildEvent(snap, event), false);
		assert.deepEqual(snap.messages, []);
		assert.equal(snap.usage.turns, 0);
	});

	it("run events do not change the snapshot", () => {
		const snap = emptySnapshot();
		for (const event of [{ type: "run", phase: "settled", aborted: false }] as ChildEvent[]) assert.equal(foldChildEvent(snap, event), false);
		assert.deepEqual(snap.messages, []);
	});

	it("the task comes back as an ordinary user message_end and is folded once", () => {
		const snap = emptySnapshot();
		const user = { role: "user", content: "the task", timestamp: 1 };
		for (const event of parseChildLine(line({ type: "message_start", message: user }))) foldChildEvent(snap, event);
		for (const event of parseChildLine(line({ type: "message_end", message: user }))) foldChildEvent(snap, event);
		assert.deepEqual(snap.messages, [user]);
	});
});
