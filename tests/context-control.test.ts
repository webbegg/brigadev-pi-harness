// S16: context control. Decision logic (pure) and the extension against a fake pi/ctx.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { COMPACT_INSTRUCTIONS, CONTEXT_DEFAULTS, type ControlState, decide, describeContextControl, resolveContextSettings, resetCompactionRecord } from "../lib/context-control.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const MIN = 60_000;
const NOW = 10_000_000_000;
const base: ControlState = { child: false, trigger: "settled", tokens: 50_000, turnsSinceCompact: 3, lastTurnEndMs: NOW - MIN };
const S = CONTEXT_DEFAULTS;

describe("resolveContextSettings", () => {
	it("defaults", () => assert.deepEqual(resolveContextSettings(undefined), { enabled: true, compactAt: 160_000, idleCompactMinutes: 60, idleCompactMin: 100_000 }));
	it("takes valid values and ignores invalid ones", () => {
		assert.deepEqual(resolveContextSettings({ enabled: false, compactAt: 0, idleCompactMinutes: 30, idleCompactMin: "x" }), { enabled: false, compactAt: 0, idleCompactMinutes: 30, idleCompactMin: 100_000 });
		assert.equal(resolveContextSettings({ compactAt: -5 }).compactAt, 160_000);
		assert.equal(resolveContextSettings("nope").enabled, true);
	});
});

describe("decide", () => {
	it("compacts at the threshold at a turn boundary", () => {
		assert.deepEqual(decide({ ...base, tokens: 160_000 }, S, NOW), { action: "compact", reason: "threshold" });
		assert.deepEqual(decide({ ...base, tokens: 159_999 }, S, NOW), { action: "none", reason: "below-threshold" });
	});
	it("compacts a prompt after > 60 min idle with >= 100k context", () => {
		const input: ControlState = { ...base, trigger: "input", tokens: 120_000, lastTurnEndMs: NOW - 61 * MIN };
		assert.deepEqual(decide(input, S, NOW), { action: "compact", reason: "idle" });
		assert.equal(decide({ ...input, lastTurnEndMs: NOW - 59 * MIN }, S, NOW).action, "none");
		assert.equal(decide({ ...input, tokens: 99_000 }, S, NOW).action, "none");
	});
	it("the idle rule applies only to a new prompt, not to a settled agent", () => {
		assert.equal(decide({ ...base, trigger: "settled", tokens: 120_000, lastTurnEndMs: NOW - 90 * MIN }, S, NOW).action, "none");
	});
	it("a prompt above the threshold compacts even without an idle gap", () => {
		assert.deepEqual(decide({ ...base, trigger: "input", tokens: 170_000 }, S, NOW), { action: "compact", reason: "threshold" });
	});
	it("does nothing when disabled, in a child, busy, or without usage", () => {
		const high = { ...base, tokens: 500_000 };
		assert.deepEqual(decide(high, { ...S, enabled: false }, NOW), { action: "none", reason: "disabled" });
		assert.deepEqual(decide({ ...high, child: true }, S, NOW), { action: "none", reason: "child" });
		assert.deepEqual(decide({ ...high, busy: true }, S, NOW), { action: "none", reason: "busy" });
		assert.deepEqual(decide({ ...high, tokens: null }, S, NOW), { action: "none", reason: "no-usage" });
	});
	it("compactAt 0 turns the threshold off; idleCompactMinutes 0 turns the idle rule off", () => {
		assert.equal(decide({ ...base, tokens: 900_000 }, { ...S, compactAt: 0 }, NOW).action, "none");
		const input: ControlState = { ...base, trigger: "input", tokens: 120_000, lastTurnEndMs: NOW - 600 * MIN };
		assert.equal(decide(input, { ...S, idleCompactMinutes: 0 }, NOW).action, "none");
	});
	it("never compacts twice in a row without new turns", () => {
		assert.deepEqual(decide({ ...base, tokens: 500_000, turnsSinceCompact: 0 }, S, NOW), { action: "none", reason: "no-new-turns" });
	});
});

describe("describeContextControl", () => {
	it("is one short line", () => {
		const line = describeContextControl(S, { atMs: NOW - 5 * MIN, reason: "threshold", tokens: 172_000 }, NOW);
		assert.equal(line, "context control: compact at 160k, after 60 min idle from 100k; last: threshold at 172k, 5 min ago");
		assert.match(describeContextControl({ ...S, enabled: false }, undefined, NOW), /off/);
	});
});

