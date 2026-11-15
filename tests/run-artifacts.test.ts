import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { newRunId, runsDir, writeRunArtifacts, type RunRecord } from "../lib/run-artifacts.ts";
import { emptyTally } from "../lib/cost.ts";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
	runId: "20261114T150203Z-brigadev-explore-abc123",
	agent: "brigadev-explore",
	task: "map the code",
	reason: "Evidence budget",
	taskText: "# Task\nmap the code",
	model: "anthropic/claude-sonnet-5-5",
	route: "definition",
	exitCode: 0,
	stopReason: "stop",
	startedAt: 1,
	endedAt: 2,
	usage: emptyTally(),
	output: "the map",
	messages: [{ role: "assistant", content: [{ type: "text", text: "the map" }] } as any],
	...over,
});

describe("newRunId", () => {
	it("is sortable by time and names the agent, filename-safe", () => {
		const id = newRunId("brigadev-explore", Date.UTC(2026, 10, 14, 15, 2, 3), () => "abc123ffff-rest");
		assert.equal(id, "20261114T150203Z-brigadev-explore-abc123");
	});

	it("replaces characters that are unsafe in a path", () => {
		assert.equal(newRunId("../evil name", 0, () => "zzzzzz"), "19700101T000000Z-evil-name-zzzzzz");
	});
});

describe("writeRunArtifacts: one saved folder per run", () => {
	it("writes task.md, transcript.json, and result.json under <docs>/runs/<runId>/", () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-runs-"));
		try {
			const dir = writeRunArtifacts(docs, record());
			assert.equal(dir, path.join(runsDir(docs), "20261114T150203Z-brigadev-explore-abc123"));
			assert.equal(fs.readFileSync(path.join(dir, "task.md"), "utf8"), "# Task\nmap the code");
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8")), record().messages);
			const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
			assert.equal(result.agent, "brigadev-explore");
			assert.equal(result.output, "the map");
			assert.equal(result.exitCode, 0);
			assert.equal("messages" in result, false);
			assert.equal("taskText" in result, false);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});

	it("keeps the folder and files private to the user", { skip: process.platform === "win32" }, () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-runs-"));
		try {
			const dir = writeRunArtifacts(docs, record());
			assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
			for (const file of ["task.md", "transcript.json", "result.json"]) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});

	it("rejects a run id that would escape the runs folder", () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-runs-"));
		try {
			assert.throws(() => writeRunArtifacts(docs, record({ runId: "../outside" })), /invalid run id/);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});
});
