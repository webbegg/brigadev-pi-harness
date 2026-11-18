import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { commitGateWithForce, evidenceFile, forceRecord, gateDialog, readEvidence, runRecordFromResult, settleRunTree, type RunRecord } from "../lib/evidence.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";

// The extensions import the Pi package at runtime; tests run without it.
const STUB = `data:text/javascript,export const isToolCallEventType=(n,e)=>e.toolName===n;export const getAgentDir=()=>"/nonexistent";export const parseFrontmatter=()=>({});export const getMarkdownTheme=()=>({});`;
registerHooks({ resolve: (spec, ctx, next) => (spec === "@earendil-works/pi-coding-agent" ? { url: STUB, shortCircuit: true } : next(spec, ctx)) });

const base = { ts: "2026-11-14T10:00:00.000Z", branch: "feat/x", tree: "a".repeat(40), cwd: "/repo", agent: "parent" };
const text = (t: string) => [{ type: "text", text: t }];

describe("runRecordFromResult", () => {
	it("builds a record from structuredContent exit code and output", () => {
		const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: text("ignored"), structuredContent: { exit_code: 0, output: "ok\n5 passing" } }, base);
		assert.ok(record);
		assert.equal(record.command, "npm test");
		assert.equal(record.exitCode, 0);
		assert.equal(record.outcome, "pass");
		assert.equal(record.tail, "ok\n5 passing");
		assert.equal(record.tree, base.tree);
		assert.equal(record.agent, "parent");
	});

	it("falls back to the text content when structuredContent has no output", () => {
		const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: [...text("line a"), { type: "image" }, ...text("line b")], structuredContent: { exit_code: 1 } }, base);
		assert.equal(record?.outcome, "fail");
		assert.equal(record?.tail, "line a\nline b");
	});

	it("leaves the exit code undefined unless it is a number", () => {
		for (const structuredContent of [undefined, {}, { exit_code: "0" }, { exit_code: null }, "x"]) {
			const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: text("out"), structuredContent }, base);
			assert.equal(record?.exitCode, undefined);
			assert.equal(record?.outcome, "unknown");
		}
	});

	it("records nothing for other tools, non-check commands, missing commands, or an undefined tree", () => {
		assert.equal(runRecordFromResult({ toolName: "read", input: { command: "npm test" }, content: [] }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: { command: "ls -la" }, content: text("x") }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: {}, content: text("x") }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: { command: 5 }, content: text("x") }, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: text("x") }, { ...base, tree: undefined }), undefined);
	});

	it("tolerates malformed events without throwing", () => {
		assert.equal(runRecordFromResult(undefined, base), undefined);
		assert.equal(runRecordFromResult({ toolName: "bash" }, base), undefined);
		const record = runRecordFromResult({ toolName: "bash", input: { command: "npm test" }, content: "oops" }, base);
		assert.equal(record?.tail, "");
	});

	it("keeps a null branch and the agent name", () => {
		const record = runRecordFromResult({ toolName: "bash", input: { command: "tsc --noEmit" }, content: text("") }, { ...base, branch: null, agent: "brigadev-verify" });
		assert.equal(record?.branch, null);
		assert.equal(record?.agent, "brigadev-verify");
		assert.equal(record?.kind, "check");
	});
});

describe("forceRecord", () => {
	it("records how the user forced the commit", () => {
		const record = forceRecord({ ts: base.ts, branch: "feat/x", tree: base.tree, via: "dialog", command: "git commit -m x" });
		assert.deepEqual(record, { v: 1, type: "force", ts: base.ts, branch: "feat/x", tree: base.tree, via: "dialog", command: "git commit -m x" });
	});

	it("truncates a long command", () => {
		assert.equal(forceRecord({ ts: base.ts, branch: null, via: "command", command: "x".repeat(900) }).command.length, 500);
	});
});

