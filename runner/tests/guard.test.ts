// A4 (S5): the worker's `beforeTool` guard, decided over the brigadev lib/ rules. The table reuses representative inputs of the
// root suite; each group names the test it copies from:
//   tests/guard-rules.test.ts  "evidence log protection" (blocks write and edit tool calls into the evidence folder and its children;
//                               blocks a bash command that writes to the evidence path; lets bash read the evidence),
//                              "file access decision" (blocks a subagent writing outside the project; blocks a sensitive path for a subagent),
//                              "bash decision" (asks on a protected branch; keeps the subagent and yolo rules: `git push` asks)
//   tests/command-classifier.test.ts  `rm -rf build` is destructive; `rm -rf /` is a hard deny.
// The evidence/docs dir is BRIGADEV_HOME in a temp dir (isolateEnv), so the real ~/.brigadev is never written.
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { obj, str } from "@earendil-works/pi-schema";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, defineExtension, defineTool, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import type { NestedToolExecutionResult } from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { evidenceFile } from "../../lib/evidence.ts";
import { repoDocsDir } from "../../lib/repo-docs.ts";
import { createGuard, guardExtension, type GuardCall } from "../src/guard.ts";
import { FEATURE_BRANCH, git, isolateEnv, makeWorkspace, type Isolation, type Workspace } from "./fixture.ts";

let env: Isolation;
let ws: Workspace;
before(() => {
	env = isolateEnv();
});
after(() => env.restore());
/** A fresh repo, empty evidence, and default settings for every test of the suite it is called in. */
function fresh() {
	beforeEach(() => {
		env.settings({});
		rmSync(env.brigadevHome, { recursive: true, force: true }); // no evidence carried over from an earlier test
		ws = makeWorkspace();
	});
	afterEach(() => ws.cleanup());
}

const evidenceDir = () => join(repoDocsDir(ws.repo), "evidence");
const guard = (options: { settings?: object } = {}) => createGuard({ cwd: ws.repo, settings: options.settings ? () => options.settings as never : undefined });

type Case = { name: string; call: () => GuardCall; expect: "allow" | RegExp; mode?: "yolo" };
const bash = (command: string): GuardCall => ({ name: "bash", arguments: { command } });

const NEEDS_YOU = /^needs you: /;
/** The denial of a command tells the worker how to get it approved (T5): ask with `command` set and an Approve option. */
const ASK_HINT = /ask_user_choice.*`command`.*Approve/s;
const DELIVERY = /the runner owns PR delivery/;
const COMMIT_ALONE = /a commit runs in its own bash call/;

