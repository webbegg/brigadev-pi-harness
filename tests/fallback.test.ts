import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyFailure, Cooldowns, cooldownMs, launchOrder, priceNote, providerOf } from "../lib/fallback.ts";
import { parseProfilesFile, withFallbacks, emptyProfilesFile } from "../lib/model-routing.ts";
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

describe("failure classification", () => {
	it("falls back for quota, auth, rate limit, provider trouble, timeouts, and network", () => {
		assert.equal(classifyFailure("error", "Claude quota exceeded — rate limit (five_hour) — resets 18:00: request failed"), "quota");
		assert.equal(classifyFailure("error", "401 Unauthorized: invalid api key"), "auth");
		assert.equal(classifyFailure("error", "429 Too Many Requests"), "rate_limit");
		assert.equal(classifyFailure("error", "529 overloaded_error"), "provider_unavailable");
		assert.equal(classifyFailure("error", "Request timed out"), "timeout");
		assert.equal(classifyFailure("error", "fetch failed: ECONNRESET"), "network");
	});

	it("never falls back when another model would fail the same way", () => {
		assert.equal(classifyFailure("error", "prompt is too long: 250000 tokens > 200000 maximum context"), undefined);
		assert.equal(classifyFailure("error", "invalid_request_error: bad schema"), undefined);
		assert.equal(classifyFailure("aborted", "429"), undefined);
		assert.equal(classifyFailure("end", undefined), undefined);
		assert.equal(classifyFailure("error", "something odd happened"), undefined);
	});

	it("cools limits and auth longer than transient errors", () => {
		assert.equal(cooldownMs("quota"), 30 * 60_000);
		assert.equal(cooldownMs("network"), 2 * 60_000);
		const c = new Cooldowns();
		c.cool("a/x", NOW + 1000);
		c.cool("a/x", NOW + 500);
		assert.equal(c.isCooling("a/x", NOW), true);
		assert.equal(c.isCooling("a/x", NOW + 1001), false);
	});
});

describe("launch order", () => {
	const primary = { model: "claude-bridge/claude-opus-5-5", thinking: "high" };
	const fallbacks = [{ model: "claude-bridge/claude-sonnet-5-5" }, { model: "llama.cpp/qwen" }, { model: "claude-bridge/claude-opus-5-5" }];

	it("keeps the primary first and drops duplicates", () => {
		assert.deepEqual(launchOrder(primary, fallbacks, () => false).map((s) => s.model), ["claude-bridge/claude-opus-5-5", "claude-bridge/claude-sonnet-5-5", "llama.cpp/qwen"]);
	});

	it("starts on the first usable model when the primary is cooling", () => {
		assert.deepEqual(launchOrder(primary, fallbacks, (m) => m.endsWith("opus-5-5")).map((s) => s.model), ["claude-bridge/claude-sonnet-5-5", "llama.cpp/qwen", "claude-bridge/claude-opus-5-5"]);
	});

	it("skips a whole provider that is out of quota", () => {
		assert.deepEqual(launchOrder(primary, fallbacks, (m) => providerOf(m) === "claude-bridge")[0].model, "llama.cpp/qwen");
	});

	it("keeps the original order when everything is cooling", () => {
		assert.equal(launchOrder(primary, fallbacks, () => true)[0].model, primary.model);
	});

	it("notes when the next model costs more", () => {
		assert.equal(priceNote({ input: 2, output: 10 }, { input: 4, output: 20 }), " (2.0x the price)");
		assert.equal(priceNote({ input: 4, output: 20 }, { input: 2, output: 10 }), "");
		assert.equal(priceNote(undefined, { input: 1, output: 1 }), "");
	});
});

describe("profile fallbacks", () => {
	it("parses chains, accepting strings, dropping duplicates, and capping at 8", () => {
		const many = Array.from({ length: 10 }, (_, i) => `p/m${i}`);
		const { file, problems } = parseProfilesFile({ profiles: { p: { "brigadev-worker": { model: "a/b", fallbacks: ["c/d", { model: "e/f", thinking: "low" }, "c/d"] }, "*": { fallbacks: many } } } });
		assert.deepEqual(file.profiles.p["brigadev-worker"].fallbacks, [{ model: "c/d" }, { model: "e/f", thinking: "low" }]);
		assert.equal(file.profiles.p["*"].fallbacks?.length, 8);
		assert.match(problems[0], /at most 8/);
	});

	it("sets and clears a chain without touching the route", () => {
		const start = { ...emptyProfilesFile(), profiles: { p: { orchestrator: { model: "a/b" } } } };
		const set = withFallbacks(start, "p", "orchestrator", [{ model: "c/d" }]);
		assert.deepEqual(set.profiles.p.orchestrator, { model: "a/b", fallbacks: [{ model: "c/d" }] });
		assert.deepEqual(withFallbacks(set, "p", "orchestrator", []).profiles.p.orchestrator, { model: "a/b" });
		assert.equal(withFallbacks(start, "p", "jd-*", []).profiles.p["jd-*"], undefined);
	});
});
