import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { output, runChild, type RunOptions } from "../lib/child-run.ts";

// A fake `pi --mode json`: the task is the last argv entry, events stream on stdout, and it exits when the run is over.
//  - ok:      answers the task, settles, and exits on its own
//  - hang:    starts the run and never finishes (abort test)
//  - stubborn: like hang, but ignores SIGTERM and starts a `sleep` in a process group of its own (as a bash tool does); its pid goes to FAKE_LOG
const FAKE_PI = `import * as fs from "node:fs";
import { spawn } from "node:child_process";
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_MODE;
const finish = (text) => {
	line({ type: "agent_start" });
	line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "p", model: "m", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	line({ type: "agent_end", messages: [], willRetry: false });
	line({ type: "agent_settled", aborted: false });
};
line({ type: "session", version: 3, id: "s", timestamp: "t", cwd: process.cwd() });
const task = process.argv.at(-1);
if (process.argv.at(-2) !== "--" || !task.startsWith("## Task")) process.exit(3);
if (mode === "hang") setInterval(() => {}, 1000);
else if (mode === "stubborn") {
	process.on("SIGTERM", () => {});
	const tool = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	tool.unref();
	fs.writeFileSync(process.env.FAKE_LOG, String(tool.pid));
	setInterval(() => {}, 1000);
} else finish("real child answer");
`;

function setup(mode: string, signal?: AbortSignal, spawn?: any, extraEnv: Record<string, string> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-real-spawn-"));
	const tmpRoot = path.join(root, "tmp");
	const docs = path.join(root, "docs");
	const cwd = path.join(root, "proj");
	const scripts = path.join(root, "scripts");
	for (const d of [tmpRoot, docs, cwd, scripts]) fs.mkdirSync(d);
	const fakePi = path.join(scripts, "fakepi.mjs");
	fs.writeFileSync(fakePi, FAKE_PI);
	const options: RunOptions = {
		cwd,
		agent: { name: "scout", description: "d", writer: false, systemPrompt: "sys", source: "package", filePath: "/a.md" } as any,
		request: { agent: "scout", task: "t", reason: "r" },
		taskText: "## Task\nt",
		route: { model: "p/m", modelSource: "definition", thinkingSource: "definition" } as any,
		routeLabel: "definition",
		price: () => undefined,
		signal,
		onUpdate: () => {},
	};
	const p = runChild(options, { ...(spawn ? { spawn } : {}), piInvocation: (args) => ({ command: process.execPath, args: [fakePi, ...args] }), env: { PATH: process.env.PATH, FAKE_MODE: mode, FAKE_LOG: path.join(root, "tool-pid"), ...extraEnv }, tmpRoot, docsDir: () => docs });
	p.catch(() => undefined);
	return { p, tmpRoot, docs, root };
}

it("default node spawn: a real child is folded, its folder saved, the temp dir removed", async () => {
	const { p, tmpRoot, docs, root } = setup("ok");
	const r = await p;
	assert.equal(r.exitCode, 0);
	assert.equal(r.messages.length, 1);
	assert.ok(r.artifactsDir?.startsWith(docs));
	assert.deepEqual(fs.readdirSync(r.artifactsDir!).sort(), ["result.json", "task.md", "transcript.json"]);
	assert.deepEqual(fs.readdirSync(tmpRoot), []);
	fs.rmSync(root, { recursive: true, force: true });
});

it("default node spawn: aborting a running child rejects after SIGTERM and still saves the folder", async () => {
	const ac = new AbortController();
	const { p, tmpRoot, docs, root } = setup("hang", ac.signal);
	setTimeout(() => ac.abort(), 300);
	const t0 = Date.now();
	await assert.rejects(p, /Subagent was aborted/);
	assert.ok(Date.now() - t0 < 4000);
	assert.equal(fs.readdirSync(path.join(docs, "runs")).length, 1);
	assert.deepEqual(fs.readdirSync(tmpRoot), []);
	fs.rmSync(root, { recursive: true, force: true });
});

it("S5, default node spawn: a child that ignores SIGTERM is SIGKILLed after the grace and so is its tool command in another process group", { timeout: 20_000, skip: process.platform === "win32" }, async () => {
	const ac = new AbortController();
	const { p, root } = setup("stubborn", ac.signal);
	const pidFile = path.join(root, "tool-pid");
	let toolPid = 0;
	try {
		for (let i = 0; i < 100 && !toolPid; i++) {
			await new Promise((resolve) => setTimeout(resolve, 50));
			toolPid = Number(fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8") : 0);
		}
		assert.ok(toolPid > 1, "the child started its tool command");
		ac.abort();
		await assert.rejects(p, /Subagent was aborted/);
		const alive = () => {
			try {
				process.kill(toolPid, 0);
				return true;
			} catch {
				return false;
			}
		};
		for (let i = 0; i < 40 && alive(); i++) await new Promise((resolve) => setTimeout(resolve, 50));
		assert.equal(alive(), false, "the tool command died with the forced kill");
	} finally {
		if (toolPid > 1) {
			try {
				process.kill(toolPid, "SIGKILL");
			} catch {
				// Already gone.
			}
		}
		fs.rmSync(root, { recursive: true, force: true });
	}
});

it("a silent real child is stopped by the stall watchdog, the only timer", { timeout: 15_000 }, async () => {
	const { p, root } = setup("hang", undefined, undefined, { BRIGADEV_STALL_TIMEOUT_MS: "600" });
	const r = await p;
	assert.equal(r.stopReason, "error");
	assert.match(r.errorMessage ?? "", /^stalled for /);
	assert.ok(r.exitCode > 0);
	fs.rmSync(root, { recursive: true, force: true });
});

it("a spawn that throws synchronously rejects, removes the temp dir, and saves the folder", async () => {
	const { p, tmpRoot, docs, root } = setup("ok", undefined, () => {
		throw new Error("EAGAIN spawn");
	});
	await assert.rejects(p, /EAGAIN spawn/);
	assert.deepEqual(fs.readdirSync(tmpRoot), []);
	assert.equal(fs.readdirSync(path.join(docs, "runs")).length, 1);
	fs.rmSync(root, { recursive: true, force: true });
});