const CASES: Case[] = [
	// file tools: "blocks a subagent writing outside the project", evidence-folder writes, "blocks a sensitive path for a subagent"
	{ name: "write outside the worktree (absolute)", call: () => ({ name: "write", arguments: { path: join(ws.root, "outside.txt"), content: "x" } }), expect: /outside the project root/ },
	{ name: "edit outside the worktree (../)", call: () => ({ name: "edit", arguments: { path: "../outside.txt", edits: [] } }), expect: /outside the project root/ },
	{ name: "write to the evidence log", call: () => ({ name: "write", arguments: { path: join(evidenceDir(), `${FEATURE_BRANCH.replace("/", "-")}.jsonl`), content: "{}" } }), expect: /evidence log is written only by the recorder/ },
	{ name: "edit a child of the evidence dir", call: () => ({ name: "edit", arguments: { path: join(evidenceDir(), "sub", "new.jsonl"), edits: [] } }), expect: /evidence log is written only by the recorder/ },
	{ name: "write the feature document / docs dir", call: () => ({ name: "write", arguments: { path: join(repoDocsDir(ws.repo), "tasks", "x.md"), content: "x" } }), expect: /Blocked by brigadev/ },
	{ name: "write a git hook inside the worktree", call: () => ({ name: "write", arguments: { path: ".git/hooks/pre-commit", content: "#!/bin/sh\n" } }), expect: /protected/ },
	{ name: "read a secret file", call: () => ({ name: "read", arguments: { path: ".env" } }), expect: /may hold secrets/ },
	{ name: "write a secret file inside the worktree", call: () => ({ name: "write", arguments: { path: "config/.env", content: "X=1" } }), expect: /may hold secrets/ },
	{ name: "edit a file inside the worktree", call: () => ({ name: "edit", arguments: { path: "README.md", edits: [{ oldText: "fixture", newText: "x" }] } }), expect: "allow" },
	{ name: "write a new source file inside the worktree", call: () => ({ name: "write", arguments: { path: "src/a.ts", content: "export {};\n" } }), expect: "allow" },
	{ name: "read a file inside the worktree", call: () => ({ name: "read", arguments: { path: "README.md" } }), expect: "allow" },
	{ name: "read the evidence log (reading stays allowed)", call: () => ({ name: "read", arguments: { path: join(evidenceDir(), "b.jsonl") } }), expect: "allow" },

	// bash and evidence: "blocks a bash command that writes to the evidence path", "lets bash read the evidence"
	{ name: "bash appends to the evidence log", call: () => bash(`echo '{}' >> ${evidenceDir()}/feat-x.jsonl`), expect: /evidence log is written only by the recorder/ },
	{ name: "bash tee into the evidence log", call: () => bash(`printf x | tee ${evidenceDir()}/b.jsonl`), expect: /evidence log is written only by the recorder/ },
	{ name: "bash reads the evidence log", call: () => bash(`cat ${evidenceDir()}/b.jsonl`), expect: "allow" },

	// confirm-class commands: no one can answer, so they are denied as "needs you" (Q6; T5 turns them into signals)
	{ name: "rm -rf build", call: () => bash("rm -rf build"), expect: NEEDS_YOU },
	{ name: "rm -rf build says how to get it approved", call: () => bash("rm -rf build"), expect: ASK_HINT },
	{ name: "a worker tool of its own: ask_user_choice needs no rule", call: () => ({ name: "ask_user_choice", arguments: { question: "x", options: [] } }), expect: "allow" },
	{ name: "git reset --hard", call: () => bash("git reset --hard HEAD~1"), expect: NEEDS_YOU },
	{ name: "npm install changes dependencies", call: () => bash("npm install left-pad"), expect: NEEDS_YOU },
	{ name: "sudo", call: () => bash("sudo ls"), expect: NEEDS_YOU },
	{ name: "rm -rf build in yolo still asks", call: () => bash("rm -rf build"), expect: NEEDS_YOU, mode: "yolo" },
	{ name: "rm -rf / is never allowed", call: () => bash("rm -rf /"), expect: /never allowed/ },

	// the runner owns delivery, in every mode
	{ name: "git push", call: () => bash("git push"), expect: DELIVERY },
	{ name: "git push origin HEAD in yolo", call: () => bash("git push origin HEAD"), expect: DELIVERY, mode: "yolo" },
	{ name: "git push --force", call: () => bash("git push --force"), expect: DELIVERY },
	{ name: "git push -f in yolo", call: () => bash("git push -f origin main"), expect: DELIVERY, mode: "yolo" },
	{ name: "git -C . push", call: () => bash("git -C . push"), expect: DELIVERY, mode: "yolo" },
	{ name: "git merge", call: () => bash("git merge main"), expect: DELIVERY, mode: "yolo" },
	{ name: "gh pr merge", call: () => bash("gh pr merge 12 --squash"), expect: DELIVERY },
	{ name: "gh pr create in yolo", call: () => bash("gh pr create --fill"), expect: DELIVERY, mode: "yolo" },
	{ name: "gh pr view", call: () => bash("gh pr view 12"), expect: DELIVERY, mode: "yolo" },
	{ name: "gh -R x/y release create", call: () => bash("gh -R x/y release create v1"), expect: DELIVERY, mode: "yolo" },
	{ name: "gh api -X POST in yolo", call: () => bash("gh api -X POST repos/x/y/issues"), expect: DELIVERY, mode: "yolo" },
	{ name: "npm publish", call: () => bash("npm publish"), expect: DELIVERY },
	{ name: "npm publish in yolo", call: () => bash("npm publish"), expect: DELIVERY, mode: "yolo" },
	{ name: "push after a chain", call: () => bash("npm test && git push"), expect: DELIVERY, mode: "yolo" },
	{ name: "push inside bash -c", call: () => bash("bash -c 'git push origin HEAD'"), expect: DELIVERY, mode: "yolo" },
	{ name: "git pull (fetches and merges)", call: () => bash("git pull"), expect: DELIVERY, mode: "yolo" },
	{ name: "git -C . pull --rebase", call: () => bash("git -C . pull --rebase"), expect: DELIVERY, mode: "yolo" },

	// the gate reads the tree before the command runs: a commit shares its bash call with nothing that writes (T4 open item 1)
	{ name: "write then commit in one call", call: () => bash("echo x >> a.ts && git add -A && git commit -m x"), expect: COMMIT_ALONE, mode: "yolo" },
	{ name: "redirect into a file before a commit", call: () => bash("git status > out.ts; git commit -m x"), expect: COMMIT_ALONE, mode: "yolo" },
	{ name: "sed -i then commit", call: () => bash("sed -i '' s/a/b/ a.ts && git commit -am x"), expect: COMMIT_ALONE, mode: "yolo" },
	{ name: "commit inside bash -c after a write", call: () => bash("bash -c 'touch a.ts && git commit -m x'"), expect: COMMIT_ALONE, mode: "yolo" },
	{ name: "git add && git commit stays allowed", call: () => bash("git add -A && git commit -m x"), expect: "allow", mode: "yolo" },

	// nested calls (a codemode script or another tool: `call.parent`) face the same rules
	{ name: "nested git push", call: () => ({ ...bash("git push"), parent: { taskId: "t1", callId: "c1" } }), expect: DELIVERY },
	{ name: "nested rm -rf build", call: () => ({ ...bash("rm -rf build"), parent: { taskId: "t1", callId: "c1" } }), expect: NEEDS_YOU },
	{ name: "nested write outside the worktree", call: () => ({ name: "write", arguments: { path: "../x", content: "x" }, parent: { taskId: "t1", callId: "c1" } }), expect: /outside the project root/ },
	{ name: "nested npm test", call: () => ({ ...bash("npm test"), parent: { taskId: "t1", callId: "c1" } }), expect: "allow" },

	// unknown tools
	{ name: "unknown tool curl", call: () => ({ name: "curl", arguments: { url: "https://example.com" } }), expect: /unknown tool/ },
	{ name: "codemode is not part of the worker", call: () => ({ name: "codemode", arguments: { code: "1" } }), expect: /unknown tool/ },
	{ name: "bg_start is not part of the worker", call: () => ({ name: "bg_start", arguments: { command: "npm test" } }), expect: /unknown tool/ },

	// ordinary work
	{ name: "npm test", call: () => bash("npm test"), expect: "allow" },
	{ name: "node --test", call: () => bash("node --test tests/a.test.ts"), expect: "allow" },
	{ name: "git status && git diff", call: () => bash("git status && git diff"), expect: "allow" },
	{ name: "non-string command counts as empty", call: () => ({ name: "bash", arguments: { command: 5 } }), expect: "allow" },
	{ name: "a commit on the feature branch with a clean tree", call: () => bash("git commit -m x"), expect: "allow" },
	{ name: "a commit on the feature branch in yolo", call: () => bash("git commit -m x"), expect: "allow", mode: "yolo" },

	// check tool calls are decided like the command they run
	{ name: "check with a push as its command", call: () => ({ name: "check", arguments: { command: "git push" } }), expect: /Blocked by brigadev guard: check runs tests/ },
	{ name: "check with a commit as its command", call: () => ({ name: "check", arguments: { command: "git commit -m x" } }), expect: /Blocked by brigadev guard: check runs tests/ },
	{ name: "check reading a secret", call: () => ({ name: "check", arguments: { command: "cat .env" } }), expect: /may hold secrets/ },
	{ name: "check with a test command", call: () => ({ name: "check", arguments: { command: "npm test", focus: "tests/a.test.ts" } }), expect: "allow" },
	{ name: "check with no command and nothing to detect leaves the error to the tool", call: () => ({ name: "check", arguments: {} }), expect: "allow" },
];

