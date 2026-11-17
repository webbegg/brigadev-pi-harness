// Drives extensions/guard.ts: parent writes into the system temp dir or a secure-yolo folder run without asking,
// subagents stay blocked there, and every successful parent write outside the project lands in the ledger.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { canonicalPath } from "../lib/paths.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, home: string, agentDir: string, secure: string;
let uninstall: () => void;
let guard: (pi: any) => void;
let readOutsideWrites: (file: string) => Array<{ tool: string; path: string; why: string }>;
let outsideWritesFile: (docs: string) => string;
let repoDocsDir: (cwd: string) => string;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "guard-outside-")));
	repo = join(dir, "repo");
	home = join(dir, "home");
	agentDir = join(home, ".pi", "agent");
	// Outside the system temp dir (which is trusted anyway) so the reason recorded is "secure"; never created.
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
	({ readOutsideWrites, outsideWritesFile } = await import("../lib/outside-writes.ts"));
	({ repoDocsDir } = await import("../lib/repo-docs.ts"));
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
		/** Runs tool_call and, when allowed, tool_result; returns the block reason or undefined. */
		async run(toolName: string, path: string, isError = false) {
			const toolCallId = String(++id);
			for (const h of handlers.tool_call ?? []) {
				const r = await h({ toolName, toolCallId, input: { path, content: "x" } }, ctx);
				if (r?.block) return String(r.reason);
			}
			for (const h of handlers.tool_result ?? []) await h({ toolName, toolCallId, input: { path }, content: [], isError }, ctx);
			return undefined;
		},
	};
}

const ledger = () => readOutsideWrites(outsideWritesFile(repoDocsDir(repo)));

describe("writes outside the project", () => {
	it("runs a parent write into the system temp dir without asking, and records it", async () => {
		const s = await session();
		const target = join("/tmp", `brigadev-guard-outside-${process.pid}`, "a.txt");
		assert.equal(await s.run("write", target), undefined);
		assert.deepEqual(s.asked, []);
		assert.ok(ledger().some((r) => r.path === canonicalPath(target) && r.why === "temp" && r.tool === "write"));
	});

	it("runs a parent write into a secure-yolo folder without asking, and records it", async () => {
		const s = await session();
		assert.equal(await s.run("edit", join(secure, "notes.md")), undefined);
		assert.deepEqual(s.asked, []);
		assert.ok(ledger().some((r) => r.path === join(secure, "notes.md") && r.why === "secure" && r.tool === "edit"));
	});

	it("still asks elsewhere, and records a granted write", async () => {
		const declined = await session({ answer: false });
		const elsewhere = "/brigadev-nonexistent-outside/x.txt";
		assert.match(String(await declined.run("write", elsewhere)), /declined/);
		assert.equal(declined.asked.length, 1);
		assert.ok(!ledger().some((r) => r.path === elsewhere));
		const granted = await session({ answer: true });
		assert.equal(await granted.run("write", elsewhere), undefined);
		assert.ok(ledger().some((r) => r.path === elsewhere && r.why === "granted"));
	});

	it("does not record a write that failed, nor reads or writes inside the project", async () => {
		const s = await session();
		const failed = join(secure, "failed.md");
		await s.run("write", failed, true);
		await s.run("read", join(secure, "read.md"));
		await s.run("write", join(repo, "inside.ts"));
		const paths = ledger().map((r) => r.path);
		assert.ok(!paths.includes(failed));
		assert.ok(!paths.includes(join(secure, "read.md")));
		assert.ok(!paths.includes(join(repo, "inside.ts")));
	});

	it("still asks for a protected path inside a secure-yolo folder or the temp dir", async () => {
		const hook = join(secure, "other", ".git", "hooks", "pre-commit");
		const gitConfig = join("/tmp", `brigadev-x-${process.pid}`, ".git", "config");
		for (const target of [hook, gitConfig]) {
			const declined = await session({ answer: false });
			assert.match(String(await declined.run("write", target)), /declined/);
			assert.deepEqual(declined.asked, ["brigadev: write outside project"]);
			assert.ok(!ledger().some((r) => r.path === target));
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
});
