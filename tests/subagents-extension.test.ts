// extensions/subagents.ts loaded for real, against recording fakes of Pi's API (tests/helpers). Pi's runtime packages are
// stubbed by a test-only module loader; children are a fake `pi --mode json` script, never real Pi.

import assert from "node:assert/strict";
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
