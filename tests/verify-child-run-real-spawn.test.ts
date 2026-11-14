import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { runChild, type RunOptions } from "../lib/child-run.ts";

const FAKE_PI = `const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "real child answer" }], provider: "p", model: "m", stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
if (process.env.FAKE_MODE === "hang") setInterval(() => {}, 1000); else process.exit(0);
`;

function setup(mode: string, signal?: AbortSignal, spawn?: any) {
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
	const p = runChild(options, { ...(spawn ? { spawn } : {}), piInvocation: (args) => ({ command: process.execPath, args: [fakePi, ...args] }), env: { PATH: process.env.PATH, FAKE_MODE: mode }, tmpRoot, docsDir: () => docs });
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

it("a spawn that throws synchronously rejects, removes the temp dir, and saves the folder", async () => {
	const { p, tmpRoot, docs, root } = setup("ok", undefined, () => {
		throw new Error("EAGAIN spawn");
	});
	await assert.rejects(p, /EAGAIN spawn/);
	assert.deepEqual(fs.readdirSync(tmpRoot), []);
	assert.equal(fs.readdirSync(path.join(docs, "runs")).length, 1);
	fs.rmSync(root, { recursive: true, force: true });
});
