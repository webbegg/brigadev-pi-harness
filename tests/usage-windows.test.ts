import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatUsage, parseUsageHeaders, spentUntil, usageTone } from "../lib/usage-windows.ts";

// Captured from a real claude-bridge 0.10.0 turn.
const REAL_HEADERS = {
	"anthropic-ratelimit-unified-status": "allowed",
	"anthropic-ratelimit-unified-reset": "1794060000",
	"anthropic-ratelimit-unified-representative-claim": "seven_day",
	"anthropic-ratelimit-unified-overage-status": "rejected",
	"anthropic-ratelimit-unified-7d-utilization": "0.55",
	"anthropic-ratelimit-unified-7d-reset": "1794060000",
	"content-type": "text/event-stream",
};
const NOW = 1_794_000_000_000;

describe("usage windows", () => {
	it("parses the unified headers", () => {
		const s = parseUsageHeaders(REAL_HEADERS, NOW)!;
		assert.deepEqual(s.windows, [{ name: "7d", utilization: 0.55, resetsAt: 1794060000 }]);
		assert.equal(s.claim, "seven_day");
		assert.equal(formatUsage(s), "week 55%");
		assert.equal(usageTone(s), "muted");
	});

	it("ignores responses without usage headers", () => {
		assert.equal(parseUsageHeaders({ "content-type": "text/plain" }, NOW), undefined);
	});

	it("warns near the limit and reports a reached limit", () => {
		const near = parseUsageHeaders({ ...REAL_HEADERS, "anthropic-ratelimit-unified-5h-utilization": "0.91" }, NOW)!;
		assert.equal(formatUsage(near), "5h 91% · week 55%");
		assert.equal(usageTone(near), "warning");
		const spent = parseUsageHeaders({ ...REAL_HEADERS, "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-representative-claim": "five_hour" }, NOW)!;
		assert.equal(formatUsage(spent), "limit reached (five_hour)");
		assert.equal(usageTone(spent), "error");
	});

	it("treats the provider as spent only while rejected without overage and before reset", () => {
		const base = parseUsageHeaders(REAL_HEADERS, NOW)!;
		assert.equal(spentUntil(base, NOW), undefined);
		const rejected = { ...base, status: "rejected" };
		assert.equal(spentUntil(rejected, NOW), 1794060000 * 1000);
		assert.equal(spentUntil({ ...rejected, overageStatus: "allowed" }, NOW), undefined);
		assert.equal(spentUntil(rejected, 1794060000 * 1000 + 1), undefined, "a past reset is stale");
	});
});
