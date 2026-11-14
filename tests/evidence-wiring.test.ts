import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { commitGateWithForce, forceRecord, gateDialog, runRecordFromResult, type RunRecord } from "../lib/evidence.ts";

const base = { ts: "2026-11-14T10:00:00.000Z", branch: "feat/x", tree: "a".repeat(40), cwd: "/repo", agent: "parent" };
const text = (t: string) => [{ type: "text", text: t }];

describe("runRecordFromResult", () => {
	it("builds a record from structuredContent exit code and output", () => {
		const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: text("ignored"), structuredContent: { exit_code: 0, output: "ok\n5 passing" } }, base);
		assert.ok(record);
		assert.equal(record.command, "npm test");
		assert.equal(record.exitCode, 0);
		assert.equal(record.outcome, "pass");
		assert.equal(record.tail, "ok\n5 passing");
		assert.equal(record.tree, base.tree);
		assert.equal(record.agent, "parent");
	});

	it("falls back to the text content when structuredContent has no output", () => {
		const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: [...text("line a"), { type: "image" }, ...text("line b")], structuredContent: { exit_code: 1 } }, base);
		assert.equal(record?.outcome, "fail");
		assert.equal(record?.tail, "line a\nline b");
	});

	it("leaves the exit code undefined unless it is a number", () => {
		for (const structuredContent of [undefined, {}, { exit_code: "0" }, { exit_code: null }, "x"]) {
			const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: text("out"), structuredContent }, base);
			assert.equal(record?.exitCode, undefined);
			assert.equal(record?.outcome, "unknown");
		}
	});

	it("records nothing for other tools, non-check commands, missing commands, or an undefined tree", () => {
		assert.equal(runRecordFromResult({ toolName: "read", input: { command: "npm test" }, content: [] }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: { command: "ls -la" }, content: text("x") }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: {}, content: text("x") }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: { command: 5 }, content: text("x") }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: text("x") }, { ...base, tree: undefined }), undefined);
	});

	it("tolerates malformed events without throwing", () => {
		assert.equal(runRecordFromResult(undefined, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash" }, base), undefined);
		const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: "oops" }, base);
		assert.equal(record?.tail, "");
	});

	it("keeps a null branch and the agent name", () => {
		const record = runRecordFromResult({ toolName: "bash", input: { command: "tsc --noEmit" }, content: text("") }, { ...base, branch: null, agent: "brigadev-verify" });
		assert.equal(record?.branch, null);
		assert.equal(record?.agent, "brigadev-verify");
		assert.equal(record?.kind, "check");
	});
});

describe("forceRecord", () => {
	it("records how the user forced the commit", () => {
		const record = forceRecord({ ts: base.ts, branch: "feat/x", tree: base.tree, via: "dialog", command: "git commit -m x" });
		assert.deepEqual(record, { v: 1, type: "force", ts: base.ts, branch: "feat/x", tree: base.tree, via: "dialog", command: "git commit -m x" });
	});

	it("truncates a long command", () => {
		assert.equal(forceRecord({ ts: base.ts, branch: null, via: "command", command: "x".repeat(900) }).command.length, 500);
	});
});

describe("gateDialog", () => {
	it("shows the reason, the command, and asks the user to force it", () => {
		const dialog = gateDialog("Blocked by brigadev evidence gate: nothing ran.", "git commit -m 'x'");
		assert.match(dialog.title, /evidence gate/i);
		assert.match(dialog.body, /nothing ran/);
		assert.match(dialog.body, /git commit -m 'x'/);
		assert.match(dialog.body, /Commit anyway\?/);
	});

	it("does not repeat the instructions meant for the model", () => {
		const dialog = gateDialog("Blocked by brigadev evidence gate: nothing ran. Run the tests in their own bash command, then commit again.", "git commit");
		assert.doesNotMatch(dialog.body, /tell them to run/);
	});
});

describe("commitGateWithForce", () => {
	const tree = "b".repeat(40);
	const input = { dirtyPaths: ["src/a.ts"], tree, elsewhere: false, records: [] as RunRecord[], forcedTree: undefined as string | undefined };

	it("blocks without evidence and without a force", () => {
		const result = commitGateWithForce(input);
		assert.equal(result.decision.action, "block");
		assert.equal(result.consumedForce, false);
	});

	it("lets a force for this tree through and consumes it", () => {
		const result = commitGateWithForce({ ...input, forcedTree: tree });
		assert.equal(result.decision.action, "allow");
		assert.equal(result.consumedForce, true);
	});

	it("keeps a force bound to another tree unused", () => {
		const result = commitGateWithForce({ ...input, forcedTree: "c".repeat(40) });
		assert.equal(result.decision.action, "block");
		assert.equal(result.consumedForce, false);
	});

	it("does not consume the force when the commit passes on its own", () => {
		const run: RunRecord = { v: 1, type: "run", ts: base.ts, branch: null, tree, cwd: "/repo", agent: "parent", command: "npm test", kind: "test", exitCode: 0, outcome: "pass", tail: "" };
		const result = commitGateWithForce({ ...input, records: [run], forcedTree: tree });
		assert.equal(result.decision.action, "allow");
		assert.equal(result.consumedForce, false);
		const docs = commitGateWithForce({ ...input, dirtyPaths: ["README.md"], forcedTree: tree });
		assert.equal(docs.consumedForce, false);
	});

	it("never lets a force override an elsewhere commit", () => {
		const result = commitGateWithForce({ ...input, elsewhere: true, forcedTree: tree });
		assert.equal(result.decision.action, "block");
		assert.equal(result.consumedForce, false);
	});
});
