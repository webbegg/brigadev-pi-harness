// Drives extensions/guard.ts: the PR risk gate (S9) on `gh pr create`, in normal and yolo mode, against real temp git repositories.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { appendEvidence, evidenceFile, type EvidenceRecord } from "../lib/evidence.ts";
import { SESSION_LABEL } from "../lib/permission-dialog.ts";
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

/**
 * A guard session. `answer`: the user's answer to every permission question ("session": yes, and don't ask again this session).
 * Pi's confirm, or Pi's select when the question offers the session answer (an RPC client), record each question in `dialogs`;
 * `tui: true` answers through the permission card instead (Pi's `custom`), recording the card in `cards`.
 */
async function session(cwd: string, options: { mode?: "yolo"; ui?: boolean; answer?: boolean | "session"; tui?: boolean } = {}) {
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
	const dialogs: Array<{ title: string; body: string; options?: string[] }> = [];
	const cards: string[][] = [];
	const notes: string[] = [];
	const answer = options.answer ?? false;
	const ctx: any = {
		cwd,
		hasUI: options.ui !== false,
		...(options.tui ? { mode: "tui" } : {}),
		sessionManager: { getBranch: () => (options.mode ? [{ type: "custom", customType: "brigadev-mode", data: { mode: options.mode } }] : []) },
		ui: {
			confirm: async (title: string, body: string) => (dialogs.push({ title, body }), answer !== false),
			notify: (message: string) => notes.push(message),
			setStatus: () => {},
			select: async (title: string, choices: string[]) => {
				if (!choices.includes("Yes")) return undefined;
				const cut = title.indexOf("\n");
				dialogs.push({ title: title.slice(0, cut), body: title.slice(cut + 1), options: choices });
				return answer === "session" ? choices[1] : answer ? "Yes" : "No";
			},
			...(options.tui
				? {
						custom: async (factory: Function) => {
							let result: unknown;
							const theme = { fg: (_tone: string, text: string) => text, bold: (text: string) => text };
							const component = factory({ requestRender: () => {} }, theme, {}, (value: unknown) => (result = value));
							cards.push(component.render(80));
							component.handleInput(answer === "session" ? "s" : answer ? "y" : "n");
							return result;
						},
					}
				: {}),
		},
	};
	for (const h of handlers.session_start ?? []) await h({}, ctx);
	return {
		dialogs,
		cards,
		notes,
		commands,
		newSession: async () => {
			for (const h of handlers.session_start ?? []) await h({}, ctx);
		},
		async bash(command: string, toolName = "bash") {
			for (const h of handlers.tool_call ?? []) {
				const input = toolName === "bg_start" ? { command, cwd } : { command };
				const r = await h({ toolName, toolCallId: String(++counter), input }, ctx);
				if (r?.block) return String(r.reason);
			}
			return undefined;
		},
		async tool(toolName: string, input: object = {}) {
			for (const h of handlers.tool_call ?? []) {
				const r = await h({ toolName, toolCallId: String(++counter), input }, ctx);
				if (r?.block) return String(r.reason);
			}
			return undefined;
		},
	};
}

