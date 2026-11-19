// S7: the permission-mode notice must reach the model again after a compaction drops it from context.
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
	dir = realpathSync(mkdtempSync(join(tmpdir(), "mode-compact-")));
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
	await pi.fire("session_start", {}, ctx);
	return {
		pi,
		ctx,
		async turn() {
			const messages: any[] = [];
			for (const h of pi.handlers.get("before_agent_start") ?? []) {
				const r: any = await h({ systemPromptOptions: {} }, ctx);
				if (r?.message) messages.push(r.message);
			}
			return messages.map((m) => m.content);
		},
	};
}

describe("mode notice and compaction", () => {
	it("announces the mode again on the first turn after a compaction", async () => {
		const s = await session();
		assert.deepEqual(await s.turn(), [MODE_PROMPT.normal]);
		await s.pi.fire("session_compact", { compactionEntry: { type: "compaction", id: "c1", firstKeptEntryId: "k" }, fromExtension: false }, s.ctx);
		assert.deepEqual(await s.turn(), [MODE_PROMPT.normal]);
		assert.deepEqual(await s.turn(), []);
	});

	it("re-announces on resume when the only notice sits before the latest compaction", async () => {
		const branch = [
			{ type: "custom_message", id: "n1", customType: "brigadev-mode-notice", content: MODE_PROMPT.normal, details: { mode: "normal" }, display: false },
			{ type: "message", id: "k", message: { role: "user", content: "next" } },
			{ type: "compaction", id: "c1", firstKeptEntryId: "k", summary: "s", tokensBefore: 1000 },
		];
		const s = await session(branch);
		assert.deepEqual(await s.turn(), [MODE_PROMPT.normal]);
	});
});
