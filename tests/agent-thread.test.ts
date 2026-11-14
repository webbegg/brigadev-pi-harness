import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { threadRows } from "../lib/agent-thread.ts";

describe("agent thread", () => {
	it("renders text, tool calls, and bounded tool results", () => {
		const rows = threadRows(
			["brigadev-explore", "task: map auth"],
			[
				{ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "toolCall", name: "read", arguments: { path: "src/auth.ts" } }, { type: "toolCall", name: "bash", arguments: { command: "npm test\n--watch" } }] },
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "1\n2\n3\n4\n5" }] },
				{ role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "boom" }] },
			],
			60,
		);
		const texts = rows.map((r) => r.text);
		assert.deepEqual(texts.slice(0, 2), ["brigadev-explore", "task: map auth"]);
		assert.ok(texts.includes("→ read src/auth.ts"));
		assert.ok(texts.includes("→ bash $ npm test"));
		assert.ok(texts.includes("  … 2 more lines"));
		const one = threadRows([], [{ role: "toolResult", content: "a\nb\nc\nd" }], 60).map((r) => r.text);
		assert.ok(one.includes("  … 1 more line"));
		assert.equal(rows.find((r) => r.text === "  boom")?.tone, "error");
	});

	it("appends in-progress assistant text after the finished messages, wrapped, with a cursor", () => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "done part" }] }];
		const rows = threadRows(["h"], messages, 20, "streaming words that wrap around\nsecond line");
		const texts = rows.map((r) => r.text);
		assert.ok(texts.indexOf("done part") < texts.indexOf("streaming words that"));
		assert.equal(texts.at(-1), "second line ▍");
		assert.ok(rows.slice(texts.indexOf("streaming words that")).every((r) => r.tone === "text"));
	});

	it("shows nothing extra for an empty or blank partial", () => {
		const base = threadRows(["h"], [], 40).map((r) => r.text);
		assert.deepEqual(threadRows(["h"], [], 40, "").map((r) => r.text), base);
		assert.deepEqual(threadRows(["h"], [], 40, "  \n ").map((r) => r.text), base);
		assert.deepEqual(threadRows(["h"], [], 40, undefined).map((r) => r.text), base);
	});
});
