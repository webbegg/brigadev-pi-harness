// brigadev-t3: active only in a T3 Code session; brigadev bus snapshots become T3 status chips, and the T3 section joins the prompt.
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createFakeCtx, createFakePi, type FakeCtx, type FakePi } from "../../tests/helpers/fake-pi.ts";
import brigadevT3 from "../src/extension.ts";
import { CHANNELS } from "../src/channels.ts";
import { SECTION_KEY, T3_SECTION, T3_SECTION_TAGGED } from "../src/prompt.ts";
import { STATUS_KEYS } from "../src/statuses.ts";

const saved = { ...process.env };
beforeEach(() => {
	process.env.T3CODE_THREAD_ID = "thread-1";
	delete process.env.BRIGADEV_CHILD;
});
afterEach(() => {
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

async function started(): Promise<{ pi: FakePi; ctx: FakeCtx; chip: (key: string) => string | undefined }> {
	const pi = createFakePi();
	brigadevT3(pi as any);
	const ctx = createFakeCtx({ cwd: process.cwd() });
	await pi.fire("session_start", {}, ctx);
	const chip = (key: string) => ctx.statuses.filter((s) => s.key === key).at(-1)?.text;
	return { pi, ctx, chip };
}

describe("brigadev-t3", () => {
	it("does nothing outside T3 Code, or in a subagent", () => {
		delete process.env.T3CODE_THREAD_ID;
		const outside = createFakePi();
		brigadevT3(outside as any);
		assert.equal(outside.handlers.size, 0);
		process.env.T3CODE_THREAD_ID = "thread-1";
		process.env.BRIGADEV_CHILD = "1";
		const child = createFakePi();
		brigadevT3(child as any);
		assert.equal(child.handlers.size, 0);
	});

	it("shows the phase while a run is active, and clears it when idle", async () => {
		const { pi, chip } = await started();
		pi.events.emit(CHANNELS.phase, { scope: "loop", phase: "implement", running: true });
		assert.equal(chip(STATUS_KEYS.phase), "brigadev ▸ implement");
		pi.events.emit(CHANNELS.phase, { scope: "loop", phase: "idle", running: false });
		assert.equal(chip(STATUS_KEYS.phase), undefined);
	});

	it("shows todo progress and the last check", async () => {
		const { pi, chip } = await started();
		pi.events.emit(CHANNELS.todo, { scope: "todo", todos: [{ id: "T1", text: "a", status: "done" }, { id: "T2", text: "b", status: "in_progress" }] });
		assert.equal(chip(STATUS_KEYS.todo), "todo 1/2");
		pi.events.emit(CHANNELS.check, { id: "c1", command: "npm test", outcome: "fail", counts: { pass: 10, fail: 2 }, at: 1 });
		assert.equal(chip(STATUS_KEYS.check), "check ✗ 2 failed");
		pi.events.emit(CHANNELS.check, { id: "c2", command: "npm test", outcome: "pass", counts: { pass: 12, fail: 0 }, at: 2 });
		assert.equal(chip(STATUS_KEYS.check), "check ✓ 12 passed");
	});

	it("sets a chip only when its text changes", async () => {
		const { pi, ctx } = await started();
		const before = ctx.statuses.length;
		pi.events.emit(CHANNELS.phase, { scope: "loop", phase: "explore", running: true });
		pi.events.emit(CHANNELS.phase, { scope: "loop", phase: "explore", running: true });
		assert.equal(ctx.statuses.length, before + 1);
	});

	it("keeps snapshots that arrive before a session UI, and shows them once one starts", async () => {
		const pi = createFakePi();
		brigadevT3(pi as any);
		pi.events.emit(CHANNELS.check, { outcome: "pass", counts: { pass: 4, fail: 0 } });
		const ctx = createFakeCtx({ cwd: process.cwd() });
		await pi.fire("before_agent_start", { systemPrompt: "", systemPromptOptions: { sections: {} } }, ctx);
		assert.equal(ctx.statuses.find((s) => s.key === STATUS_KEYS.check)?.text, "check ✓ 4 passed");
	});

	it("a new session starts with no chips", async () => {
		const { pi, ctx, chip } = await started();
		pi.events.emit(CHANNELS.check, { outcome: "fail", counts: { pass: 1, fail: 1 } });
		await pi.fire("session_start", {}, ctx);
		assert.equal(chip(STATUS_KEYS.check), undefined);
	});

	it("stops listening when the session shuts down", async () => {
		const { pi, ctx } = await started();
		await pi.fire("session_shutdown", {}, ctx);
		const before = ctx.statuses.length;
		pi.events.emit(CHANNELS.phase, { scope: "loop", phase: "check", running: true });
		assert.equal(ctx.statuses.length, before);
	});

	it("ignores malformed snapshots", async () => {
		const { pi, chip } = await started();
		pi.events.emit(CHANNELS.check, null);
		pi.events.emit(CHANNELS.phase, { running: true });
		pi.events.emit(CHANNELS.todo, "nope");
		assert.equal(chip(STATUS_KEYS.check), undefined);
		assert.equal(chip(STATUS_KEYS.phase), undefined);
		assert.equal(chip(STATUS_KEYS.todo), undefined);
	});

	it("adds the T3 section to the prompt's sections, or to a forced prompt", async () => {
		const { pi, ctx } = await started();
		const handler = pi.handlers.get("before_agent_start")![0];
		const options = { sections: {} as Record<string, string> };
		assert.equal(await handler({ systemPrompt: "base", systemPromptOptions: options }, ctx), undefined);
		assert.equal(options.sections[SECTION_KEY], T3_SECTION);
		const forced = await handler({ systemPrompt: "base", systemPromptOptions: { sections: {}, forceSystemPrompt: "base" } }, ctx);
		assert.deepEqual(forced, { systemPrompt: `base\n\n${T3_SECTION_TAGGED}` });
	});
});
