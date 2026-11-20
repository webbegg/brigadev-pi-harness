import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runUiCommand, type BrigadevSettings } from "../lib/runtime.ts";
import { contextGauge, KNOWN_STATUS_ORDER, layoutSegments, statusSegment } from "../lib/shell-bar.ts";

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

	it("keeps the gauge as ?% (with the capacity when known) while occupancy is unknown", () => {
		for (const unknown of [null, undefined, Number.NaN]) assert.deepEqual(contextGauge(unknown), { text: "ctx ▱▱▱▱▱▱▱▱ ?%", tone: "dim" });
		assert.equal(contextGauge(null, 8, 200_000).text, "ctx ▱▱▱▱▱▱▱▱ ?%/200k");
		assert.equal(contextGauge(undefined, 8, 1_000_000).text, "ctx ▱▱▱▱▱▱▱▱ ?%/1.0M");
		assert.equal(contextGauge(null, 8, 0).text, "ctx ▱▱▱▱▱▱▱▱ ?%");
		assert.equal(contextGauge(null, 8, null).text, "ctx ▱▱▱▱▱▱▱▱ ?%");
		// A known occupancy is unchanged by the capacity.
		assert.equal(contextGauge(45, 8, 200_000).text, "ctx ▰▰▰▰▱▱▱▱ 45%");
	});

	it("shows the pull request segment, which drops before the repo, gauge, and model", () => {
		assert.deepEqual(statusSegment("brigadev-pr", "PR #12"), { id: "brigadev-pr", text: "PR #12", tone: "accent", priority: 45 });
		assert.ok(KNOWN_STATUS_ORDER.includes("brigadev-pr"));
		const bar = [
			{ id: "repo", text: "repo main", priority: 50 },
			{ id: "model", text: "sonnet · medium", priority: 80 },
			{ id: "ctx", text: "ctx ▰▰▰▱▱▱▱▱ 45%", priority: 70 },
			statusSegment("brigadev-pr", "PR #12")!,
		];
		assert.deepEqual(layoutSegments(bar, 200).map((s) => s.id), ["repo", "model", "ctx", "brigadev-pr"]);
		assert.ok(!layoutSegments(bar, 50).some((s) => s.id === "brigadev-pr"));
		assert.deepEqual(layoutSegments(bar, 50).map((s) => s.id), ["repo", "model", "ctx"]);
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

describe("runUiCommand", () => {
	const store = (initial: BrigadevSettings = {}) => {
		const writes: BrigadevSettings[] = [];
		return { writes, read: () => initial, write: (update: BrigadevSettings) => void writes.push(update) };
	};

	it("writes the footer setting, keeping the other ui settings", () => {
		const s = store({ ui: { compactTools: false } });
		assert.deepEqual(runUiCommand("  footer   off ", s), { feature: "footer", message: "brigadev footer off" });
		assert.deepEqual(s.writes, [{ ui: { compactTools: false, footer: false } }]);
	});

	it("writes the confirmStop setting; it applies after /reload", () => {
		const s = store({ ui: { footer: false } });
		assert.deepEqual(runUiCommand("confirmStop off", s), { feature: "confirmStop", message: "brigadev confirmStop off (applies after /reload)" });
		assert.deepEqual(s.writes, [{ ui: { footer: false, confirmStop: false } }]);
	});

	it("shows the current state and the usage, and writes nothing, for anything else", () => {
		for (const args of ["", "footer", "footer maybe", "dashboard off", "phase on", "confirmStop"]) {
			const s = store({ ui: { footer: false } });
			const result = runUiCommand(args, s);
			assert.equal(result.feature, undefined, args);
			assert.equal(result.message, "footer: off\nconfirmStop: on\nUsage: /brigadev:ui footer|confirmStop on|off", args);
			assert.deepEqual(s.writes, [], args);
		}
	});
});