describe("gateDialog", () => {
	it("shows the reason, the command, and asks the user to force it", () => {
		const dialog = gateDialog("Blocked by brigadev evidence gate: nothing ran.", "git commit -m 'x'");
		assert.match(dialog.title, /evidence gate/i);
		assert.match(dialog.body, /nothing ran/);
		assert.match(dialog.body, /git commit -m 'x'/);
		assert.match(dialog.body, /Commit anyway\?/);
	});

	it("does not repeat the instructions meant for the model", () => {
		const dialog = gateDialog("Blocked by brigadev evidence gate: nothing ran. Run the tests in their own bash command, then commit again.", "git commit");
		assert.doesNotMatch(dialog.body, /tell them to run/);
	});
});

describe("commitGateWithForce", () => {
	const tree = "b".repeat(40);
	const input = { dirtyPaths: ["src/a.ts"], tree, elsewhere: false, records: [] as RunRecord[], forcedTree: undefined as string | undefined };

	it("blocks without evidence and without a force", () => {
		const result = commitGateWithForce(input);
		assert.equal(result.decision.action, "block");
		assert.equal(result.consumedForce, false);
	});

	it("lets a force for this tree through and consumes it", () => {
		const result = commitGateWithForce({ ...input, forcedTree: tree });
		assert.equal(result.decision.action, "allow");
		assert.equal(result.consumedForce, true);
	});

	it("keeps a force bound to another tree unused", () => {
		const result = commitGateWithForce({ ...input, forcedTree: "c".repeat(40) });
		assert.equal(result.decision.action, "block");
		assert.equal(result.consumedForce, false);
	});

	it("does not consume the force when the commit passes on its own", () => {
		const run: RunRecord = { v: 1, type: "run", ts: base.ts, branch: null, tree, cwd: "/repo", agent: "parent", command: "npm test", kind: "test", exitCode: 0, outcome: "pass", tail: "" };
		const result = commitGateWithForce({ ...input, records: [run], forcedTree: tree });
		assert.equal(result.decision.action, "allow");
		assert.equal(result.consumedForce, false);
		const docs = commitGateWithForce({ ...input, dirtyPaths: ["README.md"], forcedTree: tree });
		assert.equal(docs.consumedForce, false);
	});

	it("never lets a force override an elsewhere commit", () => {
		const result = commitGateWithForce({ ...input, elsewhere: true, forcedTree: tree });
		assert.equal(result.decision.action, "block");
		assert.equal(result.consumedForce, false);
	});
});

describe("settleRunTree (the tree a run may be keyed to)", () => {
	const T = "a".repeat(40);

	it("keys the run to the tree only when it did not change during the run", () => {
		assert.deepEqual(settleRunTree(T, T), { record: true, tree: T });
	});

	it("drops the tree and says why when the tree changed during the run", () => {
		assert.deepEqual(settleRunTree(T, "b".repeat(40)), { record: true, tree: undefined, note: "tree changed during run" });
	});

	it("drops the tree when the tree before the run is unknown", () => {
		assert.deepEqual(settleRunTree(undefined, T), { record: true, tree: undefined, note: "tree before the run is unknown" });
	});

	it("records nothing without a tree after the run (no git)", () => {
		assert.deepEqual(settleRunTree(T, undefined), { record: false });
		assert.deepEqual(settleRunTree(undefined, undefined), { record: false });
	});

	it("S8c: a run whose source tree held keeps it when only docs changed during the run", () => {
		const S = "c".repeat(40);
		assert.deepEqual(settleRunTree(T, T, S, S), { record: true, tree: T, srcTree: S });
		assert.deepEqual(settleRunTree(T, "b".repeat(40), S, S), { record: true, tree: undefined, srcTree: S });
		assert.deepEqual(settleRunTree(T, "b".repeat(40), S, "d".repeat(40)), { record: true, tree: undefined, note: "tree changed during run" });
		assert.deepEqual(settleRunTree(T, T), { record: true, tree: T }, "without source trees nothing changes");
	});
});

