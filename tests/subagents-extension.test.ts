// extensions/subagents.ts loaded for real, against recording fakes of Pi's API (tests/helpers). Pi's runtime packages are
// stubbed by a test-only module loader; children are a fake `pi --mode json` script, never real Pi.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { newRunId, runsDir } from "../lib/run-artifacts.ts";
import { createFakeCtx, createFakePi, type FakeCtx, type FakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const DAY = 86_400_000;
const FAKE_CHILD = path.join(import.meta.dirname, "helpers", "fake-pi-json.mjs");

let root: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;
let savedArgv1: string | undefined;
let uninstall: () => void;
let extension: (pi: any) => void;

before(async () => {
	// The extension is inert in a child session (BRIGADEV_CHILD=1), and the writer that runs this test is one: start from no BRIGADEV_* at all.
	savedEnv = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
	root = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-ext-"));
	cwd = path.join(root, "proj");
	fs.mkdirSync(cwd);
	process.env.BRIGADEV_HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	uninstall = installPiStubs();
	extension = (await import("../extensions/subagents.ts")).default;
});

after(() => {
	uninstall();
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	if (savedArgv1 !== undefined) process.argv[1] = savedArgv1;
	fs.rmSync(root, { recursive: true, force: true });
});

const load = (options: { hasUI?: boolean; idle?: boolean } = {}): { pi: FakePi; ctx: FakeCtx } => {
	const pi = createFakePi();
	extension(pi);
	return { pi, ctx: createFakeCtx({ cwd, ...options }) };
};
const docsRuns = () => runsDir(repoDocsDir(cwd));
const text = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join("\n");

describe("registration", () => {
	it("registers the subagent tool and the read-only viewer, nothing async", () => {
		const { pi } = load();
		assert.deepEqual([...pi.tools.keys()], ["subagent"]);
		assert.ok(pi.commands.has("brigadev:runs"));
		assert.ok(pi.commands.has("brigadev:agents"));
		assert.ok(!pi.commands.has("btw"));
		assert.deepEqual([...pi.shortcuts.keys()].sort(), ["alt+a", "ctrl+shift+a"]);
		assert.equal(pi.renderers.size, 0, "no result message is ever injected into the conversation");
		for (const event of ["session_start", "session_shutdown", "before_agent_start"]) assert.ok(pi.handlers.has(event), event);
		assert.ok(!pi.handlers.has("agent_settled"), "no idle delivery");
	});

	it("registers nothing in a child session", () => {
		process.env.BRIGADEV_CHILD = "1";
		try {
			const { pi } = load();
			assert.equal(pi.tools.size, 0);
			assert.equal(pi.handlers.size, 0);
		} finally {
			delete process.env.BRIGADEV_CHILD;
		}
	});
});

describe("tool schema", () => {
	it("subagent: the launch fields and parallel tasks, no async flag, every field optional", () => {
		const schema = load().pi.tool("subagent").parameters;
		assert.deepEqual(Object.keys(schema.properties).sort(), ["agent", "allowedEditSurfaces", "featureDoc", "reason", "skills", "task", "tasks"]);
		assert.equal(schema.required, undefined, "single and parallel calls share one schema; every field is optional");
	});
});

describe("sync launches end to end (fake JSON child)", () => {
	const withFakeChild = async (body: (h: { pi: FakePi; ctx: FakeCtx }) => Promise<void>) => {
		fs.rmSync(repoDocsDir(cwd), { recursive: true, force: true });
		// The extension's own `piInvocation` runs process.argv[1] with node: that script is the fake child.
		savedArgv1 = process.argv[1];
		process.argv[1] = FAKE_CHILD;
		const h = load({ hasUI: true, idle: true });
		try {
			await h.pi.fire("session_start", { reason: "startup" }, h.ctx);
			await body(h);
		} finally {
			await h.pi.fire("session_shutdown", {}, h.ctx);
			process.argv[1] = savedArgv1;
		}
	};

	it("a single launch returns the child's answer when it ends, and saves its run folder", { timeout: 60_000 }, async () => {
		await withFakeChild(async ({ pi, ctx }) => {
			const result = await pi.tool("subagent").execute("t", { agent: "brigadev-explore", task: "alpha", reason: "independent units" }, undefined, undefined, ctx);
			assert.notEqual(result.isError, true, text(result));
			const [folder] = fs.readdirSync(docsRuns());
			assert.equal(text(result), `alpha\nsmall result\n\nFull result: ${path.join(docsRuns(), folder, "result.json")}`);
			assert.equal(result.details.results[0].exitCode, 0);
			assert.equal(fs.readdirSync(docsRuns()).length, 1, "one run folder");
			assert.equal(pi.messages.length, 0, "nothing is delivered later: the call itself returned the result");
		});
	});

	it("S12: a long answer reaches the parent compacted, names the saved result, and the full text is in the run folder", { timeout: 60_000 }, async () => {
		await withFakeChild(async ({ pi, ctx }) => {
			// The fake child answers with the first line of the task, then "small result".
			const long = `HEAD${"a".repeat(40_000)}`;
			const result = await pi.tool("subagent").execute("t", { agent: "brigadev-explore", task: long, reason: "independent units" }, undefined, undefined, ctx);
			const [folder] = fs.readdirSync(docsRuns());
			const full = path.join(docsRuns(), folder, "result.json");
			assert.ok(text(result).length < 9_000, `tool result is ${text(result).length} chars`);
			assert.match(text(result), /^HEAD/);
			assert.match(text(result), /small result/);
			assert.match(text(result), /chars omitted/);
			assert.ok(text(result).endsWith(`Full result: ${full}`));
			const saved = JSON.parse(fs.readFileSync(full, "utf8"));
			assert.ok(saved.output.length > 40_000, "the full text is saved");
			assert.ok(saved.finalText.length > 40_000);
			assert.ok(result.details.results[0].messages.length > 0, "details keep the full run for the viewer");
		});
	});

	it("parallel tasks run together and come back in one result", { timeout: 60_000 }, async () => {
		await withFakeChild(async ({ pi, ctx }) => {
			const tasks = ["alpha", "beta"].map((task) => ({ agent: "brigadev-explore", task, reason: "independent units" }));
			const result = await pi.tool("subagent").execute("t", { tasks }, undefined, undefined, ctx);
			assert.match(text(result), /^Parallel: 2\/2 succeeded/);
			assert.match(text(result), /alpha\nsmall result/);
			assert.match(text(result), /beta\nsmall result/);
			assert.equal(fs.readdirSync(docsRuns()).length, 2);
			assert.equal(text(result).split("Full result: ").length, 3, "each section names its saved result");
		});
	});

	it("a rate-limited model is reported as a failure that names the limit, with no retry on another model", { timeout: 60_000 }, async () => {
		await withFakeChild(async ({ pi, ctx }) => {
			const result = await pi.tool("subagent").execute("t", { agent: "brigadev-explore", task: "LIMIT please", reason: "independent units" }, undefined, undefined, ctx);
			assert.equal(result.isError, true);
			assert.match(text(result), /^Agent error: 429 rate limit exceeded/);
			assert.match(text(result), /Warnings: brigadev-explore: .* hit a quota or rate limit\. No other model was tried/);
			assert.equal(fs.readdirSync(docsRuns()).length, 1, "a single run, not a chain");
			assert.deepEqual(pi.entries, [], "no fallback record");
		});
	});

	it("an unknown agent is rejected before anything starts", async () => {
		const { pi, ctx } = load();
		const result = await pi.tool("subagent").execute("t", { agent: "nope", task: "x", reason: "independent units" }, undefined, undefined, ctx);
		assert.equal(result.isError, true);
		assert.match(text(result), /Launch rejected/);
	});
});

describe("session_start run-folder pruning", () => {
	const makeRun = (name: string) => {
		fs.mkdirSync(path.join(docsRuns(), name), { recursive: true });
		fs.writeFileSync(path.join(docsRuns(), name, "result.json"), "{}");
	};
	const reset = () => fs.rmSync(repoDocsDir(cwd), { recursive: true, force: true });
	const old = () => newRunId("scout", Date.now() - 30 * DAY, () => "aaaaaa");
	const fresh = () => newRunId("scout", Date.now() - DAY, () => "bbbbbb");

	it("removes a run folder older than 14 days and keeps the recent one and foreign entries", async () => {
		reset();
		const [oldId, freshId] = [old(), fresh()];
		makeRun(oldId);
		makeRun(freshId);
		fs.mkdirSync(path.join(docsRuns(), "not-a-run-id"));
		fs.writeFileSync(path.join(repoDocsDir(cwd), "notes.md"), "keep");
		const { pi, ctx } = load();
		await pi.fire("session_start", { reason: "startup" }, ctx);
		assert.deepEqual(fs.readdirSync(docsRuns()).sort(), [freshId, "not-a-run-id"].sort());
		assert.equal(fs.readFileSync(path.join(repoDocsDir(cwd), "notes.md"), "utf8"), "keep");
		assert.deepEqual(ctx.notifications, [], "a clean prune says nothing");
	});

	it("a session without a runs folder starts quietly", async () => {
		reset();
		const { pi, ctx } = load();
		await pi.fire("session_start", { reason: "startup" }, ctx);
		assert.deepEqual(ctx.notifications, []);
	});

	// Removal fails for real: a read-only runs folder cannot give up its entries. Not meaningful for root.
	const unremovable = { skip: typeof process.getuid === "function" && process.getuid() === 0 ? "root ignores directory permissions" : false };

	it("S7: prune errors are one UI warning with the count and the first error, once per session start", unremovable, async () => {
		reset();
		makeRun(old());
		makeRun(newRunId("scout", Date.now() - 40 * DAY, () => "cccccc"));
		fs.chmodSync(docsRuns(), 0o555);
		try {
			const { pi, ctx } = load({ hasUI: true });
			await pi.fire("session_start", { reason: "startup" }, ctx);
			const warnings = ctx.notifications.filter((n) => n.type === "warning");
			assert.equal(ctx.notifications.length, 1, "exactly one notification");
			assert.equal(warnings.length, 1);
			assert.match(warnings[0].message, /^brigadev: 2 problems while pruning old run folders; first: /);
			assert.match(warnings[0].message, /(EACCES|EPERM|permission)/i);
		} finally {
			fs.chmodSync(docsRuns(), 0o755);
		}
	});

	it("S7: with no UI the prune errors are not shown", unremovable, async () => {
		reset();
		makeRun(old());
		fs.chmodSync(docsRuns(), 0o555);
		try {
			const { pi, ctx } = load({ hasUI: false });
			await pi.fire("session_start", { reason: "startup" }, ctx);
			assert.deepEqual(ctx.notifications, []);
		} finally {
			fs.chmodSync(docsRuns(), 0o755);
		}
	});

	it("the handler never throws, even when the warning cannot be shown", unremovable, async () => {
		reset();
		makeRun(old());
		fs.chmodSync(docsRuns(), 0o555);
		try {
			const { pi, ctx } = load({ hasUI: true });
			let notifyCalls = 0;
			(ctx.ui as any).notify = () => {
				notifyCalls++;
				throw new Error("stale context");
			};
			await assert.doesNotReject(pi.fire("session_start", { reason: "startup" }, ctx));
			assert.equal(notifyCalls, 1, "the prune-error warning was attempted once, so the throwing path really ran");
		} finally {
			fs.chmodSync(docsRuns(), 0o755);
		}
	});
});

// S6-S8: the verify evidence record, the verify budget, and the recheck route, against a real git repository and a fake
// child that answers brigadev-verify with a structured result (the task text picks it: BLOCKERS, FAIL).
describe("brigadev-verify evidence, budget, and recheck route (S6-S8)", () => {
	const CHILD_SOURCE = `
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const message = (extra) => ({ role: "assistant", content: [{ type: "text", text: "" }], provider: "p", model: "m", usage, ...extra });
const task = String(process.argv.at(-1));
const blockers = task.includes("BLOCKERS") ? [{ summary: "a", reproduction: "r" }, { summary: "b", reproduction: "r" }] : [];
const payload = { verdicts: [{ spec: "S1", verdict: "met", evidence: "e" }], blockers, advisories: [], regressionTests: [], scratch: [], unverified: [] };
line({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
line({ type: "agent_start" });
if (task.includes("FAIL")) line({ type: "message_end", message: message({ content: [], stopReason: "error", errorMessage: "boom" }) });
else {
	line({ type: "message_end", message: message({ content: [{ type: "toolCall", id: "c1", name: "structured_output", arguments: payload }], stopReason: "toolUse" }) });
	line({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "structured_output", isError: false, content: [{ type: "text", text: "ok" }] } });
	line({ type: "message_end", message: message({ content: [{ type: "text", text: "done" }], stopReason: "stop" }) });
}
line({ type: "agent_end", messages: [], willRetry: false });
line({ type: "agent_settled", aborted: false });
`;
	let repo: string;
	let childScript: string;
	let evidence: typeof import("../lib/evidence.ts");
	let treeLib: typeof import("../lib/worktree-tree.ts");
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: repo, encoding: "utf8" });
	const profilesFile = () => path.join(process.env.PI_CODING_AGENT_DIR!, "brigadev-profiles.json");

	before(async () => {
		repo = fs.mkdtempSync(path.join(root, "verify-repo-"));
		git("init", "-q", "-b", "feat/x");
		fs.writeFileSync(path.join(repo, "a.ts"), "1\n");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
		childScript = path.join(root, "fake-verify-child.mjs");
		fs.writeFileSync(childScript, CHILD_SOURCE);
		evidence = await import("../lib/evidence.ts");
		treeLib = await import("../lib/worktree-tree.ts");
	});

	const logFile = () => evidence.evidenceFile(repoDocsDir(repo), "feat/x");
	const records = () => evidence.readEvidence(logFile()).filter((r): r is import("../lib/evidence.ts").VerifyRecord => r.type === "verify");
	const srcTree = async () => {
		const result = await treeLib.worktreeTreeResult(repo, { sourceTree: true });
		assert.equal(result.kind, "tree");
		return result.kind === "tree" ? result.sourceTree : undefined;
	};
	const reset = () => {
		fs.rmSync(repoDocsDir(repo), { recursive: true, force: true });
		fs.rmSync(profilesFile(), { force: true });
		git("checkout", "-q", "--", ".");
	};

	const withVerify = async (options: { hasUI?: boolean }, body: (h: { pi: FakePi; ctx: FakeCtx; verify: (reason: string, task?: string) => Promise<any> }) => Promise<void>) => {
		reset();
		savedArgv1 = process.argv[1];
		process.argv[1] = childScript;
		const pi = createFakePi();
		extension(pi);
		pi.exec = async (command, args, opts) => {
			try {
				return { stdout: execFileSync(command, args, { cwd: (opts as { cwd: string }).cwd, encoding: "utf8" }), stderr: "", code: 0, killed: false };
			} catch (error: any) {
				return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1, killed: false };
			}
		};
		const ctx = createFakeCtx({ cwd: repo, hasUI: options.hasUI ?? false, idle: true });
		const verify = (reason: string, task = "verify S1") => pi.tool("subagent").execute("t", { agent: "brigadev-verify", task, reason }, undefined, undefined, ctx);
		try {
			await pi.fire("session_start", { reason: "startup" }, ctx);
			await body({ pi, ctx, verify });
		} finally {
			await pi.fire("session_shutdown", {}, ctx);
			process.argv[1] = savedArgv1;
		}
	};

	const seed = (over: Partial<import("../lib/evidence.ts").VerifyRecord>) =>
		evidence.appendEvidence(logFile(), { v: 1, type: "verify", ts: "2026-11-19T10:00:00.000Z", branch: "feat/x", tree: "old", srcTree: "old", root: repo, runId: "seed", scope: "branch", categories: ["security"], blockers: [], outcome: "clean", ...over });

	it("S6: a finished verify appends one record keyed to the branch and the source tree", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			const result = await verify("Risk: security (guard)");
			assert.notEqual(result.isError, true, text(result));
			const [record, ...rest] = records();
			assert.equal(rest.length, 0);
			assert.deepEqual([record.scope, record.outcome, record.blockers, record.categories, record.branch], ["branch", "clean", [], ["security"], "feat/x"]);
			assert.equal(record.srcTree, await srcTree());
			assert.ok(record.runId && record.tree && record.root);
		});
	});

	it("S6: blockers are recorded by id, and a failed run is recorded as failed", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			await verify("Risk: security (guard)", "verify BLOCKERS");
			assert.deepEqual(records().map((r) => [r.outcome, r.blockers]), [["blockers", ["B1", "B2"]]]);
			const failed = await verify("Risk: data (x)", "verify FAIL");
			assert.equal(failed.isError, true);
		});
	});

	it("S6: a failed verify is recorded as failed and does not use up the budget", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			const failed = await verify("Risk: security (guard)", "verify FAIL");
			assert.equal(failed.isError, true);
			assert.deepEqual(records().map((r) => r.outcome), ["failed"]);
			const again = await verify("Risk: security (guard)");
			assert.notEqual(again.isError, true, text(again));
			assert.deepEqual(records().map((r) => r.outcome), ["failed", "clean"]);
		});
	});

	it("S7: a second branch verify on the same source tree is rejected before anything runs", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			await verify("Risk: security (guard)");
			const runsBefore = fs.readdirSync(docsRuns()).length;
			const again = await verify("Risk: security (guard)");
			assert.equal(again.isError, true);
			assert.match(text(again), /Launch rejected by brigadev delegation rules/);
			assert.match(text(again), /already verified this source tree/);
			assert.equal(fs.readdirSync(docsRuns()).length, runsBefore, "no child was started");
			assert.equal(records().length, 1);
		});
	});

	it("S7: a docs-only edit keeps the source tree, so it is still the same verify", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			await verify("Risk: security (guard)");
			fs.writeFileSync(path.join(repo, "NOTES.md"), "docs\n");
			try {
				assert.equal((await verify("Risk: security (guard)")).isError, true);
			} finally {
				fs.rmSync(path.join(repo, "NOTES.md"));
			}
		});
	});

	it("S7: a new source tree asks; without a UI, or when declined, it is rejected", { timeout: 60_000 }, async () => {
		await withVerify({ hasUI: false }, async ({ verify }) => {
			seed({});
			const result = await verify("Risk: security (guard)");
			assert.equal(result.isError, true);
			assert.match(text(result), /another branch verify/);
			assert.match(text(result), /needs the user's confirmation, and there is no UI/);
			assert.equal(records().length, 1);
		});
		await withVerify({ hasUI: true }, async ({ ctx, verify }) => {
			seed({});
			const asked: string[] = [];
			(ctx.ui as any).confirm = async (title: string, body: string) => (asked.push(`${title}\n${body}`), false);
			const result = await verify("Risk: security (guard)");
			assert.equal(result.isError, true);
			assert.match(text(result), /declined/);
			assert.equal(asked.length, 1);
			assert.match(asked[0], /another branch verify/);
			assert.equal(records().length, 1);
		});
	});

	it("S7: the user can confirm a verify on a new source tree", { timeout: 60_000 }, async () => {
		await withVerify({ hasUI: true }, async ({ ctx, verify }) => {
			seed({});
			(ctx.ui as any).confirm = async () => true;
			const result = await verify("Risk: security (guard)");
			assert.notEqual(result.isError, true, text(result));
			assert.deepEqual(records().map((r) => r.runId === "seed"), [true, false]);
		});
	});

	it("S7: a recheck of the last verify's blockers is admitted once, and a second is rejected", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			seed({ outcome: "blockers", blockers: ["B1", "B2"] });
			const first = await verify("Risk: security (fix); recheck B1,B2", "recheck B1,B2");
			assert.notEqual(first.isError, true, text(first));
			assert.deepEqual(records().map((r) => r.scope), ["branch", "recheck"]);
			const second = await verify("Risk: security (fix); recheck B1", "recheck B1");
			assert.equal(second.isError, true);
			assert.match(text(second), /one recheck per branch verify/);
			assert.equal(records().length, 2);
		});
	});

	it("S7: a recheck is rejected for ids that are not blockers, or a category other than security or data", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			seed({ outcome: "blockers", blockers: ["B1"] });
			assert.match(text(await verify("Risk: security (fix); recheck B2")), /blockers of the last branch verify: B1/);
			assert.match(text(await verify("Risk: contract (fix); recheck B1")), /security or data/);
			assert.equal(records().length, 1);
		});
	});

	it("S7: tasks of one call do not both pass the first-verify budget", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ pi, ctx }) => {
			const tasks = [1, 2].map((n) => ({ agent: "brigadev-verify", task: `verify ${n}`, reason: "Risk: security (guard)" }));
			const result = await pi.tool("subagent").execute("t", { tasks }, undefined, undefined, ctx);
			assert.equal(result.isError, true);
			assert.match(text(result), /task 2: .*already verified this source tree|task 2: .*another branch verify/);
			assert.equal(records().length, 0);
		});
	});

	it("S7: other agents are not budgeted", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ pi, ctx }) => {
			for (let i = 0; i < 2; i++) {
				const result = await pi.tool("subagent").execute("t", { agent: "brigadev-explore", task: "alpha", reason: "independent units" }, undefined, undefined, ctx);
				assert.notEqual(result.isError, true, text(result));
			}
			assert.equal(records().length, 0);
		});
	});

	const writeProfile = (profile: Record<string, unknown>) => {
		fs.mkdirSync(path.dirname(profilesFile()), { recursive: true });
		fs.writeFileSync(profilesFile(), JSON.stringify({ version: 1, active: "p", profiles: { p: profile } }));
	};

	it("S8: a recheck routes through brigadev-verify-recheck when the profile has it", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			writeProfile({ "brigadev-verify": { thinking: "xhigh" }, "brigadev-verify-recheck": { thinking: "medium" } });
			seed({ outcome: "blockers", blockers: ["B1"] });
			const recheck = await verify("Risk: security (fix); recheck B1", "recheck B1");
			assert.equal(recheck.details.results[0].route, "profile:p/brigadev-verify-recheck");
			assert.equal(recheck.details.results[0].thinking, "medium");
		});
	});

	it("S8: a recheck falls back to the verify route when the profile has no recheck key, and a branch verify never uses it", { timeout: 60_000 }, async () => {
		await withVerify({}, async ({ verify }) => {
			writeProfile({ "brigadev-verify": { thinking: "xhigh" } });
			seed({ outcome: "blockers", blockers: ["B1"] });
			const recheck = await verify("Risk: security (fix); recheck B1", "recheck B1");
			assert.equal(recheck.details.results[0].route, "profile:p/brigadev-verify");
			assert.equal(recheck.details.results[0].thinking, "xhigh");
		});
		await withVerify({}, async ({ verify }) => {
			writeProfile({ "brigadev-verify": { thinking: "xhigh" }, "brigadev-verify-recheck": { thinking: "medium" } });
			const branch = await verify("Risk: security (guard)");
			assert.equal(branch.details.results[0].route, "profile:p/brigadev-verify");
			assert.equal(branch.details.results[0].thinking, "xhigh");
		});
	});
});
