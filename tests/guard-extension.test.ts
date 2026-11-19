// Drives extensions/guard.ts: the PR risk gate (S9) on `gh pr create`, in normal and yolo mode, against real temp git repositories.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { appendEvidence, evidenceFile, type EvidenceRecord } from "../lib/evidence.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, agentDir: string;
let uninstall: () => void;
let guard: (pi: any) => void;
let counter = 0;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "guard-extension-")));
	agentDir = join(dir, "agent");
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

const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, stdio: "ignore" });

/** A repository on `feat/x`, one commit ahead of `main`, with `changed` files committed on the branch. */
function repo(changed: string[], branch = "feat/x"): { cwd: string; docs: string } {
	const cwd = join(dir, `repo${++counter}`);
	mkdirSync(cwd, { recursive: true });
	git(cwd, "init", "-q", "-b", "main");
	writeFileSync(join(cwd, "README.md"), "x\n");
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", "init");
	git(cwd, "checkout", "-q", "-b", branch);
	for (const path of changed) {
		mkdirSync(dirname(join(cwd, path)), { recursive: true });
		writeFileSync(join(cwd, path), "changed\n");
	}
	git(cwd, "add", "-A");
	git(cwd, "commit", "-q", "-m", "work");
	return { cwd, docs: join(process.env.BRIGADEV_HOME!, `repo${counter}`) };
}

const record = (extra: object): EvidenceRecord => ({ v: 1, ts: new Date().toISOString(), branch: "feat/x", ...extra }) as EvidenceRecord;

async function session(cwd: string, options: { mode?: "yolo"; ui?: boolean; answer?: boolean } = {}) {
	const handlers: Record<string, Function[]> = {};
	const pi: any = {
		on: (e: string, h: Function) => (handlers[e] ??= []).push(h),
		registerCommand: () => {},
		registerShortcut: () => {},
		appendEntry: () => {},
		exec: (command: string, args: string[], options: { cwd?: string }) =>
			new Promise((resolve) => execFile(command, args, { cwd: options?.cwd }, (error, stdout, stderr) => resolve({ stdout, stderr, code: error ? ((error as any).code ?? 1) : 0 }))),
	};
	guard(pi);
	const dialogs: Array<{ title: string; body: string }> = [];
	const ctx: any = {
		cwd,
		hasUI: options.ui !== false,
		sessionManager: { getBranch: () => (options.mode ? [{ type: "custom", customType: "brigadev-mode", data: { mode: options.mode } }] : []) },
		ui: { confirm: async (title: string, body: string) => (dialogs.push({ title, body }), options.answer ?? false), notify: () => {}, setStatus: () => {}, select: async () => undefined },
	};
	for (const h of handlers.session_start ?? []) await h({}, ctx);
	return {
		dialogs,
		async bash(command: string, toolName = "bash") {
			for (const h of handlers.tool_call ?? []) {
				const input = toolName === "bg_start" ? { command, cwd } : { command };
				const r = await h({ toolName, toolCallId: String(++counter), input }, ctx);
				if (r?.block) return String(r.reason);
			}
			return undefined;
		},
	};
}

const PR = "gh pr create --fill";

