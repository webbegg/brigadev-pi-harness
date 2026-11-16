// Verifier round 3 (S10): the bash lock must not depend on a file the locked shell itself can rewrite. A process the
// agent started earlier (bg_start, `nohup … &`) can replace a lock file after the guard wrote it and before the shell
// reads it; the command must still run without the parent's secrets.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

describe("S10 lock survives a rewrite of its private files after the decision", () => {
	const saved = { ...process.env };
	let dir: string;
	let repo: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;

	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "dsp-verify3-race-")));
		repo = join(dir, "repo");
		const home = join(dir, "home");
		mkdirSync(repo, { recursive: true });
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		Object.assign(process.env, { HOME: home, BRIGADEV_HOME: join(home, ".brigadev"), PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), GH_TOKEN: "ghp_race", SSH_AUTH_SOCK: "/race.sock" });
		const g = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "ignore" });
		g("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "a.txt"), "a\n");
		g("add", "-A");
		g("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		g("branch", "main");
		uninstall = installPiStubs();
		guard = (await import("../extensions/guard.ts")).default;
	});

	after(() => {
		uninstall();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	it("DSP: replacing every file in the lock dir after tool_call does not unlock the command", async () => {
		const pi = createFakePi();
		const ctx: any = createFakeCtx({ cwd: repo, hasUI: true });
		ctx.ui.confirm = async () => false;
		ctx.sessionManager = { getBranch: () => [{ type: "custom", customType: "brigadev-mode", data: { mode: "dsp" } }] };
		guard(pi);
		await pi.fire("session_start", {}, ctx);
		const event = { toolName: "bash", toolCallId: "race-1", input: { command: 'echo "[$GH_TOKEN][$SSH_AUTH_SOCK]"' } };
		for (const handler of pi.handlers.get("tool_call") ?? []) await handler(event, ctx);
		// What a loop started by an earlier call does between the decision and the spawn: it would rewrite the lock's files. The lock keeps
		// none (an inline prelude), so there is nothing to replace, and the command below must still run without the parent's secrets.
		const output = execFileSync("bash", ["-c", event.input.command], { cwd: repo, env: process.env, encoding: "utf8" });
		assert.equal(output.trim(), "[][]");
		await pi.fire("session_shutdown", { reason: "quit" }, ctx);
	});
});
