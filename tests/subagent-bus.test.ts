// S5 at the extension level: extensions/subagents.ts loaded for real against the recording fakes, children are a
// fake `pi --mode json` script (a task containing HANG streams some text and then waits to be killed).

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { BUS, type AgentState } from "../lib/bus.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { runsDir } from "../lib/run-artifacts.ts";
import { createFakeCtx, createFakePi, type FakeCtx, type FakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const CHILD_SOURCE = `
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const usage = { input: 3, output: 4, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } };
const message = (extra) => ({ role: "assistant", content: [{ type: "text", text: "" }], provider: "p", model: "m", usage, ...extra });
const task = String(process.argv.at(-1)).replace(/^## Task\\n/, "");
if (process.env.ARGV_LOG) process.getBuiltinModule("node:fs").appendFileSync(process.env.ARGV_LOG, JSON.stringify(process.argv) + "\\n");
line({ type: "session", version: 3, id: "fake", timestamp: new Date().toISOString(), cwd: process.cwd() });
line({ type: "agent_start" });
if (task.includes("HANG")) {
	line({ type: "message_start", message: message({}) });
	line({ type: "message_update", message: message({}), assistantMessageEvent: { type: "text_delta", delta: "working on it" } });
	setInterval(() => {}, 1000);
} else {
	if (task.includes("TOOLS")) {
		for (let i = 0; i < 15; i++) line({ type: "message_end", message: message({ content: [{ type: "toolCall", id: "c" + i, name: "read", arguments: { path: "lib/f" + i + ".ts" } }], stopReason: "toolUse" }) });
	}
	if (task.includes("LEAK")) line({ type: "message_end", message: message({ content: [{ type: "toolCall", id: "leak", name: "bash", arguments: { command: "curl https://me:hunter2@x.test --password=hunter2" } }], stopReason: "toolUse" }) });
	line({ type: "message_end", message: message({ content: [{ type: "text", text: task.includes("LEAK") ? "found ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8 in the env" : "all done" }], stopReason: "stop" }) });
	line({ type: "agent_end", messages: [], willRetry: false });
	line({ type: "agent_settled", aborted: false });
}
`;

let root: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;
let savedArgv1: string | undefined;
let uninstall: () => void;
let extension: (pi: any) => void;

before(async () => {
	savedEnv = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
	root = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-bus-"));
	cwd = path.join(root, "proj");
	fs.mkdirSync(cwd);
	fs.writeFileSync(path.join(root, "child.mjs"), CHILD_SOURCE);
	process.env.BRIGADEV_HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	uninstall = installPiStubs();
	extension = (await import("../extensions/subagents.ts")).default;
});

after(() => {
	uninstall();
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	fs.rmSync(root, { recursive: true, force: true });
});

const withChild = async (body: (h: { pi: FakePi; ctx: FakeCtx }) => Promise<void>) => {
	savedArgv1 = process.argv[1];
	process.argv[1] = path.join(root, "child.mjs");
	const pi = createFakePi();
	extension(pi);
	const ctx = createFakeCtx({ cwd, hasUI: true, idle: true });
	try {
		await pi.fire("session_start", { reason: "startup" }, ctx);
		await body({ pi, ctx });
	} finally {
		await pi.fire("session_shutdown", {}, ctx);
		process.argv[1] = savedArgv1;
	}
};

const snapshots = (pi: FakePi): AgentState[] => pi.emitted.filter((e) => e.channel === BUS.agent).map((e) => e.data as AgentState);
const latest = (pi: FakePi, id: string) => snapshots(pi).filter((s) => s.id === id).at(-1);
const launch = (pi: FakePi, ctx: FakeCtx, tasks: string[]) =>
	pi.tool("subagent").execute("t", { tasks: tasks.map((task) => ({ agent: "brigadev-explore", task, reason: "independent units" })) }, undefined, undefined, ctx);
const single = (pi: FakePi, ctx: FakeCtx, task: string) => pi.tool("subagent").execute("t", { agent: "brigadev-explore", task, reason: "independent units" }, undefined, undefined, ctx);
const cancel = (pi: FakePi, id: string) => pi.events.emit(BUS.action, { action: "cancel-agent", id });

async function until(condition: () => boolean, what: string, ms = 20_000) {
	const end = Date.now() + ms;
	while (!condition()) {
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("brigadev:agent snapshots", () => {
	it("a launch publishes queued, running and finished snapshots of one task id", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const result = await single(pi, ctx, "alpha");
			assert.notEqual(result.isError, true);
			const all = snapshots(pi);
			assert.ok(all.length >= 3, `${all.length} snapshots`);
			const [first] = all;
			assert.match(first.id, /^\d+:0$/);
			assert.equal(first.launchId, first.id.split(":")[0]);
			assert.equal(first.index, 0);
			assert.equal(first.agent, "brigadev-explore");
			assert.equal(first.task, "alpha");
			assert.equal(first.status, "queued");
			assert.equal(first.cancellable, true);
			assert.deepEqual([...new Set(all.map((s) => s.id))], [first.id], "one task, one id");
			assert.ok(all.some((s) => s.status === "running" && s.cancellable && s.startedAt !== undefined), "a running snapshot");
			const last = all.at(-1)!;
			assert.equal(last.status, "done");
			assert.equal(last.cancellable, false);
			assert.equal(last.tokens, 7);
			assert.equal(last.model, "p/m");
			assert.ok(last.runId, "the run id");
			assert.ok(last.endedAt !== undefined && last.startedAt !== undefined);
			assert.equal(latest(pi, first.id), last);
		});
	});

	it("a snapshot carries what a detail view needs: the whole task, the reason, recent tool calls, and the output once settled", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const result = await single(pi, ctx, "TOOLS first line\nsecond line");
			assert.notEqual(result.isError, true);
			const all = snapshots(pi);
			const [first] = all;
			assert.equal(first.task, "TOOLS first line");
			assert.equal(first.taskText, "TOOLS first line\nsecond line");
			assert.equal(first.reason, "independent units");
			assert.equal(first.output, undefined, "no output before it settles");
			const last = all.at(-1)!;
			assert.equal(last.output, "all done");
			assert.equal(last.steps?.length, 12, "the most recent tool calls only");
			assert.deepEqual(last.steps?.at(-1), { tool: "read", summary: "lib/f14.ts" });
			assert.deepEqual(last.steps?.[0], { tool: "read", summary: "lib/f3.ts" });
		});
	});

	it("what a snapshot carries is redacted: the task, the steps and the output", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const result = await single(pi, ctx, "LEAK use https://me:hunter2@x.test and --password=hunter2\nsecond ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
			assert.notEqual(result.isError, true);
			const raw = JSON.stringify(snapshots(pi));
			for (const leak of ["hunter2", "ghp_a1B2"]) assert.ok(!raw.includes(leak), `leaked ${leak}`);
			const last = snapshots(pi).at(-1)!;
			assert.equal(last.output, "found *** in the env");
			assert.equal(last.steps?.at(-1)?.summary, "curl https://***@x.test --password=***");
			assert.match(last.taskText ?? "", /https:\/\/\*\*\*@x\.test/);
		});
	});

	it("/brigadev:codemode off drops codemode from a subagent's tool list at launch; on keeps it", { timeout: 60_000 }, async () => {
		const settings = path.join(root, "pi-agent", "brigadev.json");
		const log = path.join(root, "argv.log");
		process.env.ARGV_LOG = log;
		const toolsOfLastLaunch = () => {
			const argv: string[] = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)!);
			return argv[argv.indexOf("--tools") + 1].split(",");
		};
		try {
			fs.mkdirSync(path.dirname(settings), { recursive: true });
			for (const [setting, expected] of [[{ codemode: false }, false], [{}, true], [{ codemode: true }, true]] as const) {
				fs.writeFileSync(settings, JSON.stringify(setting));
				await withChild(async ({ pi, ctx }) => {
					assert.notEqual((await single(pi, ctx, "alpha")).isError, true);
				});
				const tools = toolsOfLastLaunch();
				assert.equal(tools.includes("codemode"), expected, `${JSON.stringify(setting)}: ${tools.join(",")}`);
				assert.ok(tools.includes("read"), "the agent's other tools stay");
			}
		} finally {
			delete process.env.ARGV_LOG;
			fs.rmSync(settings, { force: true });
		}
	});

	it("a failing bus listener never breaks the launch", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			pi.events.emit = () => {
				throw new Error("listener blew up");
			};
			const result = await single(pi, ctx, "alpha");
			assert.notEqual(result.isError, true);
			assert.match(result.content[0].text, /^alpha\nall done|all done/);
		});
	});
});