describe("runRecordFromResult with an unsettled tree", () => {
	const passing = { toolName: "bash", input: { command: "npm test" }, content: text("ok"), structuredContent: { exit_code: 0, output: "ok" } };

	it("records outcome unknown with the note, without a tree, even for exit 0", () => {
		const record = runRecordFromResult(passing, { ...base, tree: undefined, note: "tree changed during run" });
		assert.ok(record);
		assert.equal(record.exitCode, 0);
		assert.equal(record.outcome, "unknown");
		assert.equal(record.tree, undefined);
		assert.equal(record.note, "tree changed during run");
	});

	it("still records nothing when there is neither a tree nor a note", () => {
		assert.equal(runRecordFromResult(passing, { ...base, tree: undefined }), undefined);
	});

	it("judges a cd in the command against the directory context", () => {
		const cd = { ...passing, input: { command: "cd sub && npm test" } };
		assert.equal(runRecordFromResult(cd, { ...base, cwd: "/repo", topLevel: "/repo" })?.outcome, "pass");
		assert.equal(runRecordFromResult(cd, { ...base, cwd: "/repo/x", topLevel: "/repo/x" })?.outcome, "pass");
		assert.equal(runRecordFromResult({ ...passing, input: { command: "cd .. && npm test" } }, { ...base, cwd: "/repo", topLevel: "/repo" })?.outcome, "unknown");
	});
});

describe("runRecordFromResult keyed by source tree and root (S8b, S8c)", () => {
	const passing = { toolName: "bash", input: { command: "npm test" }, content: text("ok"), structuredContent: { exit_code: 0, output: "ok" } };

	it("records a run that has only a source tree, with the repository root", () => {
		const record = runRecordFromResult(passing, { ...base, tree: undefined, srcTree: "s".repeat(40), topLevel: "/repo" });
		assert.equal(record?.outcome, "pass");
		assert.equal(record?.tree, undefined);
		assert.equal(record?.srcTree, "s".repeat(40));
		assert.equal(record?.root, "/repo");
	});

	it("judges `cd <nested repo> && <test>` against the nested repository's top level", () => {
		const nested = { ...passing, input: { command: "cd /work/parent/nested && npm test" } };
		assert.equal(runRecordFromResult(nested, { ...base, cwd: "/work/parent", topLevel: "/work/parent/nested" })?.outcome, "pass");
	});
});

describe("gateDialog wording", () => {
	it("says forcing is logged, not that the answer is", () => {
		const dialog = gateDialog("Blocked by brigadev evidence gate: nothing ran.", "git commit");
		assert.doesNotMatch(dialog.body, /answer is logged/i);
		assert.match(dialog.body, /Forcing is logged/);
	});
});

