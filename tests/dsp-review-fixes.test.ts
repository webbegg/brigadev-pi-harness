// Pre-PR review corrections (R1-001, R3-001, R3-003, R3-004, R1-002, R2-006): subagents launched in DSP, discards in another
// repository, a failed backup on the confirm path, the prelude in rows and evidence, non-POSIX shells, audit redaction.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { childLaunch } from "../lib/child-launch.ts";
import { compactRow } from "../lib/compact-tools.ts";
import { appendDspAudit, dspAuditRecord } from "../lib/dsp-audit.ts";
import * as credlock from "../lib/dsp-credlock.ts";
import { credLockLine, DSP_LOCK_ENV, lockEnvironment, lockPlaces, lockPrelude, nonPosixShell, parentDspLock, setParentDspLock, stripLockPrelude } from "../lib/dsp-credlock.ts";
import { decideDspCommand, DSP_REMOTE_TITLE } from "../lib/dsp-policy.ts";
import { runRecordFromResult } from "../lib/evidence.ts";
import { fakeExec, realTmp } from "./dsp-fixtures.test.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const launchInput = { agent: { name: "w", writer: false }, route: {}, cwd: "/c", parentEnv: { PATH: "/bin", GH_TOKEN: "ghp_parent", OPENAI_API_KEY: "sk-provider" } as NodeJS.ProcessEnv };

describe("R1-001 the child launcher marks every subagent while the parent is in DSP", () => {
	it("no marker unless the parent is in DSP; the parent's own environment is not stripped", () => {
		setParentDspLock(false);
		assert.equal(DSP_LOCK_ENV, "BRIGADEV_DSP_LOCK");
		assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], undefined);
		setParentDspLock(true);
		try {
			const { env } = childLaunch(launchInput);
			assert.equal(env[DSP_LOCK_ENV], "1");
			assert.equal(env.OPENAI_API_KEY, "sk-provider", "the child still needs its provider keys");
			assert.equal(env.GH_TOKEN, "ghp_parent", "the child process env is not stripped; its bash calls are locked");
		} finally {
			setParentDspLock(false);
		}
		assert.equal(parentDspLock(), false);
		assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], undefined);
	});
});

