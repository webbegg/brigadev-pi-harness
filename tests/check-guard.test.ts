// R1-001: the guard decides a `check` call exactly like a bash call of the command that will run, and `check` itself refuses
// delivery, destructive, and commit commands in every mode (a test tool never delivers).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runCheck } from "../lib/check.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, agentDir: string;
let uninstall: () => void;
let guard: (pi: any) => void;

const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "check-guard-")));
	repo = join(dir, "repo");
	agentDir = join(dir, "home", ".pi", "agent");
	mkdirSync(repo, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
	process.env.BRIGADEV_HOME = join(dir, "home", ".brigadev");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	git("init", "-q", "-b", "main");
	writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
	git("add", "-A");
	git("commit", "-qm", "init");
	uninstall = installPiStubs();
	guard = (await import("../extensions/guard.ts")).default;
});
after(() => {
	uninstall();
	for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

async function session(options: { child?: boolean; yolo?: boolean } = {}) {
	const handlers: Record<string, Function[]> = {};
	const commands: Record<string, { handler: Function }> = {};
	const pi: any = {
		on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
		registerCommand: (name: string, command: { handler: Function }) => (commands[name] = command),
		registerShortcut: () => {},
		appendEntry: () => {},
		exec: async (command: string, args: string[], opts: { cwd: string }) => {
			try {
				return { stdout: execFileSync(command, args, { cwd: opts.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 };
			} catch (error: any) {
				return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
			}
		},
	};
	const previous = process.env.BRIGADEV_CHILD;
	if (options.child) process.env.BRIGADEV_CHILD = "1";
	guard(pi);
	if (options.child) previous === undefined ? delete process.env.BRIGADEV_CHILD : (process.env.BRIGADEV_CHILD = previous);
	const asked: string[] = [];
	const ctx: any = {
		cwd: repo,
		hasUI: true,
		sessionManager: { getBranch: () => [] },
		ui: { confirm: async (title: string) => (asked.push(title), false), notify: () => {}, setStatus: () => {}, select: async () => undefined },
	};
	for (const handler of handlers.session_start ?? []) await handler({}, ctx);
	if (options.yolo) await commands["brigadev:mode"].handler("yolo", ctx);
	let id = 0;
	const call = async (toolName: string, input: Record<string, unknown>) => {
		for (const handler of handlers.tool_call ?? []) {
			const result = await handler({ toolName, toolCallId: String(++id), input }, ctx);
			if (result?.block) return String(result.reason);
		}
		return undefined;
	};
	return { asked, check: (input: Record<string, unknown>) => call("check", input), bash: (command: string) => call("bash", { command }) };
}

describe("the guard decides a check call like bash", () => {
	it("keeps a plain test command free of dialogs", async () => {
		const s = await session();
		assert.equal(await s.check({ command: "node --test" }), undefined);
		assert.equal(await s.check({ command: "node --test", focus: "tests/a.test.ts" }), undefined);
		assert.deepEqual(s.asked, []);
	});

	it("does not run commit, push, or removal commands through check in NORMAL", async () => {
		const s = await session();
		for (const command of ["git commit -am x", "git push", "git push origin main", "rm -rf build", "cd /tmp && git commit -am x"]) {
			assert.match(String(await s.check({ command })), /check runs tests; use bash|Blocked by brigadev|User declined/, command);
		}
	});

	it("asks the sensitive-path question for a secret read, like a read of that path", async () => {
		const s = await session();
		assert.match(String(await s.check({ command: "cat ~/.ssh/id_rsa" })), /User declined access to sensitive file/);
		assert.ok(s.asked.some((title) => /sensitive file/.test(title)));
		const withFocus = await session();
		assert.match(String(await withFocus.check({ command: "node --test", focus: ".env" })), /User declined access to sensitive file/);
	});

	it("blocks a write to the evidence log", async () => {
		const s = await session();
		const log = join(repoDocsDir(repo), "evidence", "main.jsonl");
		assert.match(String(await s.check({ command: `echo '{}' >> ${log}` })), /evidence log is written only by the recorder/);
		assert.match(String(await s.bash(`echo '{}' >> ${log}`)), /evidence log is written only by the recorder/);
	});

	it("judges the configured command when `command` is omitted", async () => {
		writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify({ check: { test: "git push" } }));
		try {
			const s = await session();
			assert.match(String(await s.check({})), /check runs tests; use bash|User declined/);
		} finally {
			rmSync(join(agentDir, "brigadev.json"), { force: true });
		}
	});

	it("blocks the same commands in a child, and in YOLO", async () => {
		const child = await session({ child: true });
		for (const command of ["git commit -am x", "git push", "cat ~/.ssh/id_rsa", "rm -rf build"]) {
			assert.match(String(await child.check({ command })), /./, command);
		}
		assert.match(String(await child.bash("git push")), /subagents may not run this/);
		const yolo = await session({ yolo: true });
		for (const command of ["git commit -am x", "git push", "rm -rf build"]) {
			assert.match(String(await yolo.check({ command })), /check runs tests; use bash/, command);
		}
		assert.equal(await yolo.check({ command: "node --test" }), undefined);
	});

	it("check refuses delivery, destructive, and commit commands by itself", async () => {
		for (const command of ["git commit -am x", "git push", "rm -rf build", "npm test && git push", "gh pr create"]) {
			const result = await runCheck({ command }, { cwd: repo, exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }), agent: "parent" });
			assert.equal(result.isError, true, command);
			assert.match(result.text, /check runs tests; use bash/, command);
		}
	});
});