// The table's cases only read the repo and inject their settings, so one repo serves them all, and they run side by side (git is slow to spawn).
describe("worker guard decisions (A1, A4)", { concurrency: 8 }, () => {
	before(() => {
		env.settings({});
		ws = makeWorkspace();
	});
	after(() => ws.cleanup());
	for (const entry of CASES) {
		it(`${entry.expect === "allow" ? "allows" : "blocks"}: ${entry.name}${entry.mode ? ` (${entry.mode})` : ""}`, async () => {
			const reason = await guard({ settings: entry.mode ? { defaultMode: entry.mode } : {} }).decide(entry.call());
			if (entry.expect === "allow") assert.equal(reason, undefined);
			else {
				assert.ok(reason !== undefined, "blocked");
				assert.match(reason, entry.expect);
			}
		});
	}
});

describe("worker guard: settings (A1)", () => {
	fresh();

	it("reads the permission mode from brigadev.json when no settings are injected", async () => {
		env.settings({ defaultMode: "yolo" });
		// Yolo waives the delivery question, not the runner's own rule; and a stored unknown mode is normal.
		assert.match((await createGuard({ cwd: ws.repo }).decide(bash("git push"))) ?? "", DELIVERY);
		env.settings({ defaultMode: "dsp" });
		assert.match((await createGuard({ cwd: ws.repo }).decide(bash("rm -rf build"))) ?? "", NEEDS_YOU);
	});

	it("the check tool's own default command is decided too: check.test from settings", async () => {
		const reason = await guard({ settings: { check: { test: "git push" } } }).decide({ name: "check", arguments: {} });
		assert.match(reason ?? "", /check runs tests/);
	});
});

