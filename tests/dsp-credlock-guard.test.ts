// S10 credential lock, wiring: extensions/guard.ts (Pi's packages stubbed) locks every bash and bg_start call in DSP
// unless that exact call was approved in the remote dialog; normal and yolo are untouched.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { credLockDir, markCredLock, takeCredLock } from "../lib/dsp-credlock.ts";
import { readDspAudit } from "../lib/dsp-audit.ts";
import { DSP_REMOTE_TITLE } from "../lib/dsp-policy.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

describe("S10 guard wiring of the credential lock", () => {
	const saved = { ...process.env };
	let dir: string;
	let repo: string;
	let home: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;

	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const auditFile = () => join(home, ".brigadev", "repo", "audit", "dsp.jsonl");

	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-credlock-guard-")));
		repo = join(dir, "repo");
		home = join(dir, "home");
		mkdirSync(repo, { recursive: true });
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		process.env.HOME = home;
		process.env.BRIGADEV_HOME = join(home, ".brigadev");
		process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
		git("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		git("branch", "main");
		uninstall = installPiStubs();
		guard = (await import("../extensions/guard.ts")).default;
	});

	after(() => {
		uninstall();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	let nextId = 0;
	async function session(setup: { mode: "dsp" | "yolo" | "normal"; hasUI?: boolean; answer?: boolean; child?: boolean }) {
		const pi = createFakePi();
		pi.exec = async (command, args, options) => {
			try {
				return { stdout: execFileSync(command, args, { cwd: (options as { cwd: string }).cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0, killed: false };
			} catch (error: any) {
				return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: typeof error.status === "number" ? error.status : 1, killed: false };
			}
		};
		const ctx: any = createFakeCtx({ cwd: repo, hasUI: setup.hasUI ?? true });
		const asked: Array<{ title: string; body: string }> = [];
		ctx.ui.confirm = async (title: string, body: string) => (asked.push({ title, body }), setup.answer ?? true);
		ctx.ui.select = async () => undefined;
		const entries = setup.mode === "normal" ? [] : [{ type: "custom", customType: "brigadev-mode", data: { mode: setup.mode } }];
		ctx.sessionManager = { getBranch: () => entries };
		const before = process.env.BRIGADEV_CHILD;
		if (setup.child) process.env.BRIGADEV_CHILD = "1";
		guard(pi);
		if (setup.child) before === undefined ? delete process.env.BRIGADEV_CHILD : (process.env.BRIGADEV_CHILD = before);
		await pi.fire("session_start", {}, ctx);
		return {
			pi,
			ctx,
			asked,
			/** Runs the tool_call handlers; returns the (possibly rewritten) input, the block reason and the call id. */
			async call(toolName: string, input: Record<string, unknown>) {
				const event = { toolName, toolCallId: `credlock-${++nextId}`, input: { ...input } };
				let blocked: string | undefined;
				for (const handler of pi.handlers.get("tool_call") ?? []) {
					const result = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
					if (result?.block) blocked = result.reason;
				}
				return { input: event.input as Record<string, any>, blocked, id: event.toolCallId };
			},
			shutdown: () => pi.fire("session_shutdown", { reason: "quit" }, ctx),
		};
	}

	/** The model sees one short line, then the original command. */
	const PREFIX = /^\. '([^'\n]+)\/lock\.sh' \|\| exit 1\n/;
	const isLocked = (command: unknown, original: string) => typeof command === "string" && PREFIX.test(command) && command.endsWith(`\n${original}`) && command.split("\n").length === original.split("\n").length + 1;
	const lockDirOf = (command: string): string => PREFIX.exec(command)![1];

	describe("bash", () => {
		it("DSP: a local command runs locked, and the original command follows the prelude unchanged", async () => {
			const s = await session({ mode: "dsp" });
			const { input, blocked } = await s.call("bash", { command: "echo hi", timeout: 5 });
			assert.equal(blocked, undefined);
			assert.ok(isLocked(input.command, "echo hi"), String(input.command));
			assert.equal(input.timeout, 5, "other arguments are untouched");
			assert.doesNotMatch(input.command, /unset -v|export |GH_CONFIG_DIR|GIT_CONFIG_COUNT/, "the prelude itself stays out of the command text");
			assert.ok(String(input.command).split("\n")[0].length < 200, "one short line");
			await s.shutdown();
		});

		it("DSP: lock.sh (0600, in the private dir) holds the prelude the command sources", async () => {
			const s = await session({ mode: "dsp" });
			const lock = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			const script = join(lock, "lock.sh");
			assert.equal(statSync(script).mode & 0o777, 0o600);
			const text = readFileSync(script, "utf8");
			assert.match(text, /^unset -v [^\n]*\bSSH_AUTH_SOCK\b|^export /m);
			assert.match(text, /export [^\n]*GH_CONFIG_DIR='[^']+\/gh'/);
			assert.match(text, /\|\| exit 1\n$/);
			await s.shutdown();
		});

		it("DSP: lock.sh is rewritten before every locked call, so an edit between calls cannot weaken the next one", async () => {
			const s = await session({ mode: "dsp" });
			const lock = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			const script = join(lock, "lock.sh");
			const expected = readFileSync(script, "utf8");
			writeFileSync(script, "# weakened\n");
			await s.call("bash", { command: "ls" });
			assert.equal(readFileSync(script, "utf8"), expected);
			// A symlink put in its place is replaced, and the file it pointed at is not written.
			const victim = join(dir, "victim.txt");
			writeFileSync(victim, "untouched");
			rmSync(script);
			symlinkSync(victim, script);
			await s.call("bash", { command: "ls" });
			assert.equal(readFileSync(victim, "utf8"), "untouched");
			assert.equal(readFileSync(script, "utf8"), expected);
			assert.equal(statSync(script).mode & 0o777, 0o600);
			await s.shutdown();
		});

		it("DSP: lock.sh and the lock dir are created again when they are missing", async () => {
			const s = await session({ mode: "dsp" });
			const lock = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			rmSync(join(lock, "lock.sh"));
			assert.ok(isLocked((await s.call("bash", { command: "ls" })).input.command, "ls"));
			assert.ok(existsSync(join(lock, "lock.sh")));
			rmSync(lock, { recursive: true, force: true });
			const again = await s.call("bash", { command: "ls" });
			assert.equal(again.blocked, undefined);
			assert.ok(existsSync(join(lockDirOf(again.input.command), "lock.sh")));
			await s.shutdown();
		});

		it("DSP: when lock.sh cannot be written the call is blocked, not run unlocked", { skip: process.getuid?.() === 0 && "root ignores directory modes" }, async () => {
			const s = await session({ mode: "dsp" });
			const lock = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			chmodSync(lock, 0o500);
			try {
				const result = await s.call("bash", { command: "echo hi" });
				assert.match(String(result.blocked), /credential lock could not be set up/);
				assert.equal(result.input.command, "echo hi");
			} finally {
				chmodSync(lock, 0o700);
			}
			await s.shutdown();
		});

		it("DSP: the lock dir is private (0700), holds the files, and is removed at session shutdown", async () => {
			const s = await session({ mode: "dsp" });
			const { input } = await s.call("bash", { command: "ls" });
			const lock = lockDirOf(input.command);
			assert.equal(statSync(lock).mode & 0o777, 0o700);
			assert.ok(existsSync(join(lock, "gh")) && existsSync(join(lock, "askpass")) && existsSync(join(lock, "npmrc")) && existsSync(join(lock, "docker", "config.json")));
			assert.equal(credLockDir(), lock);
			await s.shutdown();
			assert.equal(existsSync(lock), false);
			assert.equal(credLockDir(), undefined);
		});

		it("DSP: the same session reuses one lock dir for every call", async () => {
			const s = await session({ mode: "dsp" });
			const a = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			const b = lockDirOf((await s.call("bash", { command: "pwd" })).input.command);
			assert.equal(a, b);
			await s.shutdown();
		});

		it("DSP: the approved remote call runs unlocked and the next call is locked again", async () => {
			const s = await session({ mode: "dsp", answer: true });
			const push = await s.call("bash", { command: "git push origin feat/x" });
			assert.equal(push.blocked, undefined);
			assert.equal(push.input.command, "git push origin feat/x");
			assert.deepEqual(s.asked.map((a) => a.title), [DSP_REMOTE_TITLE]);
			const next = await s.call("bash", { command: "echo after" });
			assert.ok(isLocked(next.input.command, "echo after"));
			const again = await s.call("bash", { command: "git push origin feat/x" });
			assert.equal(again.input.command, "git push origin feat/x", "approved again, per call");
			assert.equal(s.asked.length, 2, "an approval is never remembered");
			assert.ok(isLocked((await s.call("bash", { command: "echo last" })).input.command, "echo last"));
			await s.shutdown();
		});

		it("DSP: the remote dialog and the decision see the original command, never the prelude", async () => {
			const s = await session({ mode: "dsp", answer: true });
			await s.call("bash", { command: "gh pr merge 1 --squash" });
			assert.match(s.asked[0].body, /gh pr merge 1 --squash/);
			assert.doesNotMatch(s.asked[0].body, /unset -v|GH_CONFIG_DIR|GIT_CONFIG_COUNT/);
			const declined = await session({ mode: "dsp", answer: false });
			const result = await declined.call("bash", { command: "git push" });
			assert.match(String(result.blocked), /User declined/);
			assert.equal(result.input.command, "git push", "a blocked call is not rewritten");
			await s.shutdown();
			await declined.shutdown();
		});

		it("DSP: a declined or hard-denied call is left as the model wrote it", async () => {
			const s = await session({ mode: "dsp", answer: false });
			for (const command of ["git push", "rm -rf /", "sudo true"]) {
				const result = await s.call("bash", { command });
				assert.ok(result.blocked, command);
				assert.equal(result.input.command, command, command);
			}
			await s.shutdown();
		});

		it("DSP: a question that is not about a remote action (sudo) does not unlock", async () => {
			const s = await session({ mode: "dsp", answer: true });
			const { input, blocked } = await s.call("bash", { command: "sudo true" });
			assert.equal(blocked, undefined);
			assert.equal(s.asked.length, 1);
			assert.notEqual(s.asked[0].title, DSP_REMOTE_TITLE);
			assert.ok(isLocked(input.command, "sudo true"));
			await s.shutdown();
		});

		it("DSP without a UI: local commands run locked, remote ones are denied", async () => {
			const s = await session({ mode: "dsp", hasUI: false });
			assert.ok(isLocked((await s.call("bash", { command: "echo hi" })).input.command, "echo hi"));
			const push = await s.call("bash", { command: "git push" });
			assert.match(String(push.blocked), /remote action/);
			assert.equal(push.input.command, "git push");
			await s.shutdown();
		});

		it("DSP: the audit records the original command, not the prelude", async () => {
			const s = await session({ mode: "dsp" });
			const { input, blocked } = await s.call("bash", { command: "npm install left-pad" });
			assert.equal(blocked, undefined);
			assert.ok(isLocked(input.command, "npm install left-pad"));
			assert.equal(readDspAudit(auditFile()).at(-1)?.command, "npm install left-pad");
			await s.shutdown();
		});

		it("DSP: a failure to set the lock up blocks the command instead of running it unlocked", async () => {
			const s = await session({ mode: "dsp" });
			const tmp = process.env.TMPDIR;
			process.env.TMPDIR = join(dir, "does", "not", "exist");
			try {
				const result = await s.call("bash", { command: "echo hi" });
				assert.match(String(result.blocked), /credential lock could not be set up/);
				assert.equal(result.input.command, "echo hi");
			} finally {
				tmp === undefined ? delete process.env.TMPDIR : (process.env.TMPDIR = tmp);
			}
			await s.shutdown();
		});

		it("DSP: rebuilds the lock files when something removed them", async () => {
			const s = await session({ mode: "dsp" });
			const lock = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			rmSync(join(lock, "askpass"));
			await s.call("bash", { command: "ls" });
			assert.ok(existsSync(join(lock, "askpass")));
			await s.shutdown();
		});

		it("normal and yolo: no prelude, no lock dir, whatever the command", async () => {
			for (const mode of ["normal", "yolo"] as const) {
				const s = await session({ mode, answer: true });
				for (const command of ["echo hi", "git push origin feat/x", "npm install x"]) {
					const result = await s.call("bash", { command });
					assert.equal(result.input.command, command, `${mode}: ${command}`);
				}
				assert.equal(credLockDir(), undefined, mode);
				await s.shutdown();
			}
		});

		it("switching from DSP to normal stops locking; switching back resumes", async () => {
			const s = await session({ mode: "dsp", answer: true });
			assert.ok(isLocked((await s.call("bash", { command: "echo 1" })).input.command, "echo 1"));
			await s.pi.commands.get("brigadev:mode").handler("normal", s.ctx);
			assert.equal((await s.call("bash", { command: "echo 2" })).input.command, "echo 2");
			await s.pi.commands.get("brigadev:mode").handler("dsp", s.ctx);
			assert.ok(isLocked((await s.call("bash", { command: "echo 3" })).input.command, "echo 3"));
			await s.shutdown();
		});

		it("a subagent child is never locked (it never gets DSP either)", async () => {
			const s = await session({ mode: "dsp", child: true });
			const result = await s.call("bash", { command: "echo hi" });
			assert.equal(result.input.command, "echo hi");
			assert.equal(credLockDir(), undefined);
		});

		it("a command that is not a string is left alone", async () => {
			const s = await session({ mode: "dsp" });
			const result = await s.call("bash", { command: 42 });
			assert.equal(result.input.command, 42);
			await s.shutdown();
		});
	});

	describe("read of credential files", () => {
		const asks = async (mode: "dsp" | "yolo" | "normal", path: string, answer = true) => {
			const s = await session({ mode, answer });
			const result = await s.call("read", { path });
			await s.shutdown();
			return { asked: s.asked.length, blocked: result.blocked };
		};

		for (const rel of [".git-credentials", ".docker/config.json", ".config/gh/hosts.yml"]) {
			it(`DSP asks before a read of ~/${rel}`, async () => {
				const result = await asks("dsp", join(home, rel));
				assert.equal(result.asked, 1);
				assert.equal(result.blocked, undefined);
				assert.match(String((await asks("dsp", join(home, rel), false)).blocked), /declined access to sensitive file/);
			});

			it(`normal and yolo are unchanged for ~/${rel}`, async () => {
				for (const mode of ["normal", "yolo"] as const) {
					const withHome = await asks(mode, join(home, rel));
					const control = await asks(mode, join(repo, "src.ts"));
					assert.equal(withHome.asked, control.asked, mode);
				}
			});
		}

		it("DSP: an ordinary file is read without a question", async () => {
			assert.equal((await asks("dsp", join(repo, "src.ts"))).asked, 0);
		});

		it("DSP: the path is resolved before the check (a `~` form and a relative path)", async () => {
			assert.equal((await asks("dsp", "~/.git-credentials")).asked, 1);
			assert.equal((await asks("dsp", "../home/.git-credentials")).asked, 1);
		});
	});

	describe("/brigadev:doctor", () => {
		async function doctor(mode: "dsp" | "yolo" | "normal") {
			const pi = createFakePi();
			(await import("../extensions/doctor.ts")).default(pi as any);
			const ctx: any = createFakeCtx({ cwd: repo });
			ctx.sessionManager = { getBranch: () => (mode === "normal" ? [] : [{ type: "custom", customType: "brigadev-mode", data: { mode } }]) };
			await pi.commands.get("brigadev:doctor").handler("", ctx);
			return ctx.notifications.map((n: { message: string }) => n.message).join("\n");
		}

		it("shows the credential lock line in DSP and only there", async () => {
			assert.match(await doctor("dsp"), /DSP credential lock: on/);
			assert.doesNotMatch(await doctor("normal"), /credential lock/);
			assert.doesNotMatch(await doctor("yolo"), /credential lock/);
		});

		it("DSP: warns when ~/.netrc exists (git over https reads it, the lock does not cover it)", async () => {
			const netrc = join(home, ".netrc");
			assert.doesNotMatch(await doctor("dsp"), /netrc/);
			writeFileSync(netrc, "machine github.com login x password y\n");
			try {
				const text = await doctor("dsp");
				assert.match(text, /⚠ ~\/\.netrc can authenticate git over https; the DSP credential lock does not cover it/);
				assert.doesNotMatch(await doctor("normal"), /netrc/);
				assert.doesNotMatch(await doctor("yolo"), /netrc/);
			} finally {
				rmSync(netrc, { force: true });
			}
		});

		it("names the private dir once the guard has created it", async () => {
			const s = await session({ mode: "dsp" });
			const lock = lockDirOf((await s.call("bash", { command: "ls" })).input.command);
			assert.ok((await doctor("dsp")).includes(lock));
			await s.shutdown();
		});
	});

	describe("bg_start", () => {
		const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", GH_TOKEN: "t", SSH_AUTH_SOCK: "/s", HOME: "/h" };

		it("DSP: the process starts with the locked environment (taken once by the tool), the command text is untouched", async () => {
			const s = await session({ mode: "dsp" });
			const { input, id, blocked } = await s.call("bg_start", { command: "npm run dev", name: "dev" });
			assert.equal(blocked, undefined);
			assert.equal(input.command, "npm run dev");
			const apply = takeCredLock(id);
			assert.ok(apply, "marked for this call id");
			const env = apply(base);
			assert.equal(env.GH_TOKEN, undefined);
			assert.equal(env.SSH_AUTH_SOCK, undefined);
			assert.equal(env.PATH, "/usr/bin");
			assert.equal(env.GIT_CONFIG_COUNT, "2");
			assert.equal(takeCredLock(id), undefined, "a mark is used once");
			await s.shutdown();
		});

		it("DSP: the approved remote bg_start is unlocked and the next one is locked again", async () => {
			const s = await session({ mode: "dsp", answer: true });
			const push = await s.call("bg_start", { command: "git push origin feat/x" });
			assert.equal(takeCredLock(push.id), undefined);
			assert.deepEqual(s.asked.map((a) => a.title), [DSP_REMOTE_TITLE]);
			const next = await s.call("bg_start", { command: "sleep 1" });
			assert.ok(takeCredLock(next.id));
			await s.shutdown();
		});

		it("a mark left for a call id does not leak into a later call that reuses the id", async () => {
			const s = await session({ mode: "yolo" });
			markCredLock("reused", (env) => env);
			const event = { toolName: "bg_start", toolCallId: "reused", input: { command: "sleep 1" } };
			for (const handler of s.pi.handlers.get("tool_call") ?? []) await handler(event, s.ctx);
			assert.equal(takeCredLock("reused"), undefined);
			await s.shutdown();
		});

		it("end to end with extensions/background-terminals.ts: the process runs without the secrets when marked, with them when not", async () => {
			process.env.GH_TOKEN = "ghp_e2e";
			process.env.SSH_AUTH_SOCK = "/e2e.sock";
			const bg = createFakePi();
			(await import("../extensions/background-terminals.ts")).default(bg as any);
			const bgCtx: any = createFakeCtx({ cwd: repo, hasUI: false, idle: true });
			await bg.fire("session_start", {}, bgCtx);
			const probe = 'echo "[$GH_TOKEN][$SSH_AUTH_SOCK][$GIT_CONFIG_COUNT]"';
			const output = async (mode: "dsp" | "yolo") => {
				const s = await session({ mode });
				const { id, blocked } = await s.call("bg_start", { command: probe });
				assert.equal(blocked, undefined);
				const started = await bg.tool("bg_start").execute(id, { command: probe }, undefined, undefined, bgCtx);
				let text = "";
				for (let i = 0; i < 250; i++) {
					const status = await bg.tool("bg_status").execute("s", { id: started.details.id });
					text = status.content.map((c: { text: string }) => c.text).join("\n");
					if (status.details.state !== "running") break;
					await new Promise((resolve) => setTimeout(resolve, 20));
				}
				await s.shutdown();
				return text;
			};
			try {
				assert.match(await output("yolo"), /\[ghp_e2e\]\[\/e2e\.sock\]\[\]/);
				assert.match(await output("dsp"), /\[\]\[\]\[2\]/);
			} finally {
				await bg.fire("session_shutdown", {}, bgCtx);
				delete process.env.GH_TOKEN;
				delete process.env.SSH_AUTH_SOCK;
			}
		});

		it("normal and yolo: no mark", async () => {
			for (const mode of ["normal", "yolo"] as const) {
				const s = await session({ mode, answer: true });
				const result = await s.call("bg_start", { command: "npm run dev" });
				assert.equal(takeCredLock(result.id), undefined, mode);
				await s.shutdown();
			}
		});

		it("DSP: a bg_start the guard blocks is not marked", async () => {
			const s = await session({ mode: "dsp", answer: false });
			const result = await s.call("bg_start", { command: "git push" });
			assert.ok(result.blocked);
			assert.equal(takeCredLock(result.id), undefined);
			await s.shutdown();
		});
	});
});
