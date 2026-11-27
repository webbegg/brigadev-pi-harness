// extensions/guard.ts on the bus: a guard confirm is answerable from the TUI or the web (first wins), and the guard publishes its decisions and mode.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { BUS, type GuardDecision, type ModeState, type PromptState } from "../lib/bus.ts";
import { createFakeCtx, createFakePi, type FakeCtx, type FakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, project: string;
let uninstall: () => void;
let guard: (pi: any) => void;
let counter = 0;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "guard-web-prompt-")));
	project = join(dir, "project");
	const agentDir = join(dir, "agent");
	mkdirSync(project, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
	process.env.BRIGADEV_HOME = join(dir, "bhome");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify({}));
	uninstall = installPiStubs();
	guard = (await import("../extensions/guard.ts")).default;
});
after(() => {
	uninstall();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

interface Dialog {
	title: string;
	body: string;
	signal?: AbortSignal;
	resolve: (value: boolean) => void;
}

/** A parent session with a guard; its confirm dialog stays open until the test settles it. */
async function session(options: { hasUI?: boolean; mode?: "yolo"; signal?: AbortSignal } = {}) {
	const pi: FakePi = createFakePi();
	guard(pi);
	const ctx: FakeCtx = createFakeCtx({ cwd: project, hasUI: options.hasUI });
	// Pi's `ctx.signal`: the run's abort signal (Esc, the web Abort button).
	if (options.signal) (ctx as any).signal = options.signal;
	const dialogs: Dialog[] = [];
	(ctx.ui as any).confirm = (title: string, body: string, opts?: { signal?: AbortSignal }) => new Promise<boolean>((resolve) => dialogs.push({ title, body, signal: opts?.signal, resolve }));
	(ctx.ui as any).select = async () => undefined;
	if (options.mode) (ctx as any).sessionManager = { getBranch: () => [{ type: "custom", customType: "brigadev-mode", data: { mode: options.mode } }] };
	await pi.fire("session_start", {}, ctx);

	const channel = <T>(name: string) => pi.emitted.filter((e) => e.channel === name).map((e) => e.data as T);
	const call = (toolName: string, input: unknown) => {
		const toolCallId = `call-${++counter}`;
		const result = (async () => {
			for (const handler of pi.handlers.get("tool_call") ?? []) {
				const r = (await handler({ toolName, toolCallId, input }, ctx)) as { block?: boolean; reason?: string } | undefined;
				if (r?.block) return r;
			}
			return undefined;
		})();
		return { toolCallId, result };
	};
	const open = async (): Promise<PromptState> => {
		for (let i = 0; i < 200; i++) {
			const prompt = channel<PromptState>(BUS.prompt).find((p) => p.status === "open");
			if (prompt) return prompt;
			await new Promise((resolve) => setImmediate(resolve));
		}
		throw new Error("no prompt opened");
	};
	const answer = (id: string, value: unknown) => pi.events.emit(BUS.action, { action: "answer", id, value });
	return { pi, ctx, dialogs, call, open, answer, prompts: () => channel<PromptState>(BUS.prompt), decisions: () => channel<GuardDecision>(BUS.guard), modes: () => channel<ModeState>(BUS.mode) };
}

describe("guard confirm answered from the bus", () => {
	it("a web yes lets the call run, aborts the TUI dialog, and publishes confirm then allow", async () => {
		const s = await session();
		const { toolCallId, result } = s.call("bash", { command: "rm -rf build" });
		const prompt = await s.open();
		assert.equal(prompt.kind, "confirm");
		assert.equal(prompt.source, "guard");
		assert.match(prompt.title, /^brigadev · Needs your permission: /);
		assert.match(prompt.body ?? "", /rm -rf build/);

		s.answer(prompt.id, true);
		assert.equal(await result, undefined);
		assert.equal(s.dialogs.length, 1);
		assert.equal(s.dialogs[0].signal?.aborted, true);
		const final = s.prompts().at(-1)!;
		assert.deepEqual([final.id, final.status, final.answer, final.by], [prompt.id, "answered", true, "web"]);
		assert.deepEqual(s.decisions().map((d) => [d.action, d.toolCallId, d.tool]), [["confirm", toolCallId, "bash"], ["allow", toolCallId, "bash"]]);
		assert.equal(s.decisions()[0].subject, "rm -rf build");
	});

	it("a web no blocks the call and publishes confirm then block with the reason", async () => {
		const s = await session();
		const { toolCallId, result } = s.call("bash", { command: "rm -rf build" });
		const prompt = await s.open();
		s.answer(prompt.id, false);
		const blocked = await result;
		assert.equal(blocked?.block, true);
		assert.match(String(blocked?.reason), /User declined/);
		const decisions = s.decisions();
		assert.deepEqual(decisions.map((d) => [d.action, d.toolCallId]), [["confirm", toolCallId], ["block", toolCallId]]);
		assert.match(String(decisions[1].reason), /User declined/);
		assert.notEqual(decisions[0].id, decisions[1].id);
	});

	it("the TUI answering first wins, and a late web answer changes nothing", async () => {
		const s = await session();
		const { result } = s.call("read", { path: ".env" });
		const prompt = await s.open();
		assert.match(prompt.title, /may hold secrets/);
		s.dialogs[0].resolve(true);
		assert.equal(await result, undefined);
		assert.equal(s.dialogs[0].signal?.aborted, false);
		const before = s.prompts().length;
		s.answer(prompt.id, false);
		assert.equal(s.prompts().length, before);
		assert.deepEqual([s.prompts().at(-1)!.status, s.prompts().at(-1)!.by], ["answered", "tui"]);
	});

	it("a wrong-typed web answer is ignored; the TUI still decides", async () => {
		const s = await session();
		const { result } = s.call("read", { path: ".env" });
		const prompt = await s.open();
		s.answer(prompt.id, "yes");
		assert.equal(s.prompts().length, 1);
		s.dialogs[0].resolve(false);
		assert.equal((await result)?.block, true);
	});

	it("an aborted run closes the pending confirm in the TUI and on the bus, blocks the call, and a late web answer has no effect", async () => {
		const run = new AbortController();
		const s = await session({ signal: run.signal });
		const { result } = s.call("bash", { command: "rm -rf build" });
		const prompt = await s.open();
		run.abort();
		const blocked = await result;
		assert.equal(blocked?.block, true);
		assert.equal(s.dialogs[0].signal?.aborted, true, "the TUI dialog got the abort");
		assert.deepEqual([s.prompts().at(-1)!.id, s.prompts().at(-1)!.status], [prompt.id, "dismissed"]);
		const count = s.prompts().length;
		s.answer(prompt.id, true);
		assert.equal(s.prompts().length, count);
		assert.equal(s.decisions().at(-1)?.action, "block");
	});

	it("what leaves for the bus is redacted: the decision's subject and the prompt's body (the TUI dialog still shows the real command)", async () => {
		const s = await session();
		const { result } = s.call("bash", { command: "rm -rf build && curl -H 'Authorization: Bearer abc.def' https://me:hunter2@x.test --password=hunter2" });
		const prompt = await s.open();
		const published = JSON.stringify([s.prompts(), s.decisions()]);
		for (const leak of ["hunter2", "abc.def"]) assert.ok(!published.includes(leak), `leaked ${leak}`);
		assert.match(prompt.body ?? "", /rm -rf build/);
		assert.match(s.decisions()[0].subject ?? "", /https:\/\/\*\*\*@x\.test/);
		assert.match(s.dialogs[0].body, /hunter2/, "the person at the terminal sees the real command");
		s.answer(prompt.id, false);
		await result;
	});

	it("a hard block publishes a block decision and asks nothing", async () => {
		const s = await session();
		const { toolCallId, result } = s.call("bash", { command: "rm -rf ~" });
		assert.equal((await result)?.block, true);
		assert.equal(s.dialogs.length, 0);
		assert.equal(s.prompts().length, 0);
		assert.deepEqual(s.decisions().map((d) => [d.action, d.toolCallId]), [["block", toolCallId]]);
	});

	it("without a UI the answer is no without asking; the block is published", async () => {
		const s = await session({ hasUI: false });
		const { result } = s.call("read", { path: ".env" });
		assert.equal((await result)?.block, true);
		assert.equal(s.dialogs.length, 0);
		assert.equal(s.prompts().length, 0);
		assert.deepEqual(s.decisions().map((d) => d.action), ["block"]);
	});

	it("an ordinary allowed call publishes no decision and no prompt", async () => {
		const s = await session();
		const { result } = s.call("bash", { command: "echo hello" });
		assert.equal(await result, undefined);
		assert.equal((await s.call("read", { path: "README.md" }).result), undefined);
		assert.equal(s.decisions().length, 0);
		assert.equal(s.prompts().length, 0);
	});
});

describe("guard mode on the bus", () => {
	it("publishes the mode at session start, after it is restored", async () => {
		const normal = await session();
		assert.deepEqual(normal.modes(), [{ scope: "mode", mode: "normal" }]);
		const yolo = await session({ mode: "yolo" });
		assert.deepEqual(yolo.modes(), [{ scope: "mode", mode: "yolo" }]);
	});

	it("publishes every mode change", async () => {
		const s = await session();
		await s.pi.commands.get("brigadev:mode").handler("yolo", s.ctx);
		await s.pi.commands.get("brigadev:mode").handler("normal", s.ctx);
		assert.deepEqual(s.modes().map((m) => m.mode), ["normal", "yolo", "normal"]);
	});
});