describe("guard: PR risk gate", () => {
	it("yolo: a T2 branch without a verify asks, and a decline blocks with what to do", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd, { mode: "yolo" });
		const reason = await s.bash(PR);
		assert.equal(s.dialogs.length, 1);
		assert.match(s.dialogs[0].body, /T2 branch \(security: lib\/guard-rules\.ts\) has no brigadev-verify run/);
		assert.match(String(reason), /brigadev-verify/);
		assert.match(String(reason), /Risk: security/);
		assert.match(String(reason), /T2 branch \(security: lib\/guard-rules\.ts\) has no brigadev-verify run/);
	});

	it("yolo: the user accepting lets the PR run", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd, { mode: "yolo", answer: true });
		assert.equal(await s.bash(PR), undefined);
		assert.equal(s.dialogs.length, 1);
	});

	it("normal: one dialog holds the PR confirmation and the reason", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd, { answer: true });
		assert.equal(await s.bash(PR), undefined);
		assert.equal(s.dialogs.length, 1);
		assert.match(s.dialogs[0].title, /gh pr create/);
		assert.match(s.dialogs[0].body, /gh pr create --fill/);
		assert.match(s.dialogs[0].body, /Run it\?/);
		assert.match(s.dialogs[0].body, /has no brigadev-verify run/);
	});

	it("normal: declining the one dialog blocks and tells the model what to do", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd);
		const reason = String(await s.bash(PR));
		assert.equal(s.dialogs.length, 1);
		assert.match(reason, /declined/i);
		assert.match(reason, /brigadev-verify/);
	});

	it("no UI: a T2 branch without a verify blocks, in yolo and normal", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		for (const mode of ["yolo", undefined] as const) {
			const s = await session(cwd, { mode, ui: false });
			assert.match(String(await s.bash(PR)), /no brigadev-verify run/);
			assert.equal(s.dialogs.length, 0);
		}
	});

	it("T0 in yolo runs with no dialog", async () => {
		const { cwd } = repo(["tests/a.test.ts"]);
		const s = await session(cwd, { mode: "yolo" });
		assert.equal(await s.bash(PR), undefined);
		assert.deepEqual(s.dialogs, []);
	});

	it("yolo: a T2 branch with a clean verify runs with no dialog", async () => {
		const { cwd, docs } = repo(["lib/guard-rules.ts"]);
		appendEvidence(evidenceFile(docs, "feat/x"), record({ type: "verify", scope: "branch", categories: ["security"], blockers: [], outcome: "clean" }));
		const s = await session(cwd, { mode: "yolo" });
		assert.equal(await s.bash(PR), undefined);
		assert.deepEqual(s.dialogs, []);
	});

	it("yolo: verify blockers without a repro test ask; with fail→pass after the verify they pass", async () => {
		const { cwd, docs } = repo(["lib/guard-rules.ts"]);
		const file = evidenceFile(docs, "feat/x");
		const t = (n: number) => new Date(Date.now() + n * 1000).toISOString();
		appendEvidence(file, record({ type: "verify", ts: t(0), scope: "branch", categories: [], blockers: ["B1"], outcome: "blockers" }));
		const asked = await session(cwd, { mode: "yolo" });
		await asked.bash(PR);
		assert.match(asked.dialogs[0].body, /verify blockers B1 have no repro test RED→GREEN after the verify/);
		const run = (n: number, outcome: string) => record({ type: "run", ts: t(n), kind: "test", outcome, cwd, agent: "parent", command: "npm test", tail: "" });
		appendEvidence(file, run(1, "fail"));
		appendEvidence(file, run(2, "pass"));
		const resolved = await session(cwd, { mode: "yolo" });
		assert.equal(await resolved.bash(PR), undefined);
		assert.deepEqual(resolved.dialogs, []);
	});

	it("T1 without a ledger: no dialog of its own in yolo; the note rides the normal dialog", async () => {
		const { cwd } = repo(["src/a.ts"]);
		const yolo = await session(cwd, { mode: "yolo" });
		assert.equal(await yolo.bash(PR), undefined);
		assert.deepEqual(yolo.dialogs, []);
		const normal = await session(cwd, { answer: true });
		assert.equal(await normal.bash(PR), undefined);
		assert.equal(normal.dialogs.length, 1);
		assert.match(normal.dialogs[0].body, /no review ledger for this branch/);
	});

	it("bg_start gh pr create is gated like bash", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd, { mode: "yolo" });
		assert.match(String(await s.bash(PR, "bg_start")), /brigadev-verify/);
		assert.equal(s.dialogs.length, 1);
	});

	it("a command that opens no PR is never gated", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd, { mode: "yolo" });
		assert.equal(await s.bash("gh pr view"), undefined);
		assert.equal(await s.bash("git push -u origin feat/x"), undefined);
		assert.deepEqual(s.dialogs, []);
	});

	it("fails open outside a git repository", async () => {
		const plain = join(dir, "plain");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { mode: "yolo" });
		assert.equal(await s.bash(PR), undefined);
		assert.deepEqual(s.dialogs, []);
	});
});
