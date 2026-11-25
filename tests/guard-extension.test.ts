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
const headTree = (cwd: string) => execFileSync("git", ["rev-parse", "HEAD^{tree}"], { cwd, encoding: "utf8" }).trim();
/** A passing test run recorded on the committed HEAD, as `check` records one on a clean tree. */
const tested = (cwd: string, docs: string, extra: object = {}) =>
	appendEvidence(evidenceFile(docs, "feat/x"), record({ type: "run", kind: "test", outcome: "pass", tree: headTree(cwd), root: cwd, cwd, agent: "parent", command: "npm test", tail: "", ...extra }));

async function session(cwd: string, options: { mode?: "yolo"; ui?: boolean; answer?: boolean } = {}) {
	const handlers: Record<string, Function[]> = {};
	const commands: string[] = [];
	const pi: any = {
		on: (e: string, h: Function) => (handlers[e] ??= []).push(h),
		registerCommand: (name: string) => commands.push(name),
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
		commands,
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
		const { cwd, docs } = repo(["tests/a.test.ts"]);
		tested(cwd, docs);
		const s = await session(cwd, { mode: "yolo" });
		assert.equal(await s.bash(PR), undefined);
		assert.deepEqual(s.dialogs, []);
	});

	it("yolo: a T2 branch with a clean verify runs with no dialog", async () => {
		const { cwd, docs } = repo(["lib/guard-rules.ts"]);
		appendEvidence(evidenceFile(docs, "feat/x"), record({ type: "verify", scope: "branch", categories: ["security"], blockers: [], outcome: "clean" }));
		tested(cwd, docs);
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
		appendEvidence(file, { ...run(2, "pass"), tree: headTree(cwd) } as EvidenceRecord);
		const resolved = await session(cwd, { mode: "yolo" });
		assert.equal(await resolved.bash(PR), undefined);
		assert.deepEqual(resolved.dialogs, []);
	});

	it("T1 without a ledger: no dialog of its own in yolo; the note rides the normal dialog", async () => {
		const { cwd, docs } = repo(["src/a.ts"]);
		tested(cwd, docs);
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

	it("W4: a gh pr create whose directory cannot be resolved asks in every mode, and blocks without a UI", async () => {
		const { cwd } = repo(["tests/a.test.ts"]);
		const commands = ["(cd . && gh pr create --fill)", "cd x; gh pr create --fill", 'cd "$PWD" && gh pr create --fill', "bash -c 'gh pr create --fill'", "eval 'gh pr create --fill'"];
		for (const command of commands) {
			const yolo = await session(cwd, { mode: "yolo" });
			assert.match(String(await yolo.bash(command)), /could not resolve the directory of gh pr create/, `yolo declined: ${command}`);
			assert.equal(yolo.dialogs.length, 1, command);
			assert.match(yolo.dialogs[0].body, /PR risk gate could not resolve the directory of gh pr create/, command);
			const accepted = await session(cwd, { mode: "yolo", answer: true });
			assert.equal(await accepted.bash(command), undefined, `yolo accepted: ${command}`);
			const normal = await session(cwd, { answer: true });
			assert.equal(await normal.bash(command), undefined, `normal accepted: ${command}`);
			assert.equal(normal.dialogs.length, 1, `normal: one dialog: ${command}`);
			assert.match(normal.dialogs[0].body, /could not resolve the directory of gh pr create/);
			assert.match(normal.dialogs[0].body, /Run it\?/);
			for (const mode of ["yolo", undefined] as const) {
				const blind = await session(cwd, { mode, ui: false });
				assert.match(String(await blind.bash(command)), /could not resolve the directory of gh pr create/, `no UI: ${command}`);
			}
		}
	});

	it("W3: no resolvable base branch asks with `risk tier unknown: no base branch found`, instead of skipping", async () => {
		const cwd = join(dir, `repo${++counter}`);
		mkdirSync(join(cwd, "lib"), { recursive: true });
		git(cwd, "init", "-q", "-b", "weird");
		writeFileSync(join(cwd, "README.md"), "x\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", "init");
		git(cwd, "checkout", "-q", "-b", "feat/x");
		writeFileSync(join(cwd, "lib/guard-rules.ts"), "x\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", "guard");
		const s = await session(cwd, { mode: "yolo" });
		const reason = await s.bash(PR);
		assert.equal(s.dialogs.length, 1);
		assert.match(s.dialogs[0].body, /risk tier unknown: no base branch found/);
		assert.match(String(reason), /base branch/);
		const blind = await session(cwd, { mode: "yolo", ui: false });
		assert.match(String(await blind.bash(PR)), /risk tier unknown: no base branch found/);
	});

	it("a committed T2 branch off a develop or trunk base is gated by the fallback base", async () => {
		const cwd = join(dir, `repo${++counter}`);
		mkdirSync(join(cwd, "lib"), { recursive: true });
		git(cwd, "init", "-q", "-b", "trunk");
		writeFileSync(join(cwd, "README.md"), "x\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", "init");
		git(cwd, "checkout", "-q", "-b", "feat/x");
		writeFileSync(join(cwd, "lib/guard-rules.ts"), "x\n");
		git(cwd, "add", "-A");
		git(cwd, "commit", "-q", "-m", "guard");
		const s = await session(cwd, { mode: "yolo" });
		await s.bash(PR);
		assert.match(s.dialogs[0].body, /T2 branch \(security: lib\/guard-rules\.ts\)/);
	});

	describe("a passing test on the committed HEAD (the evidence check, moved here from git commit)", () => {
		it("yolo: a branch that commits source without one asks, naming it; a decline blocks with what to do", async () => {
			const { cwd } = repo(["src/a.ts"]);
			const s = await session(cwd, { mode: "yolo" });
			const reason = String(await s.bash(PR));
			assert.equal(s.dialogs.length, 1);
			assert.match(s.dialogs[0].body, /no passing test recorded for the committed HEAD \(no test ran on it\)/);
			assert.match(reason, /run the tests with `check` on the clean working tree/);
		});

		it("a pass recorded on HEAD's tree lets it run; a pass on an earlier tree does not", async () => {
			const { cwd, docs } = repo(["src/a.ts"]);
			tested(cwd, docs);
			writeFileSync(join(cwd, "src/a.ts"), "edited after the run\n");
			git(cwd, "commit", "-qam", "later");
			const stale = await session(cwd, { mode: "yolo" });
			assert.match(String(await stale.bash(PR)), /no passing test recorded for the committed HEAD/);
			tested(cwd, docs);
			const fresh = await session(cwd, { mode: "yolo" });
			assert.equal(await fresh.bash(PR), undefined);
			assert.deepEqual(fresh.dialogs, []);
		});

		it("uncommitted edits do not matter: HEAD is what the PR opens", async () => {
			const { cwd, docs } = repo(["src/a.ts"]);
			tested(cwd, docs);
			writeFileSync(join(cwd, "src/a.ts"), "uncommitted\n");
			const s = await session(cwd, { mode: "yolo" });
			assert.equal(await s.bash(PR), undefined);
		});

		it("a branch that commits only docs needs no test", async () => {
			const { cwd } = repo(["docs/guide.md"]);
			const s = await session(cwd, { mode: "yolo" });
			assert.equal(await s.bash(PR), undefined);
			assert.deepEqual(s.dialogs, []);
		});

		it("with a detected suite, a focused run does not vouch for HEAD; the full suite does", async () => {
			const { cwd, docs } = repo(["src/a.ts", "package.json"]);
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
			git(cwd, "commit", "-qam", "suite");
			tested(cwd, docs, { command: "npm test -- tests/a.test.ts" });
			const focused = await session(cwd, { mode: "yolo" });
			assert.match(String(await focused.bash(PR)), /only other test commands passed on it; the full suite is `npm test`/);
			tested(cwd, docs);
			assert.equal(await (await session(cwd, { mode: "yolo" })).bash(PR), undefined);
		});

		it("an unreadable evidence log asks instead of passing", async () => {
			const { cwd, docs } = repo(["src/a.ts"]);
			mkdirSync(evidenceFile(docs, "feat/x"), { recursive: true }); // reading it as a file throws EISDIR
			const s = await session(cwd, { mode: "yolo", ui: false });
			assert.match(String(await s.bash(PR)), /PR gate could not read the branch facts/);
		});

		it("a git commit is never gated on evidence, and there is no force-commit command", async () => {
			const { cwd } = repo(["src/a.ts"]);
			writeFileSync(join(cwd, "src/a.ts"), "untested\n");
			const s = await session(cwd, { mode: "yolo" });
			assert.equal(await s.bash("git commit -am untested"), undefined);
			assert.deepEqual(s.dialogs, []);
			assert.equal(s.commands.includes("brigadev:force-commit"), false);
		});

		it("no UI: blocks, in yolo and normal", async () => {
			const { cwd } = repo(["src/a.ts"]);
			for (const mode of ["yolo", undefined] as const) {
				const s = await session(cwd, { mode, ui: false });
				assert.match(String(await s.bash(PR)), /no passing test recorded for the committed HEAD/);
			}
		});

	});

	it("fails open outside a git repository", async () => {
		const plain = join(dir, "plain");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { mode: "yolo" });
		assert.equal(await s.bash(PR), undefined);
		assert.deepEqual(s.dialogs, []);
	});
});
