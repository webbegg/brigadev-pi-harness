import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { bridgeHooksStatus, patchBridgeHooks } from "../lib/bridge-hooks.ts";

// The provider-path settings block of pi-claude-bridge 0.10.0, verbatim.
const UPSTREAM = `			settings: {
				...claudeCodeSettings(providerSettings),
				claudeMdExcludes: CLAUDE_MD_EXCLUDES,
				includeGitInstructions: false,
			},
			systemPrompt: {`;

describe("bridge hooks patch", () => {
	it("reports an unpatched bridge as leaking hooks", () => {
		assert.equal(bridgeHooksStatus(UPSTREAM), "hooks-enabled");
	});

	it("adds disableAllHooks to the provider settings block", () => {
		const result = patchBridgeHooks(UPSTREAM);
		assert.equal(result.status, "patched");
		assert.match(result.source, /includeGitInstructions: false,\n\t\t\t\tdisableAllHooks: true, \/\/ brigadev: Claude Code hooks off for Pi turns\n\t\t\t},/);
		assert.equal(bridgeHooksStatus(result.source), "hooks-disabled");
	});

	it("is idempotent", () => {
		const once = patchBridgeHooks(UPSTREAM).source;
		const twice = patchBridgeHooks(once);
		assert.equal(twice.status, "already-patched");
		assert.equal(twice.source, once);
	});

	it("refuses a source it does not recognize", () => {
		const changed = UPSTREAM.replace("includeGitInstructions: false,", "includeGitInstructions: true,");
		assert.equal(bridgeHooksStatus(changed), "unrecognized");
		const result = patchBridgeHooks(changed);
		assert.equal(result.status, "unrecognized");
		assert.equal(result.source, changed);
	});

	it("respects an upstream version that already disables hooks", () => {
		const upstreamFix = UPSTREAM.replace("includeGitInstructions: false,", "includeGitInstructions: false,\n\t\t\t\tdisableAllHooks: providerSettings.disableHooks !== false,");
		assert.equal(bridgeHooksStatus(upstreamFix), "hooks-disabled");
		assert.equal(patchBridgeHooks(upstreamFix).status, "already-patched");
	});
});
