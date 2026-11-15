import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { alreadyDeliveredText } from "../lib/result-delivery.ts";
import type { LaunchResult } from "../lib/subagent-launch.ts";
import type { LaunchSummary, WaitOutcome } from "../lib/subagent-registry.ts";
import { cancelLaunch, clampWaitSeconds, collectedResult, collectHint, resolveLaunchId, startedText, waitForLaunch, WAIT_DEFAULT_SECONDS, WAIT_MAX_SECONDS } from "../lib/subagent-tools.ts";

const summary = (id: string, over: Partial<LaunchSummary> = {}): LaunchSummary => ({ id, status: "settled", total: 3, done: 1, startedAt: 0, settledAt: 1, consumed: false, error: undefined, ...over });

const launchResult = (text = "all good"): LaunchResult => ({
	content: [{ type: "text", text }],
	details: { mode: "parallel", results: [{ agent: "scout", artifactsDir: "/d/runs/scout-1" }, { agent: "reviewer" }] as any },
});

const settled = (over: Partial<LaunchSummary> = {}, result: LaunchResult | undefined = launchResult()): WaitOutcome<LaunchResult> => ({ status: "settled", launch: summary("L1", over), result });
const running: WaitOutcome<LaunchResult> = { status: "running", launch: summary("L1", { status: "running", done: 2, total: 5 }) };

/** A registry that answers a fixed outcome and records how it was called. */
function fakeRegistry(outcome: WaitOutcome<LaunchResult>) {
	const calls: Array<{ op: "wait" | "cancel"; id: string; timeoutMs?: number; signal?: AbortSignal }> = [];
	return {
		calls,
		wait: async (id: string, timeoutMs: number, signal?: AbortSignal) => (calls.push({ op: "wait", id, timeoutMs, signal }), outcome),
		cancel: async (id: string) => (calls.push({ op: "cancel", id }), outcome),
	};
}

const textOf = (r: LaunchResult) => r.content.map((c) => c.text).join("\n");

describe("resolveLaunchId: launchId, with runId kept as a deprecated alias", () => {
	it("takes launchId", () => assert.deepEqual(resolveLaunchId({ launchId: "L1" }), { id: "L1" }));
	it("takes the old runId alias, so existing habits and transcripts keep working", () => assert.deepEqual(resolveLaunchId({ runId: "L1" }), { id: "L1" }));

	it("rejects neither, naming the parameter to use", () => {
		const outcome = resolveLaunchId({});
		assert.ok("error" in outcome);
		assert.match(outcome.error, /launchId/);
		assert.ok("error" in resolveLaunchId({ launchId: "", runId: "" }), "an empty string is no id");
	});

	it("rejects both, since exactly one is required", () => {
		const outcome = resolveLaunchId({ launchId: "L1", runId: "L1" });
		assert.ok("error" in outcome);
		assert.match(outcome.error, /launchId/);
		assert.match(outcome.error, /runId/);
	});
});

describe("clampWaitSeconds: floor 1, default 60, max 300", () => {
	it("defaults to 60 when absent", () => {
		assert.equal(WAIT_DEFAULT_SECONDS, 60);
		assert.equal(clampWaitSeconds(undefined), 60);
	});
	it("keeps a value inside the range", () => assert.equal(clampWaitSeconds(30), 30));
	it("raises to 1 below the floor", () => {
		assert.equal(clampWaitSeconds(0), 1);
		assert.equal(clampWaitSeconds(-5), 1);
	});
	it("cuts to 300 above the max", () => {
		assert.equal(WAIT_MAX_SECONDS, 300);
		assert.equal(clampWaitSeconds(301), 300);
		assert.equal(clampWaitSeconds(100_000), 300);
	});
	it("a number that is not finite is the default", () => assert.equal(clampWaitSeconds(Number.NaN), 60));
});

describe("collectedResult: what wait and cancel answer for each registry outcome", () => {
	it("an unknown id is an error that says so", () => {
		const r = collectedResult("nope", { status: "unknown" });
		assert.equal(r.isError, true);
		assert.equal(textOf(r), 'Unknown launch id "nope" (not started in this session, or pruned).');
	});

	it("a running launch reports its progress and how long was waited, and is not an error", () => {
		const r = collectedResult("L1", running, 60);
		assert.equal(r.isError, undefined);
		assert.equal(textOf(r), "Launch L1 still running: 2/5 done after 60s. Call subagent_wait again, or subagent_cancel.");
		assert.equal(r.details.pending, true, "the viewer must not record a placeholder as a finished run");
		assert.equal(r.details.launchId, "L1");
	});

	it("a running launch without a wait time leaves out the seconds", () => {
		assert.equal(textOf(collectedResult("L1", running)), "Launch L1 still running: 2/5 done. Call subagent_wait again, or subagent_cancel.");
	});

	it("a launch whose body threw is an error carrying the message", () => {
		const r = collectedResult("L1", { status: "settled", launch: summary("L1", { error: "boom" }), error: "boom" });
		assert.equal(r.isError, true);
		assert.equal(textOf(r), "Launch L1 failed: boom");
	});

	it("a settled launch with neither result nor error is an error", () => {
		const r = collectedResult("L1", { status: "settled", launch: summary("L1") });
		assert.equal(r.isError, true);
		assert.equal(textOf(r), "Launch L1 failed: no result");
	});

	it("a settled launch returns its result, tagged with the launch id and not pending", () => {
		const r = collectedResult("L1", settled());
		assert.equal(textOf(r), "all good");
		assert.equal(r.details.launchId, "L1");
		assert.equal(r.details.pending, undefined);
		assert.equal(r.details.mode, "parallel");
	});

	it("keeps the result's own error flag", () => {
		const r = collectedResult("L1", settled({}, { ...launchResult("child failed"), isError: true }));
		assert.equal(r.isError, true);
	});
});

