import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { RECHECK_KEY, parseProfilesFile, resolveAgentRoute, resolveModelRef, routeFor, unmatchedKeys, validateProfileName, withRoute, emptyProfilesFile } from "../lib/model-routing.ts";

const catalog = [
	{ provider: "claude-bridge", id: "claude-haiku-5-5" },
	{ provider: "anthropic", id: "claude-haiku-5-5" },
	{ provider: "claude-bridge", id: "claude-opus-5-5" },
	{ provider: "openai", id: "gpt-6" },
];

describe("parseProfilesFile", () => {
	it("keeps valid routes, accepts legacy string entries, and reports problems", () => {
		const { file, problems } = parseProfilesFile({
			active: "balanced",
			profiles: {
				balanced: { orchestrator: { model: "claude-bridge/claude-opus-5-5", thinking: "high" }, "brigadev-explore": "claude-bridge/claude-haiku-5-5", "review-*": { thinking: "medium" } },
				"bad name!": {},
				broken: { "brigadev-worker": { thinking: "turbo" } },
			},
		});
		assert.deepEqual(file.profiles.balanced["brigadev-explore"], { model: "claude-bridge/claude-haiku-5-5" });
		assert.equal(file.active, "balanced");
		assert.deepEqual(file.profiles.broken, {});
		assert.equal(problems.length, 2);
	});

	it("drops an active name that does not exist", () => {
		const { file, problems } = parseProfilesFile({ active: "ghost", profiles: {} });
		assert.equal(file.active, undefined);
		assert.match(problems[0], /ghost/);
	});

	it("ignores a stored `fallbacks` key silently, even a malformed one", () => {
		const { file, problems } = parseProfilesFile({
			profiles: {
				p: {
					"brigadev-worker": { model: "a/b", fallbacks: ["c/d", { model: "e/f", thinking: "low" }] },
					orchestrator: { thinking: "high", fallbacks: "not-an-array" },
					"*": { fallbacks: ["c/d"] },
				},
			},
		});
		assert.deepEqual(problems, []);
		assert.deepEqual(file.profiles.p, { "brigadev-worker": { model: "a/b" }, orchestrator: { thinking: "high" } });
	});

	it("treats a missing file as empty without problems", () => {
		assert.deepEqual(parseProfilesFile(undefined).problems, []);
	});
});

describe("routeFor", () => {
	const profile = { "brigadev-worker": { model: "a/w" }, "review-*": { model: "a/r" }, "review-risk*": { model: "a/rr" }, "*": { model: "a/default" }, orchestrator: { model: "a/o" } };
	it("prefers exact, then longest glob, then *", () => {
		assert.equal(routeFor(profile, "brigadev-worker")?.entry.model, "a/w");
		assert.equal(routeFor(profile, "review-readability")?.entry.model, "a/r");
		assert.equal(routeFor(profile, "review-risk")?.entry.model, "a/rr");
		assert.equal(routeFor(profile, "jd-fix")?.entry.model, "a/default");
	});
	it("never routes the orchestrator through * or globs", () => {
		assert.equal(routeFor({ "*": { model: "a/x" } }, "orchestrator"), undefined);
		assert.equal(routeFor(profile, "orchestrator")?.entry.model, "a/o");
	});
});

describe("resolveAgentRoute", () => {
	const parent = { model: "claude-bridge/claude-opus-5-5", thinking: "high" };
	it("profile beats definition beats parent, per field", () => {
		const r = resolveAgentRoute({ profile: { "brigadev-explore": { model: "claude-bridge/claude-haiku-5-5" } }, agent: { name: "brigadev-explore", thinking: "low" }, parent });
		assert.deepEqual([r.model, r.modelSource, r.thinking, r.thinkingSource, r.profileKey], ["claude-bridge/claude-haiku-5-5", "profile", "low", "definition", "brigadev-explore"]);
	});
	it("inherits parent thinking only together with the parent model", () => {
		assert.equal(resolveAgentRoute({ agent: { name: "x" }, parent }).thinking, "high");
		assert.equal(resolveAgentRoute({ agent: { name: "x", model: "a/b" }, parent }).thinking, undefined);
	});
	it("reports no profile key when the profile supplied nothing", () => {
		assert.equal(resolveAgentRoute({ profile: {}, agent: { name: "x" }, parent }).profileKey, undefined);
	});
});

