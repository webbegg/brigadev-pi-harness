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
const VERIFY_EXTRA_CASES: Case[] = [
	// B1 (R1-001): a git flag that writes or runs a program, an interpreter with inline code
	{ name: "git diff --output=file", call: () => bash("git diff --output=out.patch"), expect: READ_ONLY },
	{ name: "git diff --output file", call: () => bash("git diff main --output out.patch"), expect: READ_ONLY },
	{ name: "git log --ext-diff", call: () => bash("git log -p --ext-diff"), expect: READ_ONLY },
	{ name: "git show --textconv", call: () => bash("git show --textconv HEAD:README.md"), expect: READ_ONLY },
	{ name: "git diff --ext-diff", call: () => bash("git diff --ext-diff"), expect: READ_ONLY },
	{ name: "python3 -c", call: () => bash("python3 -c \"open('a.ts','w').write('x')\""), expect: READ_ONLY },
	{ name: "python -c", call: () => bash("python -c 'print(1)'"), expect: READ_ONLY },
	{ name: "node -e", call: () => bash("node -e \"require('fs').writeFileSync('a','x')\""), expect: READ_ONLY },
	{ name: "node --eval", call: () => bash("node --eval 1"), expect: READ_ONLY },
	{ name: "node -p", call: () => bash("node -p 1"), expect: READ_ONLY },
	{ name: "perl -e", call: () => bash("perl -e 'print 1'"), expect: READ_ONLY },
	{ name: "perl -pi -e", call: () => bash("perl -pi -e 's/a/b/' README.md"), expect: READ_ONLY },
	{ name: "ruby -e", call: () => bash("ruby -e 'puts 1'"), expect: READ_ONLY },
	{ name: "inside bash -c", call: () => bash("bash -c \"python3 -c 'print(1)'\""), expect: READ_ONLY },
	{ name: "an interpreter on a script file is allowed", call: () => bash("python3 probe.py && node probe.js"), expect: "allow" },
];
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
	for (const entry of [...VERIFY_CASES, ...VERIFY_EXTRA_CASES]) {
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

// B1/B3 (the first layer; best effort, see runner/README.md "What containment cannot stop"): the spellings of the ledger's repros, for the worker and the verifier
// alike. Each is blocked with a reason; ordinary commands still pass.
/** The string layer's reason, or the delivery rule's (`gh api` with fields was already one): both are blocks with a reason. */
const CONTAINED = /Blocked by brigadev (guard|runner): /;
const BLOCKED_BOTH: Array<[string, string]> = [
	// git: -c and --config-env, config writes
	["git -c alias (the ledger's B1 repro)", "git -c alias.p=push p origin HEAD:refs/heads/aliased"],
	["git -c alias commit (B3)", "git -c alias.c=commit c -m x"],
	["git -c core.fsmonitor", "git -c core.fsmonitor=/tmp/x status"],
	["git -C . -c", "git -C . -c core.hooksPath=/tmp/h status"],
	["git --config-env", "git --config-env=alias.p=PUSHALIAS p"],
	["git config alias", "git config alias.p push"],
	["git config key value", "git config user.name x"],
	["git config --add", "git config --add remote.origin.pushurl https://evil/x.git"],
	["git config --unset", "git config --unset core.hooksPath"],
	["git config --global alias", "git config --global alias.x 'push -f'"],
	["git config --global read", "git config --global --get user.email"],
	["git config --system", "git config --system --list"],
	["git config --file", "git config --file ../x.cfg core.x y"],
	["git config --local key value", "git config --local core.hooksPath /tmp/h"],
	["bash -c git -c", "bash -c 'git -c alias.p=push p origin HEAD'"],
	["absolute git path -c", "/usr/bin/git -c x.y=z status"],
	["env git -c", "env git -c x.y=z status"],
	["git -c in a chain", "npm test && git -c alias.p=push p"],
	// git plumbing that writes refs or remotes
	["git update-ref", "git update-ref refs/heads/main HEAD"],
	["git send-pack --force (the ledger's B1 repro)", "git send-pack --force /tmp/remote.git HEAD:refs/heads/main"],
	["git http-push", "git http-push https://x/y.git HEAD"],
	["git commit-tree", "git commit-tree HEAD^{tree} -m x"],
	["git reset --soft $(git commit-tree) (B3)", "git reset --soft $(git commit-tree HEAD^{tree} -p HEAD -m forged)"],
	["git reset --soft `git commit-tree` (B3)", "git reset --soft `git commit-tree HEAD^{tree} -p HEAD -m forged`"],
	["git symbolic-ref HEAD <ref>", "git symbolic-ref HEAD refs/heads/main"],
	["git symbolic-ref -d", "git symbolic-ref -d HEAD"],
	["git remote add", "git remote add evil https://evil/x.git"],
	["git remote set-url", "git remote set-url origin https://evil/x.git"],
	["git fetch into a local branch", "git fetch . HEAD:refs/heads/main"],
	["git branch -f", "git branch -f main HEAD"],
	["git checkout -B", "git checkout -B main HEAD"],
	["git credential", "git credential fill"],
	["git credential-osxkeychain", "git credential-osxkeychain get"],
	// gh api writes in every spelling, graphql, and the commands that change gh itself
	["gh api -XPUT (the ledger's B1 repro)", "gh api -XPUT repos/o/r/pulls/1/merge"],
	["gh api -X PUT", "gh api -X PUT repos/o/r/pulls/1/merge"],
	["gh api -X post lowercase", "gh api -X post repos/o/r/issues"],
	["gh api --method PUT", "gh api --method PUT repos/o/r/pulls/1/merge"],
	["gh api --method=DELETE", "gh api --method=DELETE repos/o/r/git/refs/heads/x"],
	["gh api after the endpoint", "gh api repos/o/r/issues/1 -X PATCH"],
	["gh api --input", "gh api repos/o/r/issues --input body.json"],
	["gh api --input=", "gh api repos/o/r/issues --input=body.json"],
	["gh api -f", "gh api repos/o/r/issues -f title=x"],
	["gh api -ftitle=x", "gh api repos/o/r/issues -ftitle=x"],
	["gh api -F", "gh api repos/o/r/issues -F draft=true"],
	["gh api --field", "gh api repos/o/r/issues --field title=x"],
	["gh api --field=", "gh api repos/o/r/issues --field=title=x"],
	["gh api --raw-field", "gh api repos/o/r/issues --raw-field title=x"],
	["gh api graphql", "gh api graphql -f query='mutation{x}'"],
	["gh api graphql without a body flag", "gh api graphql"],
	["gh -R o/r api -XPUT", "gh -R o/r api -XPUT repos/o/r/pulls/1/merge"],
	["gh alias set", "gh alias set pm 'pr merge'"],
	["gh extension install", "gh extension install x/gh-evil"],
	["gh auth login", "gh auth login --with-token"],
	["gh auth token", "gh auth token"],
	// credential and containment variables, inline or exported
	["GH_CONFIG_DIR inline", "GH_CONFIG_DIR=/tmp/other gh api user"],
	["GH_TOKEN inline", "GH_TOKEN=x gh api user"],
	["GITHUB_TOKEN inline", "GITHUB_TOKEN=x npm test"],
	["GIT_SSH_COMMAND inline", "GIT_SSH_COMMAND='ssh -i /tmp/k' git status"],
	["GIT_SSH inline", "GIT_SSH=/tmp/ssh git status"],
	["GIT_CONFIG_COUNT inline", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0=push git p"],
	["GIT_CONFIG_PARAMETERS inline", "GIT_CONFIG_PARAMETERS=\"'alias.p=push'\" git p"],
	["GIT_ASKPASS inline", "GIT_ASKPASS=/tmp/a git status"],
	["SSH_AUTH_SOCK inline", "SSH_AUTH_SOCK=/tmp/s ssh -T git@github.com"],
	["SSH_ASKPASS inline", "SSH_ASKPASS=/tmp/a ssh x"],
	["HOME inline", "HOME=/tmp/h git status"],
	["env GH_TOKEN", "env GH_TOKEN=x gh api user"],
	["env -u GH_CONFIG_DIR", "env -u GH_CONFIG_DIR gh api user"],
	["export GH_TOKEN", "export GH_TOKEN=abc"],
	["export then use", "export GIT_SSH_COMMAND='ssh -i /tmp/k'; git status"],
	["unset GH_CONFIG_DIR", "unset GH_CONFIG_DIR"],
	["declare -x HOME", "declare -x HOME=/tmp/h"],
	["a variable inside bash -c", "bash -c 'GH_TOKEN=x gh api user'"],
	// credential stores by name
	["security (macOS keychain cli)", "security find-generic-password -s github.com -w"],
	["/usr/bin/security", "/usr/bin/security dump-keychain"],
	[".git-credentials", "cat ~/.git-credentials"],
	[".netrc", "cat ~/.netrc"],
	[".config/gh/hosts.yml", "cat ~/.config/gh/hosts.yml"],
	["ls .config/gh", "ls ~/.config/gh"],
	["hosts.yml", "grep oauth_token hosts.yml"],
	// a shell fed a program the guard cannot read
	["bash <<EOF", "bash <<EOF\ngit push origin HEAD\nEOF"],
	["sh <<'EOF'", "sh <<'EOF'\ngit update-ref refs/heads/main HEAD\nEOF"],
	["zsh here-string", "zsh <<< 'git push'"],
	["cat <<EOF | sh", "cat <<EOF | sh\ngit push\nEOF"],
	["echo | sh", "echo git push | sh"],
	["echo | bash", "echo 'git push' | bash"],
	["bare shell", "sh"],
	["bash -s", "bash -s"],
];

const ALLOWED_BOTH: Array<[string, string]> = [
	["git status", "git status"],
	["git diff", "git diff main...HEAD"],
	["git log", "git log --oneline -5"],
	["git remote -v", "git remote -v"],
	["git symbolic-ref (read)", "git symbolic-ref --short HEAD"],
	["git branch -a", "git branch -a"],
	["gh api GET", "gh api repos/o/r/pulls/1"],
	["gh api -X GET", "gh api -X GET repos/o/r/pulls/1"],
	["gh api --method=GET", "gh api --method=GET repos/o/r/pulls/1"],
	["gh api -XGET", "gh api -XGET repos/o/r/pulls/1 --jq .state"],
	["npm test", "npm test"],
	["node --test", "node --test tests/a.test.ts"],
	["a script file in a shell", "sh scripts/build.sh"],
	["a script file with flags", "bash -x scripts/build.sh"],
	["bash -c of an ordinary command", "bash -c 'npm test'"],
	["an assignment of an ordinary variable", "NODE_ENV=test npm test"],
	["a heredoc to cat (a commit message)", "cat <<EOF\nnotes\nEOF"],
	["a pipe to grep", "git log --oneline | grep fix"],
	["export of an ordinary variable", "export NODE_ENV=test"],
];

const ALLOWED_WORKER: Array<[string, string]> = [
	["git commit on the feature branch", "git commit -m x"],
	["a commit message that mentions git config", "git commit -m 'document git config and gh api usage'"],
	["git config read: one key", "git config user.name"],
	["git config --get", "git config --get user.email"],
	["git config --list", "git config --list"],
	["git branch new-name", "git branch spike"],
	["git checkout -b", "git checkout -b feat/other"],
	["git fetch origin", "git fetch origin"],
	["git reset --soft HEAD~1", "git reset --soft HEAD~1"],
	["python3 -c in the worker", "python3 -c 'print(1)'"],
	["node -e in the worker", "node -e 'console.log(1)'"],
];

describe("containment: the string layer (B1, B3; best effort)", { concurrency: 8 }, () => {
	before(() => {
		env.settings({});
		ws = makeWorkspace();
	});
	after(() => ws.cleanup());
	const readOnly = () => createGuard({ cwd: ws.repo, readOnly: true, settings: () => ({}) });
	const worker = (mode?: "yolo") => createGuard({ cwd: ws.repo, settings: () => (mode ? { defaultMode: mode } : {}) });
	for (const [name, command] of BLOCKED_BOTH) {
		it(`blocks for the worker: ${name}`, async () => {
			const reason = await worker().decide(bash(command));
			assert.ok(reason !== undefined, `not blocked: ${command}`);
			assert.match(reason, CONTAINED);
		});
		it(`blocks for the worker in yolo: ${name}`, async () => {
			assert.ok((await worker("yolo").decide(bash(command))) !== undefined, `not blocked in yolo: ${command}`);
		});
		it(`blocks for the verifier: ${name}`, async () => {
			assert.ok((await readOnly().decide(bash(command))) !== undefined, `not blocked for the verifier: ${command}`);
		});
	}
	for (const [name, command] of ALLOWED_BOTH) {
		it(`still allows for the worker: ${name}`, async () => assert.equal(await worker().decide(bash(command)), undefined));
	}
	for (const [name, command] of ALLOWED_BOTH.filter(([, command]) => !/^(gh api|git branch|git remote|git symbolic-ref|a script|bash|sh |NODE_ENV|export|cat|node --test|npm)/.test(command))) {
		it(`still allows for the verifier: ${name}`, async () => assert.equal(await readOnly().decide(bash(command)), undefined));
	}
	for (const [name, command] of ALLOWED_WORKER) {
		it(`still allows for the worker: ${name}`, async () => assert.equal(await worker().decide(bash(command)), undefined));
	}
	it("`gh pr view` is unchanged: the runner owns PR commands, so it stays a delivery block", async () => {
		assert.match((await worker("yolo").decide(bash("gh pr view 12"))) ?? "", DELIVERY);
	});
	it("a worker-side check tool whose command is a forbidden spelling is blocked too", async () => {
		const reason = await createGuard({ cwd: ws.repo, settings: () => ({}) }).decide({ name: "check", arguments: { command: "GH_TOKEN=x npm test" } });
		assert.match(reason ?? "", CONTAINED);
	});
});