describe("guard: DSP marks the launcher; a marked child locks every bash call", () => {
	const saved = { ...process.env };
	let dir: string;
	let repo: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;
	let agentDir: string;

	before(async () => {
		dir = realTmp("brigadev-review-fixes-");
		repo = join(dir, "repo");
		const home = join(dir, "home");
		agentDir = join(home, ".pi", "agent");
		mkdirSync(repo, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		Object.assign(process.env, { HOME: home, BRIGADEV_HOME: join(home, ".brigadev"), PI_CODING_AGENT_DIR: agentDir });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
		git("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		git("branch", "main");
		uninstall = installPiStubs();
		guard = (await import("../extensions/guard.ts")).default;
	});

	after(() => {
		setParentDspLock(false);
		uninstall();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	let nextId = 0;
	async function session(setup: { mode?: "dsp" | "yolo" | "normal"; child?: boolean; marker?: boolean; hasUI?: boolean; answers?: boolean[]; cwd?: string }) {
		const pi = createFakePi();
		pi.exec = async (command, args, options) => {
			try {
				return { stdout: execFileSync(command, args, { cwd: (options as { cwd: string }).cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0, killed: false };
			} catch (error: any) {
				return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: typeof error.status === "number" ? error.status : 1, killed: false };
			}
		};
		const ctx: any = createFakeCtx({ cwd: setup.cwd ?? repo, hasUI: setup.hasUI ?? true });
		const asked: Array<{ title: string; body: string }> = [];
		const answers = [...(setup.answers ?? [])];
		ctx.ui.confirm = async (title: string, body: string) => (asked.push({ title, body }), answers.length > 0 ? answers.shift() : false);
		ctx.ui.select = async () => undefined;
		const entries = setup.mode && setup.mode !== "normal" ? [{ type: "custom", customType: "brigadev-mode", data: { mode: setup.mode } }] : [];
		ctx.sessionManager = { getBranch: () => entries };
		pi.appendEntry = (type: string, data: unknown) => void entries.push({ type: "custom", customType: type, data } as any);
		const before = { child: process.env.BRIGADEV_CHILD, marker: process.env[DSP_LOCK_ENV] };
		if (setup.child) process.env.BRIGADEV_CHILD = "1";
		if (setup.marker) process.env[DSP_LOCK_ENV] = "1";
		guard(pi);
		before.child === undefined ? delete process.env.BRIGADEV_CHILD : (process.env.BRIGADEV_CHILD = before.child);
		before.marker === undefined ? delete process.env[DSP_LOCK_ENV] : (process.env[DSP_LOCK_ENV] = before.marker);
		await pi.fire("session_start", {}, ctx);
		return {
			pi,
			ctx,
			asked,
			async call(toolName: string, input: Record<string, unknown>) {
				const event = { toolName, toolCallId: `review-${++nextId}`, input: { ...input } };
				let blocked: string | undefined;
				for (const handler of pi.handlers.get("tool_call") ?? []) {
					const result = (await handler(event, ctx)) as { block?: boolean; reason?: string } | undefined;
					if (result?.block) blocked = result.reason;
				}
				return { input: event.input as Record<string, any>, blocked };
			},
			shutdown: () => pi.fire("session_shutdown", { reason: "quit" }, ctx),
		};
	}

	const PRELUDE_LINE = /^((?:unset -v [^&\n]+&&)?export GIT_SSH_COMMAND=[^\n]* \|\| exit 1)\n/;

	it("the marker is set only while the parent is in DSP (normal, yolo, switching, shutdown)", async () => {
		for (const mode of ["normal", "yolo"] as const) {
			const s = await session({ mode });
			assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], undefined, mode);
			await s.shutdown();
		}
		const s = await session({ mode: "dsp", answers: [true] });
		assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], "1");
		await s.pi.commands.get("brigadev:mode").handler("normal", s.ctx);
		assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], undefined);
		await s.pi.commands.get("brigadev:mode").handler("dsp", s.ctx);
		assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], "1");
		await s.shutdown();
		assert.equal(childLaunch(launchInput).env[DSP_LOCK_ENV], undefined);
	});

	it("a child session never switches the marker on", async () => {
		const s = await session({ mode: "dsp", child: true, marker: true });
		assert.equal(parentDspLock(), false);
		await s.shutdown();
	});

	it("a child that carries the marker runs every bash call behind the prelude, without a dialog", async () => {
		const s = await session({ child: true, marker: true });
		const { input, blocked } = await s.call("bash", { command: "echo hi", timeout: 3 });
		assert.equal(blocked, undefined);
		assert.match(String(input.command), PRELUDE_LINE);
		assert.ok(String(input.command).endsWith("\necho hi"));
		assert.equal(input.timeout, 3);
		assert.deepEqual(s.asked, []);
		const chained = await s.call("bash", { command: "ls && git status" });
		assert.match(String(chained.input.command), PRELUDE_LINE);
		assert.ok(String(chained.input.command).endsWith("\nls && git status"));
		await s.shutdown();
	});

	it("a child without the marker (parent in normal or yolo) is unchanged", async () => {
		const s = await session({ child: true });
		const { input } = await s.call("bash", { command: "echo hi" });
		assert.equal(input.command, "echo hi");
		await s.shutdown();
	});

	it("a marked child's bash really runs without the secrets while its own process keeps its env", async () => {
		const s = await session({ child: true, marker: true });
		Object.assign(process.env, { GH_TOKEN: "ghp_child", SSH_AUTH_SOCK: "/child.sock" });
		try {
			const { input } = await s.call("bash", { command: 'echo "[$GH_TOKEN][$SSH_AUTH_SOCK]"' });
			const out = execFileSync("bash", ["-c", String(input.command)], { cwd: repo, env: process.env, encoding: "utf8" });
			assert.equal(out.trim(), "[][]");
			assert.equal(process.env.GH_TOKEN, "ghp_child");
		} finally {
			delete process.env.GH_TOKEN;
			delete process.env.SSH_AUTH_SOCK;
		}
		await s.shutdown();
	});

	describe("R3-003 a confirm-path discard whose backup fails asks again, or is denied", () => {
		const COMMANDS = {
			confirm: "git branch -D nothing-here && rm -rf /opt/brigadev-nothing-here",
			remote: "git branch -D nothing-here && git push origin feat/x",
		};
		it("confirm: a second dialog names the failed backup; yes runs, no blocks", async () => {
			const yes = await session({ mode: "dsp", answers: [true, true] });
			assert.equal((await yes.call("bash", { command: COMMANDS.confirm })).blocked, undefined);
			assert.equal(yes.asked.length, 2, JSON.stringify(yes.asked));
			assert.match(yes.asked[1].body, /automatic backup failed \(.+\); run without a backup\?/);
			const no = await session({ mode: "dsp", answers: [true, false] });
			assert.match(String((await no.call("bash", { command: COMMANDS.confirm })).blocked), /backup/i);
			assert.equal(no.asked.length, 2);
		});

		it("remote: the remote dialog first, then the backup dialog; declining the second blocks", async () => {
			const yes = await session({ mode: "dsp", answers: [true, true] });
			assert.equal((await yes.call("bash", { command: COMMANDS.remote })).blocked, undefined);
			assert.equal(yes.asked[0].title, DSP_REMOTE_TITLE);
			assert.equal(yes.asked.length, 2);
			assert.match(yes.asked[1].body, /backup failed/);
			const no = await session({ mode: "dsp", answers: [true, false] });
			assert.match(String((await no.call("bash", { command: COMMANDS.remote })).blocked), /backup/i);
		});

		it("without a UI it is denied", async () => {
			for (const command of Object.values(COMMANDS)) {
				const s = await session({ mode: "dsp", hasUI: false });
				const { blocked } = await s.call("bash", { command });
				assert.ok(blocked, command);
			}
		});
	});

	describe("R3-004 a non-POSIX Pi shell refuses DSP", () => {
		const settings = (shellPath?: string) => writeFileSync(join(agentDir, "settings.json"), JSON.stringify(shellPath ? { shellPath } : {}));
		after(() => rmSync(join(agentDir, "settings.json"), { force: true }));

		for (const shell of ["/usr/bin/fish", "/opt/homebrew/bin/nu", "/usr/local/bin/pwsh", "elvish", "/usr/bin/xonsh"]) {
			it(`/brigadev:mode dsp refuses with shellPath ${shell}, and doctor's line says why`, async () => {
				settings(shell);
				const s = await session({ mode: "normal", answers: [true] });
				await s.pi.commands.get("brigadev:mode").handler("dsp", s.ctx);
				assert.deepEqual(s.asked, [], "no confirmation is offered");
				assert.ok(s.ctx.notifications.some((n: any) => /POSIX/.test(n.message) && n.type === "error"), JSON.stringify(s.ctx.notifications));
				assert.equal(parentDspLock(), false);
				assert.match(credLockLine(), new RegExp(`${shell.split("/").pop()}.*not a POSIX|not a POSIX.*${shell.split("/").pop()}`));
				assert.doesNotMatch(credLockLine(), /credential lock: on/);
				await s.shutdown();
			});
		}

		it("a saved DSP session in a non-POSIX shell starts in normal mode instead", async () => {
			settings("/usr/bin/fish");
			const s = await session({ mode: "dsp" });
			assert.equal(parentDspLock(), false);
			const { input } = await s.call("bash", { command: "echo hi" });
			assert.equal(input.command, "echo hi");
			await s.shutdown();
		});

		it("bash, zsh, sh or no setting still enter DSP", async () => {
			for (const shell of ["/bin/bash", "/bin/zsh", "sh", undefined]) {
				settings(shell);
				const s = await session({ mode: "normal", answers: [true] });
				await s.pi.commands.get("brigadev:mode").handler("dsp", s.ctx);
				assert.equal(s.asked.length, 1, String(shell));
				assert.equal(parentDspLock(), true, String(shell));
				await s.shutdown();
			}
		});
	});
});

