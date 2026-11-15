import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isUnfinished, runStatus, toRunState } from "../lib/run-status.ts";
import * as childRun from "../lib/child-run.ts";
import * as runStatusModule from "../lib/run-status.ts";

describe("runStatus: the one run-state rule", () => {
	const cases: Array<[string, Parameters<typeof runStatus>[0], string, string]> = [
		// [what, run, status, three-state view]
		["exit -1, no end, not queued", { exitCode: -1 }, "running", "running"],
		["exit -1, no end, queued", { exitCode: -1, queued: true }, "queued", "running"],
		["exit -1 with an end time", { exitCode: -1, endedAt: 5 }, "failed", "failed"],
		["exit -1 with an end time, aborted while queued", { exitCode: -1, queued: true, cancelled: true, endedAt: 5 }, "cancelled", "failed"],
		["exit 0", { exitCode: 0, stopReason: "stop" }, "done", "done"],
		["exit 0 without a stop reason", { exitCode: 0 }, "done", "done"],
		["exit 1", { exitCode: 1 }, "failed", "failed"],
		["exit 0, stop reason error", { exitCode: 0, stopReason: "error" }, "failed", "failed"],
		["exit 0, stop reason aborted", { exitCode: 0, stopReason: "aborted" }, "failed", "failed"],
	];
	for (const [what, run, status, view] of cases) {
		it(`${what}: ${status}`, () => {
			assert.equal(runStatus(run), status);
			assert.equal(toRunState(runStatus(run)), view);
			assert.equal(isUnfinished(runStatus(run)), status === "running" || status === "queued");
		});
	}
});

describe("run-status: shared with lib/child-run.ts", () => {
	it("child-run re-exports the same functions, so existing imports keep working", () => {
		for (const name of ["runStatus", "isUnfinished", "toRunState", "failed", "finalText", "output"] as const) {
			assert.equal(childRun[name], runStatusModule[name], name);
		}
	});
});