describe("the user's force is spent only when the commit goes ahead (A3)", () => {
	const saved = { ...process.env };
	const scratch: string[] = [];
	after(() => {
		process.env = saved;
		for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
	});

	/** A repository on `branch` with one committed file and a source edit pending. */
	function makeRepo(branch: string) {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-force-")));
		scratch.push(dir);
		const repo = join(dir, "repo");
		mkdirSync(repo);
		for (const key of ["BRIGADEV_CHILD", "BRIGADEV_AGENT", "BRIGADEV_READ_ONLY", "BRIGADEV_PROJECT_ROOT"]) delete process.env[key];
		process.env.BRIGADEV_HOME = join(dir, "home");
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		git("init", "-q", "-b", branch);
		writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		appendFileSync(join(repo, "src.ts"), "export const b = 2;\n");
		const evidence = (name: string) => {
			const file = join(dir, "home", "repo", "evidence", `${name}.jsonl`);
			return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
		};
		return { repo, git, evidence };
	}

	async function session(cwd: string, ui: { hasUI: boolean; confirm: (title: string) => boolean }) {
		const handlers: Record<string, Function[]> = {};
		const commands: Record<string, { handler: Function }> = {};
		const notes: string[] = [];
		const pi: any = {
			on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
			registerCommand: (name: string, options: { handler: Function }) => (commands[name] = options),
			registerShortcut: () => {},
			appendEntry: () => {},
			exec: async (command: string, args: string[], options: { cwd: string }) => {
				try {
					return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }), stderr: "", code: 0 };
				} catch (error: any) {
					return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
				}
			},
		};
		(await import(`../extensions/guard.ts?${Math.random()}`)).default(pi);
		const ctx: any = { cwd, hasUI: ui.hasUI, sessionManager: { getBranch: () => [] }, ui: { confirm: async (title: string) => ui.confirm(title), notify: (message: string) => void notes.push(message), setStatus: () => {} } };
		let id = 0;
		return {
			notes,
			force: () => commands["brigadev:force-commit"].handler("", ctx),
			async call(command: string) {
				for (const handler of handlers.tool_call ?? []) {
					const result = await handler({ toolName: "bash", toolCallId: String(++id), input: { command } }, ctx);
					if (result?.block) return result.reason as string;
				}
				return undefined;
			},
		};
	}

	it("keeps /brigadev:force-commit when a later rule declines the commit, then spends and logs it once", async () => {
		const { repo, git, evidence } = makeRepo("main");
		const s = await session(repo, { hasUI: false, confirm: () => false });
		await s.force();
		assert.match(String(await s.call("git commit -am x")), /User declined/); // protected branch asks; no UI means no
		assert.deepEqual(evidence("main").filter((r) => r.type === "force"), [], "nothing logged for a declined commit");

		git("checkout", "-q", "-b", "feat/y");
		assert.equal(await s.call("git commit -am x"), undefined, "the force is still there");
		assert.deepEqual(evidence("feat-y").filter((r) => r.type === "force").map((r) => r.via), ["command"]);
		assert.match(String(await s.call("git commit -am x")), /evidence gate/, "spent after one commit");
	});

	it("does not log the dialog's force when a later rule declines the commit", async () => {
		const { repo, git, evidence } = makeRepo("main");
		const s = await session(repo, { hasUI: true, confirm: (title) => /evidence gate/.test(title) });
		assert.match(String(await s.call("git commit -am x")), /User declined/);
		assert.deepEqual(evidence("main").filter((r) => r.type === "force"), []);

		git("checkout", "-q", "-b", "feat/y");
		assert.equal(await s.call("git commit -am x"), undefined);
		assert.deepEqual(evidence("feat-y").filter((r) => r.type === "force").map((r) => r.via), ["dialog"]);
	});

	it("fails closed when the working tree cannot be computed; only the dialog can force it", async () => {
		const { repo, git, evidence } = makeRepo("feat/q");
		writeFileSync(join(repo, ".git", "index"), "not an index"); // rev-parse still works, hashing the tree does not
		const headless = await session(repo, { hasUI: false, confirm: () => false });
		const reason = String(await headless.call("git commit -am x"));
		assert.match(reason, /evidence gate/);
		assert.match(reason, /could not be computed/);

		await headless.force();
		assert.match(headless.notes.join("\n"), /dialog|fix git/i, "the command says what to do instead");
		assert.match(String(await headless.call("git commit -am x")), /evidence gate/, "the command grants nothing on an error");
		assert.deepEqual(evidence("feat-q"), []);

		const asked: string[] = [];
		const interactive = await session(repo, { hasUI: true, confirm: (title) => (asked.push(title), true) });
		assert.equal(await interactive.call("git commit -am x"), undefined, "the user can force it in the dialog");
		assert.match(asked[0], /evidence gate/, "the gate asks first, then the normal commit rule");
		assert.deepEqual(evidence("feat-q").filter((r) => r.type === "force").map((r) => r.via), ["dialog"]);
		void git;
	});

	it("blocks a bash command that writes the evidence log and lets one read it (A1)", async () => {
		const { repo } = makeRepo("feat/z");
		const file = join(process.env.BRIGADEV_HOME ?? "", "repo", "evidence", "feat-z.jsonl");
		const s = await session(repo, { hasUI: false, confirm: () => false });
		assert.match(String(await s.call(`echo '{"v":1}' >> ${file}`)), /evidence log/);
		assert.match(String(await s.call(`cp /tmp/forged.jsonl ${file}`)), /evidence log/);
		assert.equal(await s.call(`cat ${file}`), undefined);
		assert.equal(await s.call(`grep fail ${file} | tail -3`), undefined);
	});
});