describe("R3-004 nonPosixShell", () => {
	it("names fish, nu, pwsh, elvish, xonsh (by program name, any path, .exe); POSIX shells and nothing pass", () => {
		for (const shell of ["fish", "/usr/bin/fish", "nu", "/x/nu", "pwsh", "pwsh.exe", "elvish", "xonsh"]) assert.ok(nonPosixShell(shell), shell);
		for (const shell of ["bash", "/bin/zsh", "sh", "/usr/bin/dash", "ksh", undefined, ""]) assert.equal(nonPosixShell(shell), undefined, String(shell));
	});
});

describe("R3-001 a discard that acts on another repository is not backed up in the session's", () => {
	const project = realTmp("dsp-fix-project-");
	const home = realTmp("dsp-fix-home-");
	const temp = realTmp("dsp-fix-temp-");
	const decide = (command: string) => decideDspCommand({ command, cwd: project, projectRoot: project, home, tempRoots: [temp], exec: fakeExec({ branches: ["main", "x"] }) });
	const REASON = /the automatic backup can only protect the session's repository/;

	const forms = [
		"git -C ../other clean -fd",
		"git -C ../other restore .",
		"git -C ../other stash drop",
		"git -C ../other branch -D x",
		"git -C ../other reset --hard",
		"cd ../other && git clean -fd",
		"cd ../other; git branch -D x",
		"pushd ../other && git clean -fd",
		"cd sub && git reset --hard",
		"git --git-dir=../other/.git --work-tree=../other clean -fd",
		"git --git-dir ../other/.git restore .",
		"git --work-tree=../other checkout -- .",
		"GIT_DIR=../other/.git git clean -fd",
		"GIT_WORK_TREE=../other git clean -fd",
		"export GIT_DIR=../other/.git; git clean -fd",
		"env GIT_DIR=../other/.git git clean -fd",
		"env -C ../other git clean -fd",
		"sh -c 'cd ../other && git clean -fd'",
		"sh -c 'git -C ../other clean -fd'",
		"cd ../other && (git clean -fd)",
	];
	for (const command of forms) {
		it(`${command} -> asks, no backup plan`, async () => {
			const { decision } = await decide(command);
			// A reset or rebase there is also a history move to another branch or repository: that is the remote-style dialog, with the same reason.
			const plain = !/\b(reset|rebase)\b/.test(command);
			assert.equal(decision.action, plain ? "confirm" : "confirm-remote", JSON.stringify(decision));
			const reasons = decision.action === "confirm" ? decision.reason : decision.action === "confirm-remote" ? decision.also.join("; ") : "";
			assert.match(reasons, REASON);
			assert.equal((decision as { backup?: unknown }).backup, undefined);
		});
	}

	it("the in-repo forms stay allow-with-backup", async () => {
		for (const command of ["git clean -fd", "git restore .", "git stash drop", "git branch -D x", "git reset --hard", "git checkout -b y && git clean -fd", "ls && git clean -fd", "git -c core.pager=cat clean -fd"]) {
			assert.equal((await decide(command)).decision.action, "allow-with-backup", command);
		}
	});

	it("a move in an earlier part does not hide a later in-repo discard that is separate: the chain asks", async () => {
		const { decision } = await decide("git clean -fd && cd ../other && git clean -fd");
		assert.equal(decision.action, "confirm");
	});
});

