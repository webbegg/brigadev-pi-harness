import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { maxScroll, pad, renderTwoPane, windowStart, wrapText, type Painter } from "../lib/two-pane.ts";

const plain: Painter = {
	paint: (_tone, text) => text,
	bold: (text) => text,
	measure: (text) => text.length,
	truncate: (text, width) => text.slice(0, width),
};

describe("pad", () => {
	it("cuts to the width and fills with spaces up to it", () => {
		assert.equal(pad(plain, "abc", 6), "abc   ");
		assert.equal(pad(plain, "abcdefgh", 5), "abcde");
		assert.equal(pad(plain, "abc", 0), "");
	});
});

describe("two-pane layout", () => {
	const input = {
		width: 80,
		height: 10,
		title: "Changes · 3 files",
		list: [{ text: "M a.ts" }, { text: "U b.ts" }, { text: "D c.ts" }],
		selected: 1,
		detail: Array.from({ length: 30 }, (_, i) => ({ text: `line ${i}` })),
		detailScroll: 0,
		footer: "j/k select · q close",
	};

	it("fills exactly the terminal: title, rule, body, footer", () => {
		const lines = renderTwoPane(input, plain);
		assert.equal(lines.length, 10);
		assert.ok(lines.every((l) => l.length <= 80));
		assert.match(lines[0], /Changes · 3 files/);
		assert.match(lines[3], /› U b\.ts/);
		assert.match(lines.at(-1)!, /q close/);
	});

	it("clamps detail scrolling to the content", () => {
		const lines = renderTwoPane({ ...input, detailScroll: 999 }, plain);
		assert.match(lines[2], /line 23/);
		assert.match(lines[8], /line 29/);
	});

	it("gives the detail the full width in detail-only mode", () => {
		const lines = renderTwoPane({ ...input, detailOnly: true }, plain);
		assert.doesNotMatch(lines[2], /│/);
		assert.match(lines[2], /^ line 0/);
	});

	it("keeps the selected row visible in long lists", () => {
		assert.equal(windowStart(0, 100, 10), 0);
		assert.equal(windowStart(50, 100, 10), 45);
		assert.equal(windowStart(99, 100, 10), 90);
		assert.equal(maxScroll(5, 10), 0);
	});

	it("wraps on spaces", () => {
		assert.deepEqual(wrapText("the quick brown fox jumps", 10), ["the quick", "brown fox", "jumps"]);
	});
});