describe("worker guard: commits (A1, A2)", () => {
	fresh();

	it("a commit off a feature branch is `needs you`, also in yolo (the branch rule holds in every mode)", async () => {
		git(ws.repo, "checkout", "-q", "main");
		for (const settings of [{}, { defaultMode: "yolo" }]) assert.match((await guard({ settings }).decide(bash("git commit -m x"))) ?? "", NEEDS_YOU);
	});

	it("a commit on a detached HEAD is `needs you`", async () => {
		git(ws.repo, "checkout", "-q", "--detach");
		assert.match((await guard().decide(bash("git commit -m x"))) ?? "", NEEDS_YOU);
	});

	it("a commit in another directory is not allowed (`cd` out of the worktree)", async () => {
		assert.match((await guard().decide(bash("cd .. && git commit -m x"))) ?? "", NEEDS_YOU);
	});

	it("the evidence commit gate blocks a commit with an untested source change, and allows it once a passing run is on that tree", async () => {
		writeFileSync(join(ws.repo, "a.ts"), "export const a = 1;\n");
		const blocked = await guard().decide(bash("git add -A && git commit -m x"));
		assert.match(blocked ?? "", /Blocked by brigadev evidence gate: no passing test is recorded/);
		// A docs-only change needs no test run (the gate's own rule, so the runner and the extension agree).
		git(ws.repo, "add", "-A");
		git(ws.repo, "commit", "-q", "-m", "src");
		writeFileSync(join(ws.repo, "NOTES.md"), "notes\n");
		assert.equal(await guard().decide(bash("git add -A && git commit -m notes")), undefined);
	});

	it("the gate reads the same evidence file as the extension: <docs>/evidence/<branch>.jsonl of the repo", async () => {
		const { appendEvidence, buildRunRecord } = await import("../../lib/evidence.ts");
		const { worktreeTreeResult } = await import("../../lib/worktree-tree.ts");
		writeFileSync(join(ws.repo, "a.ts"), "export const a = 1;\n");
		const result = await worktreeTreeResult(ws.repo, { sourceTree: true });
		assert.equal(result.kind, "tree");
		if (result.kind !== "tree") return;
		const record = buildRunRecord({ ts: new Date().toISOString(), branch: FEATURE_BRANCH, tree: result.tree, srcTree: result.sourceTree, cwd: ws.repo, topLevel: result.root, agent: "parent", command: "npm test", exitCode: 0, output: "" });
		record.kind = "test";
		record.outcome = "pass";
		appendEvidence(evidenceFile(repoDocsDir(ws.repo), FEATURE_BRANCH), record);
		assert.equal(await guard().decide(bash("git add -A && git commit -m x")), undefined);
	});

	it("a force record in the log does not let the worker through (only a passing run on the tree does)", async () => {
		writeFileSync(join(ws.repo, "a.ts"), "export const a = 1;\n");
		const file = evidenceFile(repoDocsDir(ws.repo), FEATURE_BRANCH);
		mkdirSync(join(file, ".."), { recursive: true });
		appendFileSync(file, `${JSON.stringify({ v: 1, type: "force", ts: new Date().toISOString(), branch: FEATURE_BRANCH, via: "command", command: "git commit" })}\n`);
		assert.match((await guard().decide(bash("git add -A && git commit -m x"))) ?? "", /evidence gate/);
	});
});

