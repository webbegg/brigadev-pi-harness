// A subagent row shows the agent's own bash command, not the DSP credential-lock prelude line.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { argPreview } from "../lib/agent-thread.ts";
import { lockEnvironment, lockPrelude } from "../lib/dsp-credlock.ts";

describe("agent thread preview under the DSP lock", () => {
	it("hides the prelude line", () => {
		const prelude = lockPrelude(lockEnvironment({ PATH: "/usr/bin", GH_TOKEN: "x" }));
		assert.equal(argPreview("bash", { command: `${prelude}\nnpm test` }), "$ npm test");
		assert.equal(argPreview("bash", { command: "npm test" }), "$ npm test");
	});
});