describe("extension", () => {
	const saved = { ...process.env };
	let dir: string, uninstall: () => void, agentDir: string;
	let extension: (pi: any) => void;
	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "context-control-")));
		agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		uninstall = installPiStubs();
		extension = (await import("../extensions/context-control.ts")).default;
	});
	after(() => {
		uninstall();
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});
	beforeEach(() => {
		delete process.env.BRIGADEV_CHILD;
		writeFileSync(join(agentDir, "brigadev.json"), "{}");
		resetCompactionRecord();
	});

	function setup(tokens: number | null, opts: { autoComplete?: boolean; branch?: unknown[] } = {}) {
		const pi: any = createFakePi();
		const sent: Array<{ content: unknown; options: unknown }> = [];
		pi.sendUserMessage = (content: unknown, options: unknown) => void sent.push({ content, options });
		extension(pi);
		const ctx: any = createFakeCtx({ cwd: dir, idle: true });
		const compactions: any[] = [];
		ctx.tokens = tokens;
		ctx.getContextUsage = () => ({ tokens: ctx.tokens, contextWindow: 1_000_000, percent: null });
		ctx.sessionManager = { getBranch: () => opts.branch ?? [] };
		ctx.compact = (o: any) => {
			compactions.push(o);
			if (opts.autoComplete !== false) o.onComplete?.({});
		};
		return { pi, ctx, sent, compactions };
	}

	it("at a turn boundary above the threshold, compacts with the preservation instructions and notifies", async () => {
		const { pi, ctx, compactions } = setup(170_000);
		await pi.fire("turn_end", {}, ctx);
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(compactions.length, 1);
		assert.equal(compactions[0].customInstructions, COMPACT_INSTRUCTIONS);
		for (const part of ["verbatim", "branch", "feature document", "todo", "test command", "next step"]) assert.ok(COMPACT_INSTRUCTIONS.includes(part), part);
		assert.ok(ctx.notifications.length >= 1);
		assert.equal(pi.messages.length, 0, "no model-facing text");
	});

	it("does not compact below the threshold", async () => {
		const { pi, ctx, compactions } = setup(100_000);
		await pi.fire("turn_end", {}, ctx);
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(compactions.length, 0);
	});

	it("does not compact twice without new turns", async () => {
		const { pi, ctx, compactions } = setup(170_000, { autoComplete: false });
		await pi.fire("turn_end", {}, ctx);
		await pi.fire("agent_settled", {}, ctx);
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(compactions.length, 1, "in flight");
		ctx.compact = (o: any) => void compactions.push(o);
		await pi.fire("session_compact", {}, ctx);
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(compactions.length, 1, "no new turn since the compaction");
		await pi.fire("turn_end", {}, ctx);
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(compactions.length, 2);
	});

	it("is disabled by context.enabled=false and by compactAt=0", async () => {
		writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify({ context: { enabled: false } }));
		let t = setup(500_000);
		await t.pi.fire("turn_end", {}, t.ctx);
		await t.pi.fire("agent_settled", {}, t.ctx);
		assert.equal(t.compactions.length, 0);
		writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify({ context: { compactAt: 0 } }));
		t = setup(500_000);
		await t.pi.fire("turn_end", {}, t.ctx);
		await t.pi.fire("agent_settled", {}, t.ctx);
		assert.equal(t.compactions.length, 0);
	});

	it("registers nothing in a child session", () => {
		process.env.BRIGADEV_CHILD = "1";
		const { pi } = setup(500_000);
		assert.equal(pi.handlers.size, 0);
	});

	it("a prompt after > 60 min idle with >= 100k context is compacted first, then resubmitted", async () => {
		const old = new Date(Date.now() - 90 * MIN).toISOString();
		const { pi, ctx, sent, compactions } = setup(120_000, { branch: [{ type: "message", timestamp: old, message: { role: "assistant", timestamp: Date.now() - 90 * MIN } }] });
		const [result] = [await (pi.handlers.get("input") ?? [])[0]({ text: "next task", source: "interactive" }, ctx)];
		assert.deepEqual(result, { action: "handled" });
		assert.equal(compactions.length, 1);
		assert.equal(compactions[0].customInstructions, COMPACT_INSTRUCTIONS);
		assert.equal(sent.length, 1, "resubmitted after the compaction");
		assert.equal(sent[0].content, "next task");
		assert.deepEqual(sent[0].options, { expandPromptTemplates: true });
	});

	it("the resubmitted prompt waits for the compaction and is still sent if it fails", async () => {
		const old = Date.now() - 90 * MIN;
		const { pi, ctx, sent, compactions } = setup(120_000, { autoComplete: false, branch: [{ type: "message", message: { role: "assistant", timestamp: old } }] });
		const result = await pi.handlers.get("input")![0]({ text: "next", source: "interactive" }, ctx);
		assert.deepEqual(result, { action: "handled" });
		assert.equal(sent.length, 0);
		compactions[0].onError(new Error("boom"));
		assert.equal(sent.length, 1);
		assert.ok(ctx.notifications.some((n: any) => /boom/.test(n.message)));
	});

	it("never swallows a prompt where nobody resubmits it: rpc input and sessions without a UI", async () => {
		const old = { branch: [{ type: "message", message: { role: "assistant", timestamp: Date.now() - 90 * MIN } }] };
		const rpc = setup(120_000, old);
		assert.deepEqual(await rpc.pi.handlers.get("input")![0]({ text: "x", source: "rpc" }, rpc.ctx), { action: "continue" });
		const headless = setup(120_000, old);
		headless.ctx.hasUI = false;
		assert.deepEqual(await headless.pi.handlers.get("input")![0]({ text: "x", source: "interactive" }, headless.ctx), { action: "continue" });
		assert.equal(rpc.compactions.length + headless.compactions.length, 0);
	});

	it("lets a prompt through when the gap is short, for extension messages, and for queued input", async () => {
		const { pi, ctx, compactions } = setup(120_000, { branch: [{ type: "message", message: { role: "assistant", timestamp: Date.now() - 5 * MIN } }] });
		const input = pi.handlers.get("input")![0];
		assert.deepEqual(await input({ text: "x", source: "interactive" }, ctx), { action: "continue" });
		await pi.fire("turn_end", {}, ctx);
		const old = setup(120_000, { branch: [{ type: "message", message: { role: "assistant", timestamp: Date.now() - 90 * MIN } }] });
		const oldInput = old.pi.handlers.get("input")![0];
		assert.deepEqual(await oldInput({ text: "x", source: "extension" }, old.ctx), { action: "continue" });
		assert.deepEqual(await oldInput({ text: "x", source: "interactive", streamingBehavior: "steer" }, old.ctx), { action: "continue" });
		assert.equal(compactions.length + old.compactions.length, 0);
	});

	// LOOP R1-001 / R3-004: the swallowed prompt is resubmitted exactly once, whatever ctx.compact does.
	const idleBranch = () => ({ branch: [{ type: "message", message: { role: "assistant", timestamp: Date.now() - 90 * MIN } }] });

	it("resubmits at once when ctx.compact throws, and a later compaction can run", async () => {
		const { pi, ctx, sent } = setup(170_000);
		ctx.compact = () => {
			throw new Error("no session");
		};
		assert.deepEqual(await pi.handlers.get("input")![0]({ text: "next", source: "interactive" }, ctx), { action: "handled" });
		assert.equal(sent.length, 1);
		assert.equal(sent[0].content, "next");
		assert.ok(ctx.notifications.some((n: any) => /no session/.test(n.message)));
		ctx.compact = () => {};
		await pi.fire("turn_end", {}, ctx);
		assert.deepEqual(await pi.handlers.get("input")![0]({ text: "again", source: "interactive" }, ctx), { action: "handled" }, "inFlight was reset, so the next prompt over the threshold compacts again");
	});

	it("resubmits as a follow-up when the agent is not idle when the compaction ends", async () => {
		const { pi, ctx, sent } = setup(120_000, { ...idleBranch(), autoComplete: false });
		const compactions: any[] = [];
		ctx.compact = (o: any) => void compactions.push(o);
		await pi.handlers.get("input")![0]({ text: "next", source: "interactive" }, ctx);
		ctx.idle = false;
		compactions[0].onComplete({});
		assert.deepEqual(sent[0].options, { expandPromptTemplates: true, deliverAs: "followUp" });
		const second = setup(120_000, idleBranch());
		second.ctx.idle = true;
		await second.pi.handlers.get("input")![0]({ text: "next", source: "interactive" }, second.ctx);
		assert.deepEqual(second.sent[0].options, { expandPromptTemplates: true });
	});

	it("a compaction that never calls back is resubmitted by the safety timeout, once", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { pi, ctx, sent } = setup(120_000, { ...idleBranch(), autoComplete: false });
		const compactions: any[] = [];
		ctx.compact = (o: any) => void compactions.push(o);
		await pi.handlers.get("input")![0]({ text: "next", source: "interactive" }, ctx);
		t.mock.timers.tick(119_000);
		assert.equal(sent.length, 0);
		t.mock.timers.tick(2_000);
		assert.equal(sent.length, 1);
		compactions[0].onComplete({});
		compactions[0].onError(new Error("late"));
		t.mock.timers.tick(300_000);
		assert.equal(sent.length, 1, "exactly once");
	});

	it("a callback that arrives in time cancels the safety timeout and fires twice at most once", async (t) => {
		t.mock.timers.enable({ apis: ["setTimeout"] });
		const { pi, ctx, sent } = setup(120_000, { ...idleBranch(), autoComplete: false });
		const compactions: any[] = [];
		ctx.compact = (o: any) => void compactions.push(o);
		await pi.handlers.get("input")![0]({ text: "next", source: "interactive" }, ctx);
		compactions[0].onComplete({});
		compactions[0].onError(new Error("again"));
		t.mock.timers.tick(300_000);
		assert.equal(sent.length, 1);
	});
});
