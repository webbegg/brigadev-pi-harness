import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { inferPhase, phaseLabel } from "../lib/odd-phase.ts";

describe("odd phase", () => {
	it("infers phases from tools", () => {
		assert.equal(inferPhase("read", { path: "a.ts" })?.phase, "exploring");
		assert.equal(inferPhase("edit", { path: "lib/a.ts" })?.phase, "implementing");
		assert.equal(inferPhase("write", { path: "/Users/me/.brigadev/my-repo/tasks/x.md" })?.phase, "planning");
		assert.equal(inferPhase("edit", { path: "/Users/me/.brigadev/my-repo/reviews/feat-x.md" })?.phase, "implementing");
		assert.equal(inferPhase("write", { path: "src/tasks/x.ts" })?.phase, "implementing");
		assert.equal(inferPhase("bash", { command: "npm test 2>&1 | tail -5" })?.phase, "checking");
		assert.equal(inferPhase("bash", { command: "git add -A && git commit -m x" })?.phase, "delivering");
		assert.equal(inferPhase("bash", { command: "sed -n 1,40p a.ts" })?.phase, "exploring");
		assert.equal(inferPhase("bash", { command: "./scripts/do-thing.sh" }), undefined);
		assert.equal(inferPhase("unknown_tool", {}), undefined);
	});

	it("names delegated agents", () => {
		assert.equal(phaseLabel(inferPhase("subagent", { agent: "brigadev-explore" })!), "delegating · brigadev-explore");
		assert.equal(phaseLabel(inferPhase("subagent", { tasks: [{ agent: "a" }, { agent: "b" }] })!), "delegating · 2 agents");
	});
});