describe("R3-004 the prelude is not shown in rows or stored as evidence", () => {
	const prelude = lockPrelude(lockEnvironment({ PATH: "/bin", GH_TOKEN: "x", SSH_AUTH_SOCK: "/s" }, lockPlaces()));
	const plain = lockPrelude(lockEnvironment({ PATH: "/bin" }, lockPlaces()));

	it("stripLockPrelude removes exactly a first line lockPrelude produced", () => {
		assert.match(prelude, /^unset -v /);
		for (const line of [prelude, plain]) {
			assert.equal(stripLockPrelude(`${line}\nnpm test`), "npm test");
			assert.equal(stripLockPrelude(`${line}\nnpm test\necho done`), "npm test\necho done");
			assert.equal(stripLockPrelude(`${line}\n`), "");
		}
	});

	it("anything else is returned as it came", () => {
		for (const command of ["npm test", "", `echo hi\n${prelude}\nnpm test`, ` ${prelude}\nnpm test`, prelude, "export GIT_SSH_COMMAND=x || exit 1\nnpm test", `${prelude.replace("export GIT_SSH_COMMAND", "export GIT_SSH_COMMAND2")}\nnpm test`, "unset -v A&&export B=1 || exit 1\nls"]) {
			assert.equal(stripLockPrelude(command), command);
		}
	});

	it("the compact bash row shows the command without the prelude", () => {
		const rows = compactRow({ tool: "bash", args: { command: `${prelude}\nnpm test` }, phase: "done", text: "ok" });
		const text = rows.map((row) => row.text).join("\n");
		assert.match(text, /npm test/);
		assert.doesNotMatch(text, /unset|GIT_SSH_COMMAND|exit 1/);
	});

	it("the evidence record stores and classifies the command without the prelude", () => {
		const record = runRecordFromResult(
			{ toolName: "bash", input: { command: `${prelude}\nnpm test` }, content: [{ type: "text", text: "ok" }], structuredContent: { exit_code: 0, output: "ok" } },
			{ ts: "2026-11-16T10:00:00.000Z", branch: "feat/x", tree: "a".repeat(40), cwd: "/repo", agent: "parent" },
		);
		assert.equal(record?.command, "npm test");
		assert.equal(record?.outcome, "pass");
	});
});