const PR = "gh pr create --fill";
/** The user approved the one PR dialog, and it held no gate reason (a T1 note may ride it): only the always-on approval of a PR creation. */
const onlyApproval = (s: { dialogs: Array<{ title: string; body: string }> }) => {
	assert.equal(s.dialogs.length, 1, JSON.stringify(s.dialogs));
	assert.match(s.dialogs[0].title, /open a pull request/);
	assert.doesNotMatch(s.dialogs[0].body, /^- /m);
};

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
		assert.match(s.dialogs[0].title, /open a pull request/);
		assert.match(s.dialogs[0].body, /^Opens a pull request on GitHub\.\n/);
		assert.match(s.dialogs[0].body, /\nRisk  ● Low · /);
		assert.match(s.dialogs[0].body, /\n  \$ gh pr create --fill\n\nPR risk gate:\n/);
		assert.match(s.dialogs[0].body, /has no brigadev-verify run\n\nRun it\?$/);
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

	it("T0 in yolo: only the PR approval, with no gate reason", async () => {
		const { cwd, docs } = repo(["tests/a.test.ts"]);
		tested(cwd, docs);
		const s = await session(cwd, { mode: "yolo", answer: true });
		assert.equal(await s.bash(PR), undefined);
		onlyApproval(s);
	});

	it("a PR creation and a push always ask the user, in yolo too; without a UI they are blocked", async () => {
		const { cwd, docs } = repo(["tests/a.test.ts"]);
		tested(cwd, docs);
		for (const command of [PR, "git push -u origin feat/x"]) {
			const declined = await session(cwd, { mode: "yolo" });
			assert.match(String(await declined.bash(command)), /User declined/, command);
			assert.equal(declined.dialogs.length, 1, command);
			assert.match(String(await (await session(cwd, { mode: "yolo", ui: false })).bash(command)), /User declined/, command);
		}
	});

	it("yolo: a T2 branch with a clean verify runs with no dialog", async () => {
		const { cwd, docs } = repo(["lib/guard-rules.ts"]);
		appendEvidence(evidenceFile(docs, "feat/x"), record({ type: "verify", scope: "branch", categories: ["security"], blockers: [], outcome: "clean" }));
		tested(cwd, docs);
		const s = await session(cwd, { mode: "yolo", answer: true });
		assert.equal(await s.bash(PR), undefined);
		onlyApproval(s);
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
		const resolved = await session(cwd, { mode: "yolo", answer: true });
		assert.equal(await resolved.bash(PR), undefined);
		onlyApproval(resolved);
	});

	it("T1 without a ledger: the note rides the one PR dialog, in yolo and normal", async () => {
		const { cwd, docs } = repo(["src/a.ts"]);
		tested(cwd, docs);
		const yolo = await session(cwd, { mode: "yolo", answer: true });
		assert.equal(await yolo.bash(PR), undefined);
		assert.equal(yolo.dialogs.length, 1);
		assert.match(yolo.dialogs[0].body, /no review ledger for this branch/);
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
		const s = await session(cwd, { mode: "yolo", answer: true });
		assert.equal(await s.bash("gh pr view"), undefined);
		assert.deepEqual(s.dialogs, []);
		assert.equal(await s.bash("git push -u origin feat/x"), undefined);
		assert.equal(s.dialogs.length, 1, "a push asks, but carries no PR gate reason");
		assert.doesNotMatch(s.dialogs[0].body, /PR risk gate/);
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
			const fresh = await session(cwd, { mode: "yolo", answer: true });
			assert.equal(await fresh.bash(PR), undefined);
			onlyApproval(fresh);
		});

		it("uncommitted edits do not matter: HEAD is what the PR opens", async () => {
			const { cwd, docs } = repo(["src/a.ts"]);
			tested(cwd, docs);
			writeFileSync(join(cwd, "src/a.ts"), "uncommitted\n");
			const s = await session(cwd, { mode: "yolo", answer: true });
			assert.equal(await s.bash(PR), undefined);
			onlyApproval(s);
		});

		it("`gh pr new` (gh's alias) is gated like gh pr create, and asks for confirmation in normal mode", async () => {
			const { cwd } = repo(["src/a.ts"]);
			assert.match(String(await (await session(cwd, { mode: "yolo", ui: false })).bash("gh pr new --fill")), /no passing test recorded for the committed HEAD/);
			for (const command of ["gh pr --repo o/r create --fill", "gh pr -R o/r create --fill"]) {
				const flagged = await session(cwd, { mode: "yolo", answer: true });
				assert.equal(await flagged.bash(command), undefined, command);
				assert.equal(flagged.dialogs.length, 1, command);
				assert.match(flagged.dialogs[0].body, /no passing test recorded/, command);
			}
			const normal = await session(cwd, { answer: true });
			assert.equal(await normal.bash("gh pr new --fill"), undefined);
			assert.equal(normal.dialogs.length, 1);
			assert.match(normal.dialogs[0].body, /no passing test recorded/);
		});

		it("a branch that only deletes or renames source still needs a test", async () => {
			const { cwd } = repo(["src/a.ts"]);
			git(cwd, "checkout", "-q", "main");
			git(cwd, "merge", "-q", "--ff-only", "feat/x");
			git(cwd, "checkout", "-q", "-b", "feat/y");
			git(cwd, "mv", "src/a.ts", "src/b.ts");
			git(cwd, "commit", "-qm", "rename");
			const s = await session(cwd, { mode: "yolo", ui: false });
			assert.match(String(await s.bash(PR)), /no passing test recorded for the committed HEAD/);
		});

		it("a git failure while reading the branch's paths asks instead of passing", async () => {
			const { cwd } = repo(["src/a.ts"]);
			git(cwd, "config", "diff.relative", "notabool"); // merge-base still works; diff and status fail
			const s = await session(cwd, { mode: "yolo", ui: false });
			assert.notEqual(await s.bash(PR), undefined);
		});

		it("a branch that commits only docs needs no test", async () => {
			const { cwd } = repo(["docs/guide.md"]);
			const s = await session(cwd, { mode: "yolo", answer: true });
			assert.equal(await s.bash(PR), undefined);
			onlyApproval(s);
		});

		it("with a detected suite, a focused run does not vouch for HEAD; the full suite does", async () => {
			const { cwd, docs } = repo(["src/a.ts", "package.json"]);
			writeFileSync(join(cwd, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
			git(cwd, "commit", "-qam", "suite");
			tested(cwd, docs, { command: "npm test -- tests/a.test.ts" });
			const focused = await session(cwd, { mode: "yolo" });
			assert.match(String(await focused.bash(PR)), /only other test commands passed on it; the full suite is `npm test`/);
			tested(cwd, docs);
			assert.equal(await (await session(cwd, { mode: "yolo", answer: true })).bash(PR), undefined);
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

	describe("MCP tools that open a PR (T3 Code's pull_request_create, GitHub's create_pull_request)", () => {
		const CREATE = "mcp__t3-code__pull_request_create";

		it("yolo: a T2 branch without a verify asks with the gate's reasons; a decline blocks with what to do", async () => {
			const { cwd } = repo(["lib/guard-rules.ts"]);
			const s = await session(cwd, { mode: "yolo" });
			const reason = String(await s.tool(CREATE, { title: "t", body: "b" }));
			assert.equal(s.dialogs.length, 1);
			assert.match(s.dialogs[0].title, /open a pull request/);
			assert.match(s.dialogs[0].body, /pull_request_create/);
			assert.match(s.dialogs[0].body, /T2 branch \(security: lib\/guard-rules\.ts\) has no brigadev-verify run/);
			assert.match(reason, /brigadev-verify/);
			assert.match(reason, /pull_request_create/);
		});

		it("a tested T0 branch still asks every time (it pushes), in yolo too; the user's yes lets it run", async () => {
			const { cwd, docs } = repo(["tests/a.test.ts"]);
			tested(cwd, docs);
			for (const name of [CREATE, "mcp__t3_code__pull_request_create", "mcp__github__create_pull_request"]) {
				const s = await session(cwd, { mode: "yolo", answer: true });
				assert.equal(await s.tool(name), undefined, name);
				assert.equal(s.dialogs.length, 1, name);
				assert.doesNotMatch(s.dialogs[0].body, /^- /m, name);
			}
		});

		it("untested source: the gate names the missing run", async () => {
			const { cwd } = repo(["src/a.ts"]);
			const s = await session(cwd, { mode: "yolo" });
			assert.match(String(await s.tool(CREATE)), /no passing test recorded for the committed HEAD/);
		});

		it("no UI: blocked, in yolo and normal", async () => {
			const { cwd, docs } = repo(["tests/a.test.ts"]);
			tested(cwd, docs);
			for (const mode of ["yolo", undefined] as const) {
				const s = await session(cwd, { mode, ui: false });
				assert.notEqual(await s.tool(CREATE), undefined, String(mode));
			}
		});

		it("a merge asks in yolo; a decline blocks", async () => {
			const { cwd } = repo(["tests/a.test.ts"]);
			const s = await session(cwd, { mode: "yolo" });
			assert.match(String(await s.tool("mcp__t3-code__pull_request_merge", { expectedHeadSha: "abc" })), /declined/i);
			assert.equal(s.dialogs.length, 1);
			assert.match(s.dialogs[0].body, /expectedHeadSha/);
		});

		it("a subagent is blocked from every classified MCP call, and its reads pass", async () => {
			const { cwd } = repo(["tests/a.test.ts"]);
			process.env.BRIGADEV_CHILD = "1";
			try {
				const s = await session(cwd, { mode: "yolo", answer: true });
				for (const name of [CREATE, "mcp__t3-code__pull_request_merge", "mcp__github__push_files", "mcp__t3-code__pull_request_respond"]) {
					assert.match(String(await s.tool(name)), /subagents may not run this/, name);
				}
				assert.equal(await s.tool("mcp__t3-code__pull_request_read"), undefined);
				assert.deepEqual(s.dialogs, []);
			} finally {
				delete process.env.BRIGADEV_CHILD;
			}
		});

		it("a PR comment runs in yolo and asks in normal; reads never ask", async () => {
			const { cwd } = repo(["tests/a.test.ts"]);
			const yolo = await session(cwd, { mode: "yolo" });
			assert.equal(await yolo.tool("mcp__t3-code__pull_request_respond", { body: "x" }), undefined);
			assert.equal(await yolo.tool("mcp__t3-code__pull_request_read"), undefined);
			assert.deepEqual(yolo.dialogs, []);
			const normal = await session(cwd);
			assert.match(String(await normal.tool("mcp__t3-code__pull_request_respond", { body: "x" })), /declined/i);
			assert.equal(normal.dialogs.length, 1);
		});
	});

	it("outside a git repository the gate adds nothing: only the PR approval", async () => {
		const plain = join(dir, "plain");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { mode: "yolo", answer: true });
		assert.equal(await s.bash(PR), undefined);
		onlyApproval(s);
	});
});

describe("guard: the permission dialog explains the action", () => {
	it("shows the command's # why: note, what it does, and its risk", async () => {
		const plain = join(dir, "why");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain);
		assert.match(String(await s.bash("# why: the worktree is merged and unused\nrm -rf build")), /User declined/);
		assert.equal(s.dialogs[0].title, "brigadev · Needs your permission: delete or overwrite data");
		// Pi's confirm (an RPC client: T3 Code) gets the short version.
		assert.equal(
			s.dialogs[0].body,
			["Deletes or overwrites data.", "", "Why   the worktree is merged and unused", "Risk  ● High · usually cannot be undone · affects the files or data it targets", "", "  $ rm -rf build", "", "Run it?"].join("\n"),
		);
	});

	it("the TUI shows the permission card, folded, and its answer decides", async () => {
		const plain = join(dir, "why-card");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { tui: true, answer: true });
		assert.equal(await s.bash("# why: the worktree is merged and unused\nrm -rf build"), undefined);
		assert.deepEqual(s.dialogs, []);
		const card = s.cards[0].join("\n");
		assert.match(card, /^╭─ brigadev · Needs your permission ─+╮/);
		assert.match(card, /│  Why    the worktree is merged and unused +│/);
		assert.match(card, /│  Risk   ● High · usually cannot be undone/);
		assert.match(card, /│  \$ rm -rf build +│/);
		assert.match(card, /▸ Show details/);
		assert.doesNotMatch(card, /WHAT IT WILL DO/);
		const declined = await session(plain, { tui: true });
		assert.match(String(await declined.bash("rm -rf build")), /User declined/);
	});

	it("a quote in the why line does not hide the command from the guard", async () => {
		const plain = join(dir, "why-quote");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain);
		assert.match(String(await s.bash("# why: it's stale\nrm -rf build")), /User declined/);
		assert.equal(s.dialogs.length, 1);
		assert.match(s.dialogs[0].body, /\nWhy   it's stale\n/);
	});

	it("warns when the command gives no reason", async () => {
		const plain = join(dir, "why-missing");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain);
		await s.bash("rm -rf build");
		assert.match(s.dialogs[0].body, /\nWhy   ⚠ The agent did not say why\./);
	});
});

