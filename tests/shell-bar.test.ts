import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { contextGauge, layoutSegments, statusSegment } from "../lib/shell-bar.ts";

describe("shell bar", () => {
	const segments = [
		{ id: "repo", text: "mai-pi-harness main ±3", priority: 50 },
		{ id: "model", text: "sonnet-5-5 · medium", priority: 80 },
		{ id: "ctx", text: "ctx ▰▰▰▱▱▱▱▱ 45%", priority: 70 },
		{ id: "x", text: "third-party", priority: 10 },
	];

	it("keeps everything when it fits, in order", () => {
		assert.deepEqual(layoutSegments(segments, 200).map((s) => s.id), ["repo", "model", "ctx", "x"]);
	});

	it("drops the lowest priority first on narrow widths", () => {
		assert.deepEqual(layoutSegments(segments, 65).map((s) => s.id), ["repo", "model", "ctx"]);
		assert.deepEqual(layoutSegments(segments, 40).map((s) => s.id), ["model", "ctx"]);
		assert.deepEqual(layoutSegments(segments, 5).map((s) => s.id), ["model"]);
	});

	it("draws the context gauge with warning thresholds", () => {
		assert.deepEqual(contextGauge(45), { text: "ctx ▰▰▰▰▱▱▱▱ 45%", tone: "muted" });
		assert.equal(contextGauge(85).tone, "warning");
		assert.equal(contextGauge(97).tone, "error");
		assert.equal(contextGauge(null).text, "ctx ▱▱▱▱▱▱▱▱ ?%");
	});

	it("compacts brigadev statuses and hides normal mode", () => {
		assert.equal(statusSegment("brigadev-mode", "brigadev: normal"), undefined);
		assert.equal(statusSegment("brigadev-mode", "🚀 brigadev: yolo")?.text, "🚀 yolo");
		assert.equal(statusSegment("brigadev-profile", "profile: economy (session)")?.text, "profile economy (session)");
		assert.equal(statusSegment("other-ext", "MCP: 2")?.priority, 10);
		assert.deepEqual([statusSegment("brigadev-usage", "week 55%")?.text, statusSegment("brigadev-usage", "week 55%")?.tone], ["◷ week 55%", "dim"]);
		assert.equal(statusSegment("brigadev-usage", "5h 91% · week 55%")?.tone, "warning");
		assert.equal(statusSegment("brigadev-usage", "limit reached (five_hour)")?.tone, "error");
	});
});