describe("R1-002 the DSP audit redacts secrets and keeps its directory private", () => {
	const record = (command: string) => dspAuditRecord({ ts: "2026-11-16T10:00:00.000Z", branch: "feat/x", command, kind: "dependency", backups: [] }).command;

	it("redacts header values, bearer tokens, URL credentials, flags, npmrc auth and locked assignments", () => {
		const secrets: Array<[string, string]> = [
			[`curl -H "Authorization: Bearer abc123SECRET" https://api.example.com`, "abc123SECRET"],
			[`curl -H 'Authorization: token ghp_abcdefghijklmnopqrstuvwx' https://x`, "ghp_abcdefghijklmnopqrstuvwx"],
			[`curl -H "Authorization: Basic dXNlcjpwYXNz" https://x`, "dXNlcjpwYXNz"],
			[`curl -H "PRIVATE-TOKEN: glpat-s3cr3tvalue" https://x`, "s3cr3tvalue"],
			[`curl -H "X-Api-Token: tok_value_123" https://x`, "tok_value_123"],
			["echo Bearer eyJhbGciOi.payload.sig", "eyJhbGciOi"],
			["git clone https://user:hunter2@github.com/a/b.git", "hunter2"],
			["npm install --token=npm_secretvalue12345", "npm_secretvalue12345"],
			["tool --password=p4ssw0rd --other", "p4ssw0rd"],
			["tool --password 'two words secret'", "two words secret"],
			["npm config set //registry.npmjs.org/:_authToken=npm_zzz999", "npm_zzz999"],
			["GH_TOKEN=ghp_value1234 gh api /user", "ghp_value1234"],
			['export NPM_TOKEN="quoted secret" && npm publish', "quoted secret"],
			["AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI make deploy", "wJalrXUtnFEMI"],
		];
		for (const [command, secret] of secrets) {
			const stored = record(command);
			assert.ok(!stored.includes(secret), `${command} -> ${stored}`);
			assert.match(stored, /\[redacted\]/, stored);
		}
	});

	it("keeps what is not secret", () => {
		for (const command of ["npm install left-pad", "git clone https://github.com/a/b.git", "curl -H 'Accept: application/json' https://x", "FOO=bar make", "git commit -m 'fix token parsing'", "TOKENIZERS_PARALLELISM=false pytest", "ssh://git@host/x"]) {
			assert.equal(record(command), command);
		}
	});

	it("the redaction happens before the preview is clipped", () => {
		const stored = record(`${"x".repeat(990)} --token=abcdefghijklmnop`);
		assert.ok(!stored.includes("abcdefghij"));
	});

	it("creates the audit directory with mode 0700", () => {
		const root = realTmp("dsp-audit-mode-");
		try {
			const file = join(root, "repo-docs", "audit", "dsp.jsonl");
			appendDspAudit(file, dspAuditRecord({ ts: "t", branch: null, command: "ls", kind: "x", backups: [] }));
			assert.equal(statSync(join(root, "repo-docs", "audit")).mode & 0o777, 0o700);
			assert.equal(statSync(file).mode & 0o777, 0o600);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("R2-006 the dead lock-dir export is gone", () => {
	it("dsp-credlock no longer exports credLockDir", () => {
		assert.equal("credLockDir" in credlock, false);
	});
});

