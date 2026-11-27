// Drives extensions/guard.ts: a protected path (the agent folder with brigadev.json) that happens to sit under the
// system temp dir is not trusted temp content: a parent write there still asks, in normal and yolo mode alike.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, agentDir: string;
let uninstall: () => void;
let guard: (pi: any) => void;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "guard-protected-temp-")));
	repo = join(dir, "repo");
	agentDir = join(dir, "agent");
	mkdirSync(repo, { recursive: true });
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

async function session(mode?: string) {
	const handlers: Record<string, Function[]> = {};
	const pi: any = { on: (e: string, h: Function) => (handlers[e] ??= []).push(h), registerCommand: () => {}, registerShortcut: () => {}, appendEntry: () => {}, exec: async () => ({ stdout: "", stderr: "", code: 1 }) };
	guard(pi);
	const asked: string[] = [];
	const ctx: any = {
		cwd: repo,
		hasUI: true,
		sessionManager: { getBranch: () => (mode ? [{ type: "custom", customType: "brigadev-mode", data: { mode } }] : []) },
		ui: { confirm: async (t: string) => (asked.push(t), false), notify: () => {}, setStatus: () => {}, select: async () => undefined },
	};
	for (const h of handlers.session_start ?? []) await h({}, ctx);
	return {
		asked,
		async write(path: string) {
			for (const h of handlers.tool_call ?? []) {
				const r = await h({ toolName: "write", toolCallId: "1", input: { path, content: "{}" } }, ctx);
				if (r?.block) return String(r.reason);
			}
			return undefined;
		},
	};
}

describe("protected paths under the temp dir", () => {
	for (const mode of [undefined, "yolo"]) {
		it(`asks before a parent write to the agent folder's brigadev.json (${mode ?? "normal"} mode)`, async () => {
			const s = await session(mode);
			assert.match(String(await s.write(join(agentDir, "brigadev.json"))), /declined/);
			assert.deepEqual(s.asked, ["brigadev · Needs your permission: change files outside the project"]);
		});
	}

	it("keeps a plain file in the temp dir silent", async () => {
		const s = await session();
		assert.equal(await s.write(join(dir, "plain.txt")), undefined);
		assert.deepEqual(s.asked, []);
	});
});