describe("the recorder (S8a pipefail, S8b nested repositories, S8c docs)", () => {
	const saved = { ...process.env };
	const base2 = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-rec-")));
	after(() => {
		process.env = saved;
		rmSync(base2, { recursive: true, force: true });
	});
	for (const key of ["BRIGADEV_CHILD", "BRIGADEV_AGENT", "BRIGADEV_READ_ONLY", "BRIGADEV_PROJECT_ROOT"]) delete process.env[key];
	process.env.BRIGADEV_HOME = join(base2, "home");

	// The session folder `parent` is no repository; `nested` is one, on feat/n.
	const parent = join(base2, "parent");
	const nested = join(parent, "nested");
	mkdirSync(nested, { recursive: true });
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: nested, encoding: "utf8" });
	git("init", "-q", "-b", "feat/n");
	writeFileSync(join(nested, "src.ts"), "1");
	writeFileSync(join(nested, "README.md"), "# r\n");
	git("add", "-A");
	git("commit", "-qm", "init");

	async function recorder(cwd: string) {
		const handlers: Record<string, Function[]> = {};
		const pi: any = {
			on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
			exec: async (command: string, args: string[], options: { cwd: string }) => {
				try {
					return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }), stderr: "", code: 0 };
				} catch (error: any) {
					return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
				}
			},
		};
		(await import(`../extensions/evidence.ts?${Math.random()}`)).default(pi);
		const ctx: any = { cwd };
		let id = 0;
		return {
			/** Runs a bash call through the handlers; `between` runs after tool_call and before tool_result (an edit during the run). */
			async run(command: string, exitCode: number, between: () => void = () => {}) {
				const toolCallId = String(++id);
				const input = { command };
				for (const handler of handlers.tool_call ?? []) await handler({ toolName: "bash", toolCallId, input }, ctx);
				between();
				// A result event may carry the input as written or as mutated; the recorder must cope with the written one.
				for (const handler of handlers.tool_result ?? []) await handler({ toolName: "bash", toolCallId, input: { command }, content: [{ type: "text", text: "ok" }], structuredContent: { exit_code: exitCode, output: "ok" } }, ctx);
				return input.command;
			},
		};
	}
	const records = () => readEvidence(evidenceFile(repoDocsDir(nested), "feat/n")).filter((r): r is RunRecord => r.type === "run");

	it("S8a: injects pipefail into a piped test run so its exit code is the runner's, and trusts the outcome", async () => {
		const before = records().length;
		const s = await recorder(parent);
		const ran = await s.run("cd nested && node --test tests/a.test.ts | tail -20", 1);
		assert.equal(ran, "set -o pipefail; cd nested && node --test tests/a.test.ts | tail -20");
		const record = records().at(-1);
		assert.equal(records().length, before + 1);
		assert.equal(record?.outcome, "fail", "the runner's exit code, not tail's");
		assert.equal(record?.exitCode, 1);
	});

	it("does not touch a command that needs no pipefail, or is not a test run", async () => {
		const s = await recorder(parent);
		assert.equal(await s.run("cd nested && npm test", 0), "cd nested && npm test");
		assert.equal(await s.run("ls | tail", 0), "ls | tail");
		assert.equal(await s.run("set -o pipefail; npm test | tail", 0), "set -o pipefail; npm test | tail");
	});

	it("S8b: records a test run in a nested repository against that repository, on its branch", async () => {
		const s = await recorder(parent);
		await s.run("cd nested && npm test", 0);
		const record = records().at(-1);
		assert.equal(record?.outcome, "pass");
		assert.equal(record?.branch, "feat/n");
		assert.equal(record?.root, nested);
		assert.match(record?.tree ?? "", /^[0-9a-f]{40}$/);
		assert.match(record?.srcTree ?? "", /^[0-9a-f]{40}$/);
	});

	it("records nothing for a run outside any repository", async () => {
		const before = records().length;
		const s = await recorder(parent);
		await s.run("npm test", 0);
		assert.equal(records().length, before);
	});

	it("S8c: a doc edit while the test ran keeps the run valid for the source tree", async () => {
		const s = await recorder(parent);
		await s.run("cd nested && npm test", 0, () => writeFileSync(join(nested, "README.md"), `# edited ${Math.random()}\n`));
		const record = records().at(-1);
		assert.equal(record?.outcome, "pass");
		assert.equal(record?.tree, undefined);
		assert.match(record?.srcTree ?? "", /^[0-9a-f]{40}$/);

		await s.run("cd nested && npm test", 0, () => writeFileSync(join(nested, "src.ts"), `${Math.random()}`));
		assert.equal(records().at(-1)?.outcome, "unknown", "a source edit during the run is not vouched for");
	});
});
