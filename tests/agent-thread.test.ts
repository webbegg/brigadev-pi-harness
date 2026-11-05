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
});