describe("waitForLaunch", () => {
	it("waits with the clamped timeout in milliseconds and passes the signal on", async () => {
		const signal = new AbortController().signal;
		for (const [asked, seconds] of [[undefined, 60], [0, 1], [30, 30], [9999, 300]] as const) {
			const registry = fakeRegistry(running);
			await waitForLaunch(registry, { launchId: "L1", timeoutSeconds: asked }, signal);
			assert.deepEqual(registry.calls, [{ op: "wait", id: "L1", timeoutMs: seconds * 1000, signal }]);
		}
	});

	it("reports the clamped seconds when still running", async () => {
		const r = await waitForLaunch(fakeRegistry(running), { launchId: "L1", timeoutSeconds: 9999 });
		assert.match(textOf(r), /still running: 2\/5 done after 300s/);
	});

	it("accepts the runId alias", async () => {
		const registry = fakeRegistry(settled());
		const r = await waitForLaunch(registry, { runId: "L1" });
		assert.equal(registry.calls[0].id, "L1");
		assert.equal(textOf(r), "all good");
	});

	it("a missing or doubled id is an error and never reaches the registry", async () => {
		const registry = fakeRegistry(settled());
		const none = await waitForLaunch(registry, {});
		const both = await waitForLaunch(registry, { launchId: "L1", runId: "L1" });
		assert.equal(none.isError, true);
		assert.equal(both.isError, true);
		assert.match(textOf(none), /launchId/);
		assert.equal(none.details.pending, true);
		assert.equal(registry.calls.length, 0);
	});

	it("an unknown id is the unknown-id error", async () => {
		const r = await waitForLaunch(fakeRegistry({ status: "unknown" }), { launchId: "nope" });
		assert.equal(r.isError, true);
		assert.match(textOf(r), /Unknown launch id "nope"/);
	});

	it("a result the idle delivery already put in the session is a short note with the saved folders, not the result", async () => {
		const r = await waitForLaunch(fakeRegistry(settled({ consumed: true, consumedBy: "delivered" })), { launchId: "L1" });
		assert.equal(textOf(r), alreadyDeliveredText("L1", [{ agent: "scout", artifactsDir: "/d/runs/scout-1" }, { agent: "reviewer", artifactsDir: undefined }]));
		assert.ok(!textOf(r).includes("all good"));
		assert.equal(r.details.launchId, "L1");
		assert.equal(r.details.pending, true);
	});

	it("a launch left out of the delivered message gets the note that points to the folders, not the false 'in the conversation above'", async () => {
		const r = await waitForLaunch(fakeRegistry(settled({ consumed: true, consumedBy: "delivered-omitted" })), { launchId: "L1" });
		assert.match(textOf(r), /too large to include in the delivered message/);
		assert.ok(!textOf(r).includes("in the conversation above"));
	});

	it("a result first collected by wait or cancel is returned in full", async () => {
		for (const consumedBy of ["wait", "cancel"] as const) {
			const r = await waitForLaunch(fakeRegistry(settled({ consumed: true, consumedBy })), { launchId: "L1" });
			assert.equal(textOf(r), "all good");
		}
	});
});

describe("cancelLaunch", () => {
	it("cancels by launchId or the runId alias", async () => {
		for (const params of [{ launchId: "L1" }, { runId: "L1" }]) {
			const registry = fakeRegistry(settled());
			const r = await cancelLaunch(registry, params);
			assert.deepEqual(registry.calls, [{ op: "cancel", id: "L1" }]);
			assert.equal(textOf(r), "all good");
		}
	});

	it("an unknown id is the unknown-id error", async () => {
		const r = await cancelLaunch(fakeRegistry({ status: "unknown" }), { launchId: "nope" });
		assert.equal(r.isError, true);
		assert.equal(textOf(r), 'Unknown launch id "nope" (not started in this session, or pruned).');
	});

	it("a launch still running reports progress without a wait time", async () => {
		const r = await cancelLaunch(fakeRegistry(running), { launchId: "L1" });
		assert.equal(textOf(r), "Launch L1 still running: 2/5 done. Call subagent_wait again, or subagent_cancel.");
	});

	it("a settled launch returns its partial result", async () => {
		const r = await cancelLaunch(fakeRegistry(settled({ consumed: true, consumedBy: "cancel" }, launchResult("partial"))), { launchId: "L1" });
		assert.equal(textOf(r), "partial");
		assert.equal(r.details.launchId, "L1");
	});

	it("cancel after the idle delivery does not repeat the result", async () => {
		const r = await cancelLaunch(fakeRegistry(settled({ consumed: true, consumedBy: "delivered" })), { launchId: "L1" });
		assert.match(textOf(r), /already delivered to this session/);
		assert.ok(!textOf(r).includes("all good"));
	});

	it("a missing id is an error and never reaches the registry", async () => {
		const registry = fakeRegistry(settled());
		const r = await cancelLaunch(registry, {});
		assert.equal(r.isError, true);
		assert.equal(registry.calls.length, 0);
	});
});

describe("model-facing collect texts name launchId", () => {
	it("collectHint is the call the model should make", () => assert.equal(collectHint("L1"), 'subagent_wait {"launchId":"L1"}'));

	it("startedText gives the launch id, the task count, the agents, and how to collect and stop", () => {
		assert.equal(startedText("L1", 2, ["scout", "reviewer"]), 'Started async launch L1 (2 tasks: scout, reviewer). Collect it with subagent_wait {"launchId":"L1"}; stop it with subagent_cancel.');
		assert.match(startedText("L2", 1, ["scout"]), /\(1 task: scout\)/);
	});
});