describe("guard: yes, and don't ask again this session", () => {
	const COMMENT = "# why: answer the reviewer\ngh pr comment 1 --body thanks";

	it("a session yes stops asking about that action until the session ends", async () => {
		const plain = join(dir, "grant");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { answer: "session" });
		assert.equal(await s.bash(COMMENT), undefined);
		assert.deepEqual(s.dialogs[0].options, ["Yes", SESSION_LABEL, "No"]);
		assert.match(s.notes.join("\n"), /won't ask again this session for: write to GitHub/);
		// The same action, another form of it: no question.
		assert.equal(await s.bash("gh pr comment 2 --body again"), undefined);
		assert.equal(await s.bash("gh issue comment 3 --body hi"), undefined);
		assert.equal(s.dialogs.length, 1);
		// Another action still asks.
		await s.bash("npm install left-pad");
		assert.equal(s.dialogs.length, 2);
		assert.match(s.dialogs[1].title, /change dependencies/);
		// A new session starts with no grant.
		await s.newSession();
		await s.bash("gh pr comment 4 --body x");
		assert.equal(s.dialogs.length, 3);
	});

	it("is never offered for a High action, and a grant never covers a command that adds one", async () => {
		const plain = join(dir, "grant-high");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { answer: "session" });
		await s.bash("rm -rf build");
		assert.equal(s.dialogs[0].options, undefined, "Pi's plain confirm: no third answer");
		await s.bash("rm -rf build");
		assert.equal(s.dialogs.length, 2, "a High action asks every time");
		await s.bash(COMMENT);
		await s.bash("gh pr comment 1 --body x && rm -rf build");
		assert.equal(s.dialogs.length, 4);
		assert.equal(s.dialogs[3].options, undefined);
	});

	it("the TUI card takes `s` for the session yes", async () => {
		const plain = join(dir, "grant-card");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { tui: true, answer: "session" });
		assert.equal(await s.bash(COMMENT), undefined);
		assert.match(s.cards[0].join("\n"), /Yes, and don't ask again this session  \(s\)/);
		assert.equal(await s.bash("gh pr comment 2 --body again"), undefined);
		assert.equal(s.cards.length, 1);
	});

	it("a granted PR still asks when the PR gate finds a problem, with no session answer on that question", async () => {
		const { cwd } = repo(["lib/guard-rules.ts"]);
		const s = await session(cwd, { answer: "session" });
		assert.equal(await s.bash(PR), undefined);
		assert.deepEqual(s.dialogs[0].options, ["Yes", SESSION_LABEL, "No"]);
		assert.equal(await s.bash(PR), undefined);
		assert.equal(s.dialogs.length, 2);
		assert.match(s.dialogs[1].body, /T2 branch \(security: lib\/guard-rules\.ts\) has no brigadev-verify run/);
		assert.equal(s.dialogs[1].options, undefined);
	});

	it("a granted PR with a clean gate runs without asking", async () => {
		const plain = join(dir, "grant-pr");
		mkdirSync(plain, { recursive: true });
		const s = await session(plain, { answer: "session" });
		assert.equal(await s.bash(PR), undefined);
		assert.equal(await s.bash(PR), undefined);
		assert.equal(s.dialogs.length, 1);
	});
});
