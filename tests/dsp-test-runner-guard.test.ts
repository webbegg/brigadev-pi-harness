// DSP test runner, wiring: extensions/guard.ts (Pi's packages stubbed) lets a test runner whose remote findings come only
// from the files it loads run without a dialog, credential-locked and audited as `test-runner-locked`; a push typed in the
// command line next to it still asks (and is blocked without a UI).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { takeCredLock } from "../lib/dsp-credlock.ts";
import { readDspAudit } from "../lib/dsp-audit.ts";
import { DSP_REMOTE_TITLE } from "../lib/dsp-policy.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

describe("guard wiring of the test-runner allow", () => {
	const saved = { ...process.env };
	let dir: string;
	let repo: string;
	let home: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;

	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const auditFile = () => join(home, ".brigadev", "repo", "audit", "dsp.jsonl");
	const auditOf = (command: string) => readDspAudit(auditFile()).filter((record) => record.command === command);

	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-runner-guard-")));
		repo = join(dir, "repo");
		home = join(dir, "home");
		mkdirSync(join(repo, "tests"), { recursive: true });
		mkdirSync(join(home, ".pi", "agent"), { recursive: true });
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		process.env.HOME = home;
		process.env.BRIGADEV_HOME = join(home, ".brigadev");
		process.env.PI_CODING_AGENT_DIR = join(home, ".pi", "agent");
		git("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "tests", "a.test.ts"), 'import { execSync } from "node:child_process";\nexecSync("git push origin main");\n');
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
	async function session(setup: { hasUI?: boolean; answer?: boolean }) {
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
		ctx.ui.confirm = async (title: string, body: string) => (asked.push({ title, body }), setup.answer ?? false);
		ctx.ui.select = async () => undefined;
		ctx.sessionManager = { getBranch: () => [{ type: "custom", customType: "brigadev-mode", data: { mode: "dsp" } }] };
		guard(pi);
		await pi.fire("session_start", {}, ctx);
		return {
			asked,
			async call(toolName: string, input: Record<string, unknown>) {
				const event = { toolName, toolCallId: `runner-${++nextId}`, input: { ...input } };
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

	/** The command is one inline prelude line (`[unset -v …&&]export GIT_SSH_COMMAND=… || exit 1`), then the original command. */
	const PREFIX = /^((?:unset -v [^&\n]+&&)?export GIT_SSH_COMMAND=[^\n]* \|\| exit 1)\n/;
	const isLocked = (command: unknown, original: string) => typeof command === "string" && PREFIX.test(command) && command.endsWith(`\n${original}`) && command.split("\n").length === original.split("\n").length + 1;

	const RUN = "node --test tests/a.test.ts";

	describe("bash", () => {
		for (const hasUI of [true, false]) {
			it(`${hasUI ? "with" : "without"} a UI: runs without a dialog, locked, with one audit record of kind test-runner-locked`, async () => {
				const s = await session({ hasUI });
				const before = auditOf(RUN).length;
				const { input, blocked } = await s.call("bash", { command: RUN, timeout: 30 });
				assert.equal(blocked, undefined);
				assert.deepEqual(s.asked, [], "no dialog");
				assert.ok(isLocked(input.command, RUN), String(input.command));
				assert.equal(input.timeout, 30, "other arguments are untouched");
				const records = auditOf(RUN);
				assert.equal(records.length - before, 1, "one audit record");
				assert.equal(records.at(-1)?.kind, "test-runner-locked");
				await s.shutdown();
			});
		}

		it("a push typed after the runner still asks; without a UI it is blocked", async () => {
			const command = `${RUN} && git push`;
			const quiet = await session({ hasUI: false });
			const denied = await quiet.call("bash", { command });
			assert.match(String(denied.blocked), /remote action/);
			assert.equal(denied.input.command, command, "not rewritten");
			await quiet.shutdown();

			const ui = await session({ hasUI: true, answer: false });
			const declined = await ui.call("bash", { command });
			assert.ok(declined.blocked);
			assert.equal(ui.asked.length, 1);
			assert.equal(ui.asked[0].title, DSP_REMOTE_TITLE);
			assert.equal(auditOf(command).length, 0, "nothing logged as locked");
			await ui.shutdown();
		});
	});

	describe("bg_start", () => {
		const base: NodeJS.ProcessEnv = { PATH: "/usr/bin", GH_TOKEN: "t", SSH_AUTH_SOCK: "/s", HOME: "/h" };

		it("runs without a dialog, the command is unchanged, the process starts locked, and it is audited", async () => {
			const s = await session({ hasUI: true });
			const before = auditOf(RUN).length;
			const { input, id, blocked } = await s.call("bg_start", { command: RUN, name: "tests" });
			assert.equal(blocked, undefined);
			assert.deepEqual(s.asked, []);
			assert.equal(input.command, RUN);
			const apply = takeCredLock(id);
			assert.ok(apply, "marked for this call id");
			const env = apply(base);
			assert.equal(env.GH_TOKEN, undefined);
			assert.equal(env.SSH_AUTH_SOCK, undefined);
			assert.equal(env.PATH, "/usr/bin");
			const records = auditOf(RUN);
			assert.equal(records.length - before, 1);
			assert.equal(records.at(-1)?.kind, "test-runner-locked");
			await s.shutdown();
		});

		it("without a UI the same call also runs", async () => {
			const s = await session({ hasUI: false });
			const { input, id, blocked } = await s.call("bg_start", { command: RUN });
			assert.equal(blocked, undefined);
			assert.equal(input.command, RUN);
			assert.ok(takeCredLock(id));
			await s.shutdown();
		});

		it("a push typed after the runner is blocked without a UI and is not marked", async () => {
			const command = `${RUN}; git push`;
			const s = await session({ hasUI: false });
			const result = await s.call("bg_start", { command });
			assert.match(String(result.blocked), /remote action/);
			assert.equal(takeCredLock(result.id), undefined);
			assert.equal(auditOf(command).length, 0);
			await s.shutdown();
		});
	});
});
