import assert from "node:assert/strict";
import { test } from "node:test";
import { createPhaseTracker, phaseForTool } from "../lib/phase.ts";

test("phaseForTool maps tools to loop steps", () => {
	assert.equal(phaseForTool("read", { path: "a.ts" }), "explore");
	assert.equal(phaseForTool("grep", { pattern: "x" }), "explore");
	assert.equal(phaseForTool("ask_user_choice", { question: "q" }), "decide");
	assert.equal(phaseForTool("edit", { path: "a.ts" }), "implement");
	assert.equal(phaseForTool("write", { path: "a.ts" }), "implement");
	assert.equal(phaseForTool("check", {}), "check");
	assert.equal(phaseForTool("todo", { action: "list" }), undefined);
});

test("phaseForTool reads bash commands: tests are check, commit/push/PR are commit, the rest keeps the phase", () => {
	assert.equal(phaseForTool("bash", { command: "npm test" }), "check");
	assert.equal(phaseForTool("bash", { command: "git commit -m x" }), "commit");
	assert.equal(phaseForTool("bash", { command: "git push -u origin feat/x" }), "commit");
	assert.equal(phaseForTool("bash", { command: "gh pr create --fill" }), "commit");
	assert.equal(phaseForTool("bash", { command: "git status" }), undefined);
});

test("phaseForTool routes subagents by agent role", () => {
	assert.equal(phaseForTool("subagent", { agent: "brigadev-explore", task: "t" }), "explore");
	assert.equal(phaseForTool("subagent", { agent: "brigadev-verify", task: "t" }), "check");
	assert.equal(phaseForTool("subagent", { agent: "review-4r", task: "t" }), "check");
	assert.equal(phaseForTool("subagent", { tasks: [{ agent: "brigadev-worker", task: "a" }, { agent: "brigadev-worker", task: "b" }] }), "implement");
	assert.equal(phaseForTool("acp_delegate", { agent: "researcher", task: "t" }), "explore");
	assert.equal(phaseForTool("acp_delegate", { agent: "worker", task: "t" }), "implement");
	assert.equal(phaseForTool("subagent", { agent: "custom-thing", task: "t" }), undefined);
});

test("tracker: a run starts at authorize, moves on tools, records visited once, and idles at the end", () => {
	let now = 1000;
	const tracker = createPhaseTracker(() => now);
	assert.equal(tracker.state().phase, "idle");

	const started = tracker.agentStart();
	assert.deepEqual([started?.phase, started?.running, started?.visited], ["authorize", true, ["authorize"]]);

	now = 2000;
	const explored = tracker.tool("read", { path: "lib/bus.ts" });
	assert.equal(explored?.phase, "explore");
	assert.equal(explored?.since, 2000);
	assert.equal(explored?.detail, "read lib/bus.ts");

	// Same phase again: no change published.
	assert.equal(tracker.tool("grep", { pattern: "x" }), undefined);
	// A tool that says nothing about the phase: no change.
	assert.equal(tracker.tool("todo", {}), undefined);

	tracker.tool("edit", { path: "a.ts" });
	tracker.tool("read", { path: "b.ts" });
	const checked = tracker.tool("check", {});
	assert.deepEqual(checked?.visited, ["authorize", "explore", "implement", "check"]);

	now = 3000;
	const ended = tracker.agentEnd();
	assert.deepEqual([ended?.phase, ended?.running, ended?.since], ["idle", false, 3000]);
	assert.deepEqual(ended?.visited, ["authorize", "explore", "implement", "check"], "the last run's path stays visible while idle");

	const next = tracker.agentStart();
	assert.deepEqual(next?.visited, ["authorize"], "a new run starts a new path");
	assert.equal(next?.source, "inferred");
	assert.equal(next?.scope, "loop");
});

test("phaseForTool: a codemode call reads as explore until its nested calls say otherwise", () => {
	assert.equal(phaseForTool("codemode", "const x = await tools.read({ path: 'a' })"), "explore");
	assert.equal(phaseForTool("codemode", {}), "explore");
});

test("tracker: a codemode call does not stall the phase at authorize, and nested calls move it on", () => {
	const tracker = createPhaseTracker(() => 0);
	tracker.agentStart();
	assert.equal(tracker.tool("codemode", "await tools.edit({})")?.phase, "explore");
	assert.equal(tracker.tool("edit", { path: "a.ts" })?.phase, "implement");
});

test("tracker: the phase detail is redacted", () => {
	const tracker = createPhaseTracker(() => 0);
	tracker.agentStart();
	const next = tracker.tool("bash", { command: "git push https://me:hunter2@github.com/o/r.git" });
	assert.equal(next?.phase, "commit");
	assert.equal(next?.detail, "bash git push https://***@github.com/o/r.git");
});

test("tracker ignores tools outside a run", () => {
	const tracker = createPhaseTracker(() => 0);
	assert.equal(tracker.tool("edit", { path: "a.ts" }), undefined);
	assert.equal(tracker.state().phase, "idle");
});
