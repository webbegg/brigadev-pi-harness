// Drives extensions/guard.ts: parent writes into the system temp dir or a secure-yolo folder run without asking,
// subagents stay blocked there, and any other write outside the project asks (with a session grant).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, home: string, agentDir: string, secure: string;
let uninstall: () => void;
let guard: (pi: any) => void;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "guard-outside-")));
	repo = join(dir, "repo");
	home = join(dir, "home");
	agentDir = join(home, ".pi", "agent");
	// Outside the system temp dir (which is trusted anyway); never created.
	secure = "/brigadev-test-not-temp/secure";
	mkdirSync(repo, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
	// HOME stays the real one: a fixture home inside the temp dir would make the guard drop that temp root.
	process.env.BRIGADEV_HOME = join(home, ".brigadev");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify({ secureYoloDirs: [secure] }));
	uninstall = installPiStubs();
	guard = (await import("../extensions/guard.ts")).default;
});
after(() => {
	uninstall();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

async function session(o: { answer?: boolean; child?: boolean } = {}) {
	const handlers: Record<string, Function[]> = {};
	const pi: any = {
		on: (e: string, h: Function) => (handlers[e] ??= []).push(h),
		registerCommand: () => {},
		registerShortcut: () => {},
		appendEntry: () => {},
		exec: async () => ({ stdout: "", stderr: "", code: 1 }),
	};
	const prevChild = process.env.BRIGADEV_CHILD;
	if (o.child) process.env.BRIGADEV_CHILD = "1";
	guard(pi);
	if (o.child) prevChild === undefined ? delete process.env.BRIGADEV_CHILD : (process.env.BRIGADEV_CHILD = prevChild);
	const asked: string[] = [];
	const ctx: any = {
		cwd: repo,
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: { confirm: async (title: string) => (asked.push(title), o.answer ?? false), notify: () => {}, setStatus: () => {}, select: async () => undefined },
	};
	for (const h of handlers.session_start ?? []) await h({}, ctx);
	let id = 0;
	return {
		asked,
		/** Runs tool_call and returns the block reason, or undefined when the call may run. */
		async run(toolName: string, path: string) {
			const toolCallId = String(++id);
			for (const h of handlers.tool_call ?? []) {
				const r = await h({ toolName, toolCallId, input: { path, content: "x" } }, ctx);
				if (r?.block) return String(r.reason);
			}
			return undefined;
		},
	};
}

describe("writes outside the project", () => {
	it("runs a parent write into the system temp dir without asking", async () => {
		const s = await session();
		assert.equal(await s.run("write", join("/tmp", `brigadev-guard-outside-${process.pid}`, "a.txt")), undefined);
		assert.deepEqual(s.asked, []);
	});

	it("runs a parent write into a secure-yolo folder without asking", async () => {
		const s = await session();
		assert.equal(await s.run("edit", join(secure, "notes.md")), undefined);
		assert.deepEqual(s.asked, []);
	});

	it("still asks elsewhere, and a granted write runs", async () => {
		const declined = await session({ answer: false });
		const elsewhere = "/brigadev-nonexistent-outside/x.txt";
		assert.match(String(await declined.run("write", elsewhere)), /declined/);
		assert.equal(declined.asked.length, 1);
		const granted = await session({ answer: true });
		assert.equal(await granted.run("write", elsewhere), undefined);
	});

	it("does not ask for reads or writes inside the project", async () => {
		const s = await session();
		await s.run("read", join(secure, "read.md"));
		await s.run("write", join(repo, "inside.ts"));
		assert.deepEqual(s.asked, []);
	});

	it("still asks for a git config or hook inside a secure-yolo folder or the temp dir", async () => {
		const hook = join(secure, "other", ".git", "hooks", "pre-commit");
		const gitConfig = join("/tmp", `brigadev-x-${process.pid}`, ".git", "config");
		for (const target of [hook, gitConfig]) {
			const declined = await session({ answer: false });
			assert.match(String(await declined.run("write", target)), /declined/);
			assert.deepEqual(declined.asked, ["brigadev: write outside project"]);
		}
		const granted = await session({ answer: true });
		assert.equal(await granted.run("edit", hook), undefined);
		assert.deepEqual(granted.asked, ["brigadev: write outside project"]);
	});

	it("keeps a plain file in a secure-yolo folder silent next to a protected one", async () => {
		const s = await session();
		assert.equal(await s.run("write", join(secure, "other", "plain.txt")), undefined);
		assert.deepEqual(s.asked, []);
	});

	it("keeps blocking a subagent in the temp dir and in a secure-yolo folder", async () => {
		const s = await session({ child: true });
		assert.match(String(await s.run("write", join("/tmp", "child.txt"))), /outside the project root/);
		assert.match(String(await s.run("write", join(secure, "child.txt"))), /outside the project root/);
	});

	it("a stored dsp default mode (a removed mode) loads as normal: an outside write still asks", async () => {
		const settings = join(agentDir, "brigadev.json");
		writeFileSync(settings, JSON.stringify({ secureYoloDirs: [secure], defaultMode: "dsp" }));
		try {
			const s = await session({ answer: false });
			assert.match(String(await s.run("write", "/brigadev-nonexistent-outside/dsp.txt")), /declined/);
			assert.deepEqual(s.asked, ["brigadev: write outside project"]);
		} finally {
			writeFileSync(settings, JSON.stringify({ secureYoloDirs: [secure] }));
		}
	});
});
