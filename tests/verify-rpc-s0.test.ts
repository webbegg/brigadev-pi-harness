import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { it } from "node:test";
import { output, runChild, type ChildProcessLike, type RunOptions } from "../lib/child-run.ts";

// Verifier T9 (S0 in RPC mode): every dialog a child opens is cancelled on the spot, whatever the framing,
// and no child can outlive the stall watchdog. Probes derived from rpc-extension-ui.md, not from the run loop.

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fakeTime() {
	let now = 0;
	let next = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimer: (fn: () => void, ms: number) => {
			const handle = next++;
			timers.set(handle, { at: now + ms, fn });
			return handle;
		},
		clearTimer: (handle: unknown) => void timers.delete(handle as number),
		advance(ms: number) {
			now += ms;
			for (const [handle, t] of [...timers]) if (t.at <= now) (timers.delete(handle), t.fn());
		},
	};
}
class Stdin extends EventEmitter {
	written: string[] = [];
	ended = false;
	late = 0;
	write(chunk: string) {
		if (this.ended) this.late++;
		else this.written.push(chunk);
		return true;
	}
	end() {
		this.ended = true;
	}
	records = () => this.written.map((c) => JSON.parse(c));
}
class Child extends EventEmitter implements ChildProcessLike {
	stdin = new Stdin();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kills: string[] = [];
	kill(signal?: NodeJS.Signals) {
		this.kills.push(String(signal));
		return true;
	}
	say(text: string) {
		this.stdout.emit("data", Buffer.from(text));
	}
	line(record: unknown) {
		this.say(`${JSON.stringify(record)}\n`);
	}
}

async function start(env: Record<string, string> = {}) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "verify-rpc-s0-"));
	const child = new Child();
	const time = fakeTime();
	const options: RunOptions = {
		cwd: root,
		agent: { name: "scout", description: "d", writer: false, systemPrompt: "", source: "package", filePath: "/a.md" } as any,
		request: { agent: "scout", task: "t", reason: "r" },
		taskText: "TASK",
		route: { model: "p/m", modelSource: "definition", thinkingSource: "definition" } as any,
		routeLabel: "definition",
		price: () => undefined,
		onUpdate: () => {},
	};
	let spawned!: () => void;
	const ready = new Promise<void>((resolve) => (spawned = resolve));
	const p = runChild(options, { spawn: () => (setImmediate(spawned), child), piInvocation: (args) => ({ command: "pi", args }), env, setTimer: time.setTimer, clearTimer: time.clearTimer, tmpRoot: root, docsDir: () => path.join(root, "docs") });
	p.catch(() => undefined);
	// The run loop creates its temp folder before it spawns; wait for the spawn, then for the prompt write.
	await ready;
	await tick();
	return { p, child, time, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const settle = (child: Child, text = "done") => {
	child.line({ type: "agent_start" });
	child.line({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } } } });
	child.line({ type: "agent_end" });
	child.line({ type: "agent_settled", aborted: false });
};
const FIRE_AND_FORGET = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"];

it("S0: every dialog and every unknown method is cancelled synchronously with its id; fire-and-forget gets nothing", async () => {
	const h = await start();
	for (const [i, method] of ["select", "confirm", "input", "editor", "someFutureDialog", ...FIRE_AND_FORGET].entries()) {
		const before = h.child.stdin.written.length;
		h.child.line({ type: "extension_ui_request", id: `u${i}`, method, title: "Allow?" });
		if (FIRE_AND_FORGET.includes(method)) assert.equal(h.child.stdin.written.length, before, method);
		else assert.deepEqual(h.child.stdin.records().slice(before), [{ type: "extension_ui_response", id: `u${i}`, cancelled: true }], method);
	}
	settle(h.child);
	h.child.emit("close", 0);
	const r = await h.p;
	assert.equal(output(r), "done");
	assert.equal(r.messages.length, 1, "UI records are not transcript messages");
	h.cleanup();
});

it("S0: a request split across chunks is answered once complete; 200 requests in one chunk with garbage and CRLF are all answered in order", async () => {
	const h = await start();
	const request = JSON.stringify({ type: "extension_ui_request", id: "split", method: "confirm" });
	h.child.say(request.slice(0, 9));
	h.child.say(request.slice(9, 25));
	assert.equal(h.child.stdin.written.length, 1, "only the prompt so far");
	h.child.say(`${request.slice(25)}\n`);
	assert.deepEqual(h.child.stdin.records().at(-1), { type: "extension_ui_response", id: "split", cancelled: true });
	let blob = "";
	for (let i = 0; i < 200; i++) blob += `${JSON.stringify({ type: "extension_ui_request", id: `m${i}`, method: i % 2 ? "select" : "input" })}${i % 3 ? "\n" : "\r\n"}{broken\n\n`;
	h.child.say(blob);
	assert.deepEqual(
		h.child.stdin.records().slice(2).map((r) => r.id),
		Array.from({ length: 200 }, (_, i) => `m${i}`),
	);
	settle(h.child);
	h.child.emit("close", 0);
	assert.equal((await h.p).exitCode, 0);
	h.cleanup();
});

it("S0: after agent_settled stdin is closed and a late dialog is never written; a child that then never exits is still ended by the watchdog", async () => {
	const h = await start({ BRIGADEV_STALL_TIMEOUT_MS: "1000" });
	settle(h.child);
	assert.equal(h.child.stdin.ended, true);
	h.child.line({ type: "extension_ui_request", id: "late", method: "confirm" });
	assert.equal(h.child.stdin.late, 0);
	h.time.advance(1000);
	assert.deepEqual(h.child.kills, ["SIGTERM"]);
	h.time.advance(5000);
	assert.deepEqual(h.child.kills, ["SIGTERM", "SIGKILL"]);
	h.child.emit("close", null);
	await h.p;
	h.cleanup();
});

it("S0: a prompt that is never acknowledged cannot hang past the stall budget", async () => {
	const h = await start({ BRIGADEV_STALL_TIMEOUT_MS: "1000" });
	h.time.advance(999);
	assert.deepEqual(h.child.kills, []);
	h.time.advance(1);
	assert.deepEqual(h.child.kills, ["SIGTERM"]);
	h.child.emit("close", null);
	const r = await h.p;
	assert.equal(r.exitCode, 1);
	assert.match(r.errorMessage ?? "", /^stalled for /);
	h.cleanup();
});

it("S0: a rejected prompt closes stdin and says why", async () => {
	const h = await start();
	h.child.line({ type: "response", command: "prompt", success: false, error: "No model selected" });
	assert.equal(h.child.stdin.ended, true);
	h.child.emit("close", 1);
	const r = await h.p;
	assert.equal(r.stopReason, "error");
	assert.equal(output(r), "Pi rejected the task: No model selected");
	h.cleanup();
});