describe("resolveAgentRoute routeKey (S8: recheck route)", () => {
	const parent = { model: "claude-bridge/claude-opus-5-5", thinking: "high" };
	const verify = { name: "brigadev-verify" };
	const profile = { "brigadev-verify": { model: "a/opus", thinking: "high" as const }, "brigadev-verify-recheck": { model: "a/sonnet", thinking: "medium" as const } };

	it("uses the recheck key when the profile has it", () => {
		const r = resolveAgentRoute({ profile, agent: verify, parent, routeKey: RECHECK_KEY });
		assert.deepEqual([r.model, r.thinking, r.profileKey, r.modelSource], ["a/sonnet", "medium", "brigadev-verify-recheck", "profile"]);
	});

	it("falls back to the verify route when the profile has no recheck key", () => {
		const { "brigadev-verify-recheck": _, ...withoutKey } = profile;
		const r = resolveAgentRoute({ profile: withoutKey, agent: verify, parent, routeKey: RECHECK_KEY });
		assert.deepEqual([r.model, r.thinking, r.profileKey], ["a/opus", "high", "brigadev-verify"]);
		const globbed = resolveAgentRoute({ profile: { "brigadev-*": { model: "a/glob" } }, agent: verify, parent, routeKey: RECHECK_KEY });
		assert.equal(globbed.model, "a/glob");
	});

	it("a launch without a routeKey keeps routing by the agent name", () => {
		assert.equal(resolveAgentRoute({ profile, agent: verify, parent }).model, "a/opus");
	});

	it("a recheck key that supplies only thinking keeps the verify definition's model", () => {
		const r = resolveAgentRoute({ profile: { "brigadev-verify-recheck": { thinking: "low" } }, agent: { name: "brigadev-verify", model: "a/def" }, parent, routeKey: RECHECK_KEY });
		assert.deepEqual([r.model, r.modelSource, r.thinking, r.profileKey], ["a/def", "definition", "low", "brigadev-verify-recheck"]);
	});

	it("the shipped example profiles route the recheck as specified", () => {
		const { file } = parseProfilesFile(JSON.parse(readFileSync(join(import.meta.dirname, "..", "assets", "profiles.example.json"), "utf8")));
		const entry = (name: string) => [file.profiles[name][RECHECK_KEY].model, file.profiles[name][RECHECK_KEY].thinking];
		assert.deepEqual(entry("balanced"), ["claude-sonnet-5-5", "high"]);
		assert.deepEqual(entry("economy"), ["claude-sonnet-5-5", "medium"]);
		assert.deepEqual(entry("deep"), ["claude-opus-5-5", "high"]);
	});

	it("the recheck key is not reported as an unmatched key", () => {
		assert.deepEqual(unmatchedKeys({ "brigadev-verify-recheck": {}, "brigadev-wroker": {} }, ["brigadev-verify", "brigadev-worker"]), ["brigadev-wroker"]);
	});
});

describe("resolveModelRef", () => {
	it("resolves qualified refs exactly", () => {
		assert.deepEqual(resolveModelRef("openai/gpt-6", catalog), { model: { provider: "openai", id: "gpt-6" } });
		assert.ok("error" in resolveModelRef("openai/nope", catalog));
	});
	it("resolves bare ids by preferred provider, else uniqueness", () => {
		assert.deepEqual(resolveModelRef("claude-haiku-5-5", catalog, "claude-bridge"), { model: { provider: "claude-bridge", id: "claude-haiku-5-5" } });
		assert.match((resolveModelRef("claude-haiku-5-5", catalog, "openai") as { error: string }).error, /several providers/);
		assert.deepEqual(resolveModelRef("gpt-6", catalog), { model: { provider: "openai", id: "gpt-6" } });
	});
});

describe("withRoute", () => {
	it("sets, merges, and clears routes without mutating the input", () => {
		const start = { ...emptyProfilesFile(), profiles: { p: {} } };
		const a = withRoute(start, "p", "brigadev-worker", { model: "x/y" });
		const b = withRoute(a, "p", "brigadev-worker", { thinking: "high" });
		assert.deepEqual(b.profiles.p["brigadev-worker"], { model: "x/y", thinking: "high" });
		const c = withRoute(b, "p", "brigadev-worker", { model: undefined, thinking: undefined });
		assert.equal(c.profiles.p["brigadev-worker"], undefined);
		assert.deepEqual(start.profiles.p, {});
		assert.throws(() => withRoute(start, "missing", "x", { model: "a/b" }));
	});
});

describe("names and keys", () => {
	it("validates profile names", () => {
		assert.equal(validateProfileName("deep-work"), undefined);
		assert.ok(validateProfileName("__proto__"));
		assert.ok(validateProfileName("-x"));
	});
	it("finds keys that match no agent", () => {
		assert.deepEqual(unmatchedKeys({ "brigadev-wroker": {}, "review-*": {}, "*": {}, orchestrator: {} }, ["brigadev-worker", "review-risk"]), ["brigadev-wroker"]);
	});
});
