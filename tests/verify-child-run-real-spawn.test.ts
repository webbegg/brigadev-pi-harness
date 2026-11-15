import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { output, runChild, type RunOptions } from "../lib/child-run.ts";

// A fake `pi --mode rpc`: reads JSONL commands from stdin, answers the prompt, streams events, and exits when stdin closes.
//  - ok:      answers the prompt, then settles (the parent must close stdin for the child to exit)
//  - hang:    accepts the prompt and never finishes (abort test)
//  - confirm: sends an extension UI confirm request and blocks until it is answered; the answer is logged to FAKE_LOG
const FAKE_PI = `import * as fs from "node:fs";
const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const mode = process.env.FAKE_MODE;
const finish = (text) => {
	line({ type: "agent_start" });
	line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], provider: "p", model: "m", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	line({ type: "agent_end", messages: [], willRetry: false });
	line({ type: "agent_settled", aborted: false });
};
const onCommand = (command) => {
	if (command.type === "prompt") {
		line({ type: "response", command: "prompt", success: true, data: { disposition: "started" } });
		if (mode === "hang") return setInterval(() => {}, 1000);
		if (mode === "confirm") return line({ type: "extension_ui_request", id: "ui-1", method: "confirm", title: "Allow rm -rf?", message: "really" });
		return finish("real child answer");
	}
	if (command.type === "extension_ui_response") {
		fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify(command));
		return finish(command.cancelled === true ? "cancelled, carried on" : "was answered by someone");
	}
};
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let at;
	while ((at = buffer.indexOf("\\n")) >= 0) {
		const text = buffer.slice(0, at);
		buffer = buffer.slice(at + 1);
		if (text.trim()) onCommand(JSON.parse(text));
	}
});
process.stdin.on("end", () => process.exit(0));
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
	const p = runChild(options, { ...(spawn ? { spawn } : {}), piInvocation: (args) => ({ command: process.execPath, args: [fakePi, ...args] }), env: { PATH: process.env.PATH, FAKE_MODE: mode, FAKE_LOG: path.join(root, "ui-response.json"), ...extraEnv }, tmpRoot, docsDir: () => docs });
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

it("S0, default node spawn: a child that blocks on an extension UI confirm is answered with a cancellation and the run completes", { timeout: 15_000 }, async () => {
	// The stall watchdog is the backstop: if the parent did not answer, the run would end as an error, not hang the suite.
	const { p, root } = setup("confirm", undefined, undefined, { BRIGADEV_STALL_TIMEOUT_MS: "8000" });
	const r = await p;
	assert.equal(r.exitCode, 0);
	assert.equal(r.stopReason, "stop");
	assert.equal(output(r), "cancelled, carried on");
	assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "ui-response.json"), "utf8")), { type: "extension_ui_response", id: "ui-1", cancelled: true });
	assert.equal(r.messages.length, 1, "the request and its answer are not transcript messages");
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
