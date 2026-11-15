// Records captured from a live Pi 1.5.2 RPC child (claude-bridge/claude-haiku-5-5), pinned so a protocol drift shows up here.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerUiRequest, createCommandTracker, decodeRecord } from "../lib/child-rpc.ts";

describe("live RPC records (Pi 1.5.2)", () => {
	it("a steer response echoes the command id and its disposition, and settles the tracked steer as accepted", async () => {
		const tracker = createCommandTracker("steer");
		const { id, outcome } = tracker.expect();
		const line = JSON.stringify({ id, type: "response", command: "steer", success: true, data: { disposition: "queued" } });
		const record = decodeRecord(line);
		assert.deepEqual(record, { kind: "response", command: "steer", success: true, id, disposition: "queued" });
		assert.equal(tracker.respond(record as { id?: string; success: boolean; disposition?: string }), true);
		assert.deepEqual(await outcome, { status: "accepted", disposition: "queued" });
		assert.equal(tracker.pending(), 0);
	});

	it("the status and widget requests a live child sends are not answered; a dialog is cancelled", () => {
		for (const method of ["setStatus", "setWidget"]) {
			const record = decodeRecord(JSON.stringify({ type: "extension_ui_request", id: "2c639c11-d45a-4754-a039-e21b88977442", method, statusKey: "brigadev-harness" }));
			assert.equal(record?.kind, "ui_request");
			assert.equal(answerUiRequest((record as { request: { id: string; method: string } }).request), undefined);
		}
		const confirm = decodeRecord(JSON.stringify({ type: "extension_ui_request", id: "u-1", method: "confirm", title: "Allow?" }));
		assert.deepEqual(answerUiRequest((confirm as { request: { id: string; method: string } }).request), { type: "extension_ui_response", id: "u-1", cancelled: true });
	});
});
