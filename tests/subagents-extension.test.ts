// extensions/subagents.ts loaded for real, against recording fakes of Pi's API (tests/helpers). Pi's runtime packages are
// stubbed by a test-only module loader; children are a fake `pi --mode rpc` script, never real Pi.

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
const FAKE_CHILD = path.join(import.meta.dirname, "helpers", "fake-pi-rpc.mjs");

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
	it("registers the tools, the viewer commands, shortcuts, and the result renderer", () => {
		const { pi } = load();
		assert.deepEqual([...pi.tools.keys()].sort(), ["subagent", "subagent_cancel", "subagent_wait"]);
		assert.ok(pi.commands.has("brigadev:runs"));
		assert.ok(pi.commands.has("brigadev:agents"));
		assert.deepEqual([...pi.shortcuts.keys()].sort(), ["alt+a", "ctrl+shift+a"]);
		assert.deepEqual([...pi.renderers.keys()], ["brigadev-subagent-result"]);
		for (const event of ["session_start", "session_shutdown", "agent_settled", "before_agent_start"]) assert.ok(pi.handlers.has(event), event);
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

describe("tool schemas", () => {
	it("subagent_wait: launchId documented, runId a deprecated alias, both optional, timeoutSeconds optional", () => {
		const schema = load().pi.tool("subagent_wait").parameters;
		assert.deepEqual(Object.keys(schema.properties).sort(), ["launchId", "runId", "timeoutSeconds"]);
		assert.equal(schema.properties.launchId.type, "string");
		assert.match(schema.properties.launchId.description, /launch id/i);
		assert.match(schema.properties.runId.description, /deprecated alias of launchId/i);
		assert.equal(schema.properties.timeoutSeconds.type, "number");
		assert.match(schema.properties.timeoutSeconds.description, /Default 60, max 300/);
		assert.equal(schema.required, undefined, "nothing is required: the tool itself demands exactly one id");
	});

	it("subagent_cancel: launchId and runId only, both optional", () => {
		const schema = load().pi.tool("subagent_cancel").parameters;
		assert.deepEqual(Object.keys(schema.properties).sort(), ["launchId", "runId"]);
		assert.match(schema.properties.launchId.description, /launch id/i);
		assert.match(schema.properties.runId.description, /deprecated alias of launchId/i);
		assert.equal(schema.required, undefined);
	});

	it("subagent: the optional async flag is a boolean next to the launch fields", () => {
		const schema = load().pi.tool("subagent").parameters;
		assert.equal(schema.properties.async.type, "boolean");
		assert.match(schema.properties.async.description, /subagent_wait/);
		assert.equal(schema.required, undefined, "single, parallel and async calls share one schema; every field is optional");
		for (const field of ["agent", "task", "reason", "allowedEditSurfaces", "featureDoc", "skills", "tasks"]) assert.ok(field in schema.properties, field);
	});
});

describe("subagent_wait / subagent_cancel answers", () => {
	const MISSING = 'Missing launchId: pass the id from the async subagent call, as {"launchId":"…"}.';
	const BOTH = "Pass launchId only; runId is its deprecated alias, not a second id.";

	for (const name of ["subagent_wait", "subagent_cancel"]) {
		it(`${name}: neither id is an error naming launchId`, async () => {
			const result = await load().pi.tool(name).execute("t", {});
			assert.equal(result.isError, true);
			assert.equal(text(result), MISSING);
		});

		it(`${name}: both ids is an error`, async () => {
			const result = await load().pi.tool(name).execute("t", { launchId: "a", runId: "a" });
			assert.equal(result.isError, true);
			assert.equal(text(result), BOTH);
		});

		it(`${name}: an unknown id is an error, by launchId and by the runId alias`, async () => {
			const { pi } = load();
			for (const params of [{ launchId: "nope" }, { runId: "nope" }]) {
				const result = await pi.tool(name).execute("t", params);
				assert.equal(result.isError, true);
				assert.equal(text(result), 'Unknown launch id "nope" (not started in this session, or pruned).');
			}
		});
	}
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

describe("async launches: delivered-omitted wiring end to end", () => {
	const finishedStatus = (ctx: FakeCtx) => ctx.statuses.at(-1)?.text ?? "";
	const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

	it("a launch left out of the combined delivery is told to read its saved folders, not 'in the conversation above'", { timeout: 60_000 }, async () => {
		fs.rmSync(repoDocsDir(cwd), { recursive: true, force: true });
		// The extension's own `piInvocation` runs process.argv[1] with node: that script is the fake child.
		savedArgv1 = process.argv[1];
		process.argv[1] = FAKE_CHILD;
		const { pi, ctx } = load({ hasUI: true, idle: false });
		// The extension asks `ctx.isIdle()` exactly once per settled launch it holds (and per idle flush, none before the signal below),
		// so the count is the number of launches whose registry settle reached the delivery.
		let idleChecks = 0;
		ctx.isIdle = () => {
			idleChecks++;
			return ctx.idle;
		};
		try {
			await pi.fire("session_start", { reason: "startup" }, ctx);
			const start = async (task: string) => {
				const result = await pi.tool("subagent").execute("t", { agent: "brigadev-explore", task, reason: "independent units", async: true }, undefined, undefined, ctx);
				assert.notEqual(result.isError, true, text(result));
				assert.match(text(result), /^Started async launch /);
				return result.details.launchId as string;
			};
			// Two launches settle while the parent is busy, so both are held and go out as one batch at the idle signal.
			const ids = [await start("alpha BIG"), await start("beta tiny")];
			assert.notEqual(ids[0], ids[1]);
			for (let i = 0; i < 400 && !/2 done/.test(finishedStatus(ctx)); i++) await sleep(50);
			assert.match(finishedStatus(ctx), /2 done/, "both children finished");
			// The card update comes first; the registry settle (which the delivery holds) follows. Wait for both, observed through the idle checks.
			for (let i = 0; i < 200 && idleChecks < 2; i++) await sleep(50);
			assert.equal(idleChecks, 2, "both launches settled in the registry and are held");
			assert.equal(pi.messages.length, 0, "nothing is delivered while the parent is busy");

			ctx.idle = true;
			await pi.fire("agent_settled", {}, ctx);
			assert.equal(pi.messages.length, 1, "one combined message");
			const { message, options } = pi.messages[0];
			assert.equal(message.customType, "brigadev-subagent-result");
			assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
			assert.deepEqual(message.details.launches.map((l: { id: string }) => l.id).sort(), [...ids].sort());

			// The size guard keeps the first launch whole and leaves the next one as a pointer, whatever the settle order.
			const content: string = message.content;
			const pointerLaunches = ids.filter((id) => new RegExp(`Launch ${id}: its full result was left out of this message`).test(content));
			assert.equal(pointerLaunches.length, 1, "exactly one launch was left out");
			const omitted = pointerLaunches[0];
			const whole = ids.find((id) => id !== omitted)!;
			assert.match(content, /Saved folders \(the full text is in result\.json\):/);

			const omittedAnswer = await pi.tool("subagent_wait").execute("t", { launchId: omitted });
			assert.doesNotMatch(text(omittedAnswer), /in the conversation above/);
			assert.match(text(omittedAnswer), new RegExp(`Launch ${omitted} was delivered to this session, but its result was too large to include`));
			assert.match(text(omittedAnswer), /Saved folders/);
			assert.ok(text(omittedAnswer).includes(docsRuns()), "points at the saved run folder");

			const wholeAnswer = await pi.tool("subagent_wait").execute("t", { launchId: whole });
			assert.match(text(wholeAnswer), new RegExp(`Launch ${whole} was already delivered to this session: its result is in the conversation above`));

			// Cancel answers the same way for the omitted launch.
			const cancelAnswer = await pi.tool("subagent_cancel").execute("t", { launchId: omitted });
			assert.doesNotMatch(text(cancelAnswer), /in the conversation above/);
			assert.match(text(cancelAnswer), /too large to include/);
			assert.deepEqual(ctx.notifications.filter((n) => /could not deliver/.test(n.message)), []);
		} finally {
			await pi.fire("session_shutdown", {}, ctx);
			process.argv[1] = savedArgv1;
		}
	});
});