describe("worker guard: a throwing decision blocks (A1)", () => {
	fresh();

	it("fails closed: the hook returns a block when the rules cannot decide", async () => {
		const extension = guardExtension({ cwd: ws.repo, settings: () => { throw new Error("settings exploded"); } });
		const hooks = extension.hooks as Array<{ handlers: { beforeTool?: (call: unknown, api: unknown, context: unknown) => Promise<{ block?: string } | undefined> } }>;
		const result = await hooks[0].handlers.beforeTool!({ name: "bash", arguments: { command: "npm test" } }, {}, BACKGROUND_CONTEXT);
		assert.match(result?.block ?? "", /could not decide.*settings exploded/);
	});
});

describe("the hook reaches nested calls (call.parent) inside the Harness (A1)", () => {
	fresh();

	it("a tool that runs bash through executeTool is blocked by the same rules, an ordinary nested call is not", async () => {
		const nested: NestedToolExecutionResult[] = [];
		const probe = defineTool({
			name: "probe",
			description: "Run a command as a nested bash call",
			parameters: obj({ command: str() }),
			execute: async (args, api, context) => {
				nested.push(await api.executeTool("bash", { command: args.command }, context, { progress: false }));
				return { output: [{ type: "text", text: "probed" }] };
			},
		});
		const faux = fauxProvider({ models: [{ id: "probe" }] });
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall("probe", { command: "git push origin HEAD" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("probe", { command: "echo nested-ok" })], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("bash", { command: "git push" })], { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxText("done")),
		]);
		const models = createModels();
		models.setProvider(faux.provider);
		const model = faux.getModel();
		const registry = createRegistry();
		registry.install(CodingTools);
		registry.install(guardExtension({ cwd: ws.repo, tools: ["bash", "probe"] })); // the probe is the test's stand-in for a codemode script
		registry.install(defineExtension({ name: "probe", tools: [probe] }));
		const harness = await Harness.open(new MemoryStorage(), { models, registry, env: (target) => new NodeExecutionEnv({ cwd: target.cwd ?? ws.repo }) }, BACKGROUND_CONTEXT);
		try {
			const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id }, cwd: ws.repo, tools: [...(CodingTools.tools ?? []), probe] } });
			const submission = await root.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
			const settled = await submission.wait(BACKGROUND_CONTEXT);
			assert.equal(settled.status, "done", JSON.stringify(settled));
		} finally {
			await harness.close(BACKGROUND_CONTEXT);
		}
		assert.equal(nested.length, 2);
		assert.equal(nested[0].isError, true, "the nested push is blocked");
		assert.match(JSON.stringify(nested[0].diagnostics), /the runner owns PR delivery/);
		assert.equal(nested[1].isError, false, "an ordinary nested call runs");
		assert.match(JSON.stringify(nested[1].structuredOutput), /nested-ok/);
	});
});

