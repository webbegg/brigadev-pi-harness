import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseProfilesFile, resolveAgentRoute, resolveModelRef, routeFor, unmatchedKeys, validateProfileName, withRoute, emptyProfilesFile } from "../lib/model-routing.ts";

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
