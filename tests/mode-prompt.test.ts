// S7: the permission mode is not in the system prompt; a mode switch announces it through a context message.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { MODE_PROMPT } from "../lib/permission-policy.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string;
let uninstall: () => void;
let guard: (pi: any) => void;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mode-prompt-")));
	repo = join(dir, "repo");
	const agentDir = join(dir, "home", ".pi", "agent");
	mkdirSync(repo, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
	process.env.BRIGADEV_HOME = join(dir, "home", ".brigadev");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	uninstall = installPiStubs();
	guard = (await import("../extensions/guard.ts")).default;
});
after(() => {
	uninstall();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

async function session(branch: unknown[] = []) {
	const pi = createFakePi();
	guard(pi);
	const ctx: any = createFakeCtx({ cwd: repo, hasUI: true });
	ctx.sessionManager = { getBranch: () => branch };
	ctx.ui.select = async () => undefined;
	await pi.fire("session_start", {}, ctx);
	return {
		pi,
		ctx,
		async setMode(mode: string) {
			await pi.commands.get("brigadev:mode").handler(mode, ctx);
		},
		/** One turn start: the system text the guard appended and the context messages it returned. */
		async turn() {
			const options: { appendSystemPrompt?: string } = {};
			const messages: any[] = [];
			for (const handler of pi.handlers.get("before_agent_start") ?? []) {
				const result = await handler({ systemPromptOptions: options }, ctx);
				if (result?.message) messages.push(result.message);
			}
			return { appended: options.appendSystemPrompt, messages };
		},
	};
}

describe("permission mode and the system prompt", () => {
	it("appends the same system text in normal and yolo (the guard appends none)", async () => {
		const s = await session();
		const normal = (await s.turn()).appended;
		await s.setMode("yolo");
		const yolo = (await s.turn()).appended;
		await s.setMode("normal");
		const back = (await s.turn()).appended;
		assert.equal(yolo, normal);
		assert.equal(back, normal);
		assert.equal(normal, undefined);
	});

	it("announces the mode on the first turn, as a hidden context message", async () => {
		const s = await session();
		const first = await s.turn();
		assert.equal(first.messages.length, 1);
		assert.equal(first.messages[0].content, MODE_PROMPT.normal);
		assert.equal(first.messages[0].display, false);
		assert.deepEqual((await s.turn()).messages, []);
	});

	it("announces a mode switch on the next turn, and a repeat of the same mode adds none", async () => {
		const s = await session();
		await s.turn();
		await s.setMode("yolo");
		assert.deepEqual((await s.turn()).messages.map((m) => m.content), [MODE_PROMPT.yolo]);
		await s.setMode("yolo");
		assert.deepEqual((await s.turn()).messages, []);
		await s.setMode("normal");
		assert.deepEqual((await s.turn()).messages.map((m) => m.content), [MODE_PROMPT.normal]);
	});

	it("does not repeat the announcement when a resumed session already holds it", async () => {
		const announced = [{ type: "custom_message", customType: "brigadev-mode-notice", content: MODE_PROMPT.normal, details: { mode: "normal" }, display: false }];
		const s = await session(announced);
		assert.deepEqual((await s.turn()).messages, []);
	});

	it("a subagent gets no mode message", async () => {
		process.env.BRIGADEV_CHILD = "1";
		const pi = createFakePi();
		try {
			guard(pi);
		} finally {
			delete process.env.BRIGADEV_CHILD;
		}
		const ctx: any = createFakeCtx({ cwd: repo, hasUI: false });
		for (const handler of pi.handlers.get("before_agent_start") ?? []) assert.equal(await handler({ systemPromptOptions: {} }, ctx), undefined);
	});
});