describe("brigadev:action cancel-agent", () => {
	it("cancels a running task, kills its child and ends the call as cancelled by the user", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const call = single(pi, ctx, "HANG forever");
			await until(() => snapshots(pi).some((s) => s.status === "running" && s.partial?.includes("working on it")), "a running snapshot with partial text");
			const running = snapshots(pi).filter((s) => s.status === "running").at(-1)!;
			assert.equal(running.cancellable, true);
			cancel(pi, running.id);
			const result = await call;
			assert.equal(result.isError, true);
			assert.match(result.content[0].text, /^Agent cancelled: Cancelled by the user\./);
			const last = latest(pi, running.id)!;
			assert.equal(last.status, "cancelled");
			assert.equal(last.cancellable, false);
			assert.ok(last.endedAt !== undefined);
			assert.ok(last.runId, "the cancelled run still has its run id");
			assert.ok(fs.existsSync(path.join(runsDir(repoDocsDir(cwd)), path.basename(last.runId!), "result.json")), "its run folder is saved like any ended task");
		});
	});

	it("cancelling a running task does not fail its sibling or the launch", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const call = launch(pi, ctx, ["HANG one", "quick"]);
			await until(() => snapshots(pi).some((s) => s.index === 0 && s.status === "running") && snapshots(pi).some((s) => s.index === 1 && s.status === "done"), "one running and one done");
			const launchId = snapshots(pi)[0].launchId;
			cancel(pi, `${launchId}:0`);
			const result = await call;
			assert.match(result.content[0].text, /^Parallel: 1\/2 succeeded/);
			assert.equal(latest(pi, `${launchId}:0`)?.status, "cancelled");
			assert.equal(latest(pi, `${launchId}:1`)?.status, "done");
			assert.equal(result.isError, undefined, "a user cancel does not fail the launch");
		});
	});

	it("a task waiting for a slot never starts when it is cancelled", { timeout: 90_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const call = launch(pi, ctx, ["HANG a", "HANG b", "HANG c", "HANG d", "HANG queued"]);
			await until(() => snapshots(pi).filter((s) => s.status === "running").length >= 4, "four running tasks");
			const launchId = snapshots(pi)[0].launchId;
			const queued = `${launchId}:4`;
			assert.equal(latest(pi, queued)?.status, "queued");
			cancel(pi, queued);
			await until(() => latest(pi, queued)?.status === "cancelled", "the queued task to settle");
			assert.equal(snapshots(pi).some((s) => s.id === queued && s.status === "running"), false, "it never ran");
			assert.equal(latest(pi, queued)?.cancellable, false);
			for (const i of [0, 1, 2, 3]) cancel(pi, `${launchId}:${i}`);
			const result = await call;
			assert.match(result.content[0].text, /^Parallel: 0\/5 succeeded/);
		});
	});

	it("an unknown, malformed or settled id is ignored", { timeout: 60_000 }, async () => {
		await withChild(async ({ pi, ctx }) => {
			const result = await single(pi, ctx, "alpha");
			assert.notEqual(result.isError, true);
			const before = snapshots(pi).length;
			const id = snapshots(pi)[0].id;
			cancel(pi, id);
			cancel(pi, "99:0");
			pi.events.emit(BUS.action, { action: "cancel-agent" });
			assert.equal(snapshots(pi).length, before, "nothing was published");
			assert.equal(latest(pi, id)?.status, "done", "a settled task keeps its outcome");
		});
	});
});
