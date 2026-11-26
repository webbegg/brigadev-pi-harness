// The contract between the harness and the brigadev-t3 add-on (t3/): the add-on reads only the `brigadev:*` bus, with its
// own copy of the channel names and the payload fields it uses. This fails when the harness renames one.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUS, CHANNELS as SPECS, type CheckState, type PhaseState, type TodoState } from "../lib/bus.ts";
import { CHANNELS } from "../t3/src/channels.ts";
import { statusTexts } from "../t3/src/statuses.ts";

describe("brigadev-t3 bus contract", () => {
	it("every channel the add-on reads is a harness outbound channel of the same name", () => {
		for (const [name, channel] of Object.entries(CHANNELS)) {
			assert.equal(BUS[name as keyof typeof BUS], channel, name);
			assert.ok(channel in SPECS, `${channel} is outbound`);
		}
	});

	it("the harness's payload shapes give the chips the add-on promises", () => {
		const phase: PhaseState = { scope: "loop", phase: "check", since: 0, visited: ["check"], running: true, source: "inferred" };
		const todo: TodoState = { scope: "todo", todos: [{ id: "T1", text: "a", status: "done" }, { id: "T2", text: "b", status: "pending" }] };
		const check: CheckState = { id: "c", command: "npm test", outcome: "pass", counts: { pass: 3, fail: 0 }, at: 0 };
		assert.deepEqual(Object.values(statusTexts({ phase, todo, check })), ["brigadev ▸ check", "todo 1/2", "check ✓ 3 passed"]);
	});
});