// T6 (A4): the verify conversation's rules. Its calls are decided by a read-only guard: `read`, `bash`, and the verdict tool only; nothing writes inside the worktree.
const READ_ONLY = /verifier is read-only/;
const VERIFY_CASES: Case[] = [
	{ name: "read a file", call: () => ({ name: "read", arguments: { path: "README.md" } }), expect: "allow" },
	{ name: "read a secret still blocked", call: () => ({ name: "read", arguments: { path: ".env" } }), expect: /may hold secrets/ },
	{ name: "the verdict tool", call: () => ({ name: "verify_verdict", arguments: {} }), expect: "allow" },
	{ name: "write is not a verifier tool", call: () => ({ name: "write", arguments: { path: "a.ts", content: "x" } }), expect: /unknown tool write/ },
	{ name: "edit is not a verifier tool", call: () => ({ name: "edit", arguments: { path: "a.ts", edits: [] } }), expect: /unknown tool edit/ },
	{ name: "check and ask_user_choice are worker tools", call: () => ({ name: "check", arguments: {} }), expect: /unknown tool check/ },
	{ name: "git commit", call: () => bash("git commit -m x"), expect: READ_ONLY },
	{ name: "git commit --allow-empty in bash -c", call: () => bash("bash -c 'git commit --allow-empty -m x'"), expect: READ_ONLY },
	{ name: "git add", call: () => bash("git add -A"), expect: READ_ONLY },
	{ name: "git checkout", call: () => bash("git checkout -b other"), expect: READ_ONLY },
	{ name: "git stash", call: () => bash("git stash"), expect: READ_ONLY },
	{ name: "git worktree add", call: () => bash("git worktree add ../w"), expect: READ_ONLY },
	{ name: "git -C . reset", call: () => bash("git -C . reset --hard"), expect: READ_ONLY },
	{ name: "a redirect into the worktree", call: () => bash("echo x > a.ts"), expect: READ_ONLY },
	{ name: "tee into the worktree", call: () => bash("echo x | tee src/a.ts"), expect: READ_ONLY },
	{ name: "cp into the worktree", call: () => bash("cp /etc/hosts ./hosts.copy"), expect: READ_ONLY },
	{ name: "git push is blocked", call: () => bash("git push"), expect: READ_ONLY },
	{ name: "git status && git diff", call: () => bash("git status && git diff main...HEAD"), expect: "allow" },
	{ name: "git log", call: () => bash("git log --oneline -5"), expect: "allow" },
	{ name: "npm test", call: () => bash("npm test"), expect: "allow" },
	{ name: "a scratch copy outside the worktree", call: () => bash("S=$(mktemp -d) && rsync -a --exclude .git ./ \"$S/work/\" && echo hi > /tmp/brigadev-verify-probe.txt"), expect: "allow" },
];

describe("verify guard: read-only (A4)", { concurrency: 8 }, () => {
	before(() => {
		env.settings({});
		ws = makeWorkspace();
	});
	after(() => ws.cleanup());
	for (const entry of VERIFY_CASES) {
		it(`${entry.expect === "allow" ? "allows" : "blocks"}: ${entry.name}`, async () => {
			const reason = await createGuard({ cwd: ws.repo, readOnly: true, settings: () => ({}) }).decide(entry.call());
			if (entry.expect === "allow") assert.equal(reason, undefined);
			else {
				assert.ok(reason !== undefined, "blocked");
				assert.match(reason, entry.expect);
			}
		});
	}
});
