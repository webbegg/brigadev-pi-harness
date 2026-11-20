import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import webUi from "../extensions/web-ui.ts";
import { BUS } from "../lib/bus.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

// These tests are about the parent session, whatever shell runs them (a subagent's shell has BRIGADEV_CHILD=1).
delete process.env.BRIGADEV_CHILD;

interface Harness {
	pi: ReturnType<typeof createFakePi>;
	ctx: ReturnType<typeof createFakeCtx> & { aborted: number };
	sent: Array<{ text: string; options: unknown }>;
	command: (args?: string) => Promise<void>;
	url(): string;
	port(): number;
}

function setup(): Harness {
	const pi = createFakePi();
	const sent: Harness["sent"] = [];
	(pi as any).sendUserMessage = (text: string, options?: unknown) => void sent.push({ text, options });
	webUi(pi as any);
	const ctx = createFakeCtx({ cwd: "/tmp" }) as Harness["ctx"];
	ctx.aborted = 0;
	(ctx as any).abort = () => void ctx.aborted++;
	const urlOf = () => {
		const n = [...ctx.notifications].reverse().find((x) => /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}/.test(x.message));
		assert.ok(n, `no url notified: ${JSON.stringify(ctx.notifications)}`);
		return /http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}/.exec(n.message)![0];
	};
	return {
		pi,
		ctx,
		sent,
		command: (args = "") => pi.commands.get("brigadev:web").handler(args, ctx),
		url: urlOf,
		port: () => Number(new URL(urlOf()).port),
	};
}

const tokenOf = (url: string) => new URL(url).searchParams.get("token")!;

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, path, headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }));
		});
		req.on("error", reject);
		req.end();
	});
}

function post(port: number, token: string, body: unknown): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method: "POST", path: "/action", headers: { "content-type": "application/json", "x-brigadev-token": token } }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

/** Reads the replay of /events (what the log holds now) and closes. */
function snapshot(port: number, token: string): Promise<any[]> {
	return new Promise((resolve, reject) => {
		const events: any[] = [];
		const req = request({ host: "127.0.0.1", port, path: `/events?token=${token}&since=0` }, (res) => {
			res.setEncoding("utf8");
			let buffer = "";
			res.on("data", (chunk: string) => (buffer += chunk));
			setTimeout(() => {
				for (const message of buffer.split("\n\n")) {
					const data = /^data: (.*)$/m.exec(message);
					if (data) events.push(JSON.parse(data[1]));
				}
				req.destroy();
				resolve(events);
			}, 60);
		});
		req.on("error", (e) => {
			if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
		});
		req.end();
	});
}

const stop = async (h: Harness) => h.pi.fire("session_shutdown", { type: "session_shutdown" }, h.ctx);

test("web-ui: registers the command in the parent and nothing in a child session", () => {
	const parent = setup();
	assert.ok(parent.pi.commands.has("brigadev:web"));
	assert.ok(parent.pi.handlers.has("message_end"));
	const before = process.env.BRIGADEV_CHILD;
	process.env.BRIGADEV_CHILD = "1";
	try {
		const pi = createFakePi();
		webUi(pi as any);
		assert.equal(pi.commands.size, 0);
		assert.equal(pi.handlers.size, 0);
	} finally {
		if (before === undefined) delete process.env.BRIGADEV_CHILD;
		else process.env.BRIGADEV_CHILD = before;
	}
});

test("web-ui: never starts a server without the command", async () => {
	const h = setup();
	await h.pi.fire("agent_start", { type: "agent_start" }, h.ctx);
	assert.deepEqual(h.ctx.notifications, []);
	assert.deepEqual(h.ctx.statuses, []);
});

test("web-ui: start notifies a tokenized loopback url and sets the status; a second start reports the same url", async () => {
	const h = setup();
	try {
		await h.command("");
		const url = h.url();
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{64}$/);
		assert.deepEqual(h.ctx.statuses.at(-1), { key: "brigadev-web", text: `web :${h.port()}` });
		const page = await get(h.port(), `/?token=${tokenOf(url)}`);
		assert.equal(page.status, 200);
		assert.match(page.body, /<html/i);
		const count = h.ctx.notifications.length;
		await h.command("start");
		assert.equal(h.ctx.notifications.length, count + 1);
		assert.equal(h.url(), url, "the running url, not a new server");
	} finally {
		await stop(h);
	}
});

test("web-ui: status, stop, and a restart with a fresh token", async () => {
	const h = setup();
	try {
		await h.command("status");
		assert.match(h.ctx.notifications.at(-1)!.message, /not running/i);
		await h.command("start");
		const url = h.url();
		await h.command("status");
		assert.ok(h.ctx.notifications.at(-1)!.message.includes(url));
		const port = h.port();
		await h.command("stop");
		assert.deepEqual(h.ctx.statuses.at(-1), { key: "brigadev-web", text: undefined });
		await assert.rejects(get(port, "/"));
		await h.command("stop");
		assert.match(h.ctx.notifications.at(-1)!.message, /not running/i);
		await h.command("start");
		assert.notEqual(tokenOf(h.url()), tokenOf(url));
		await h.command("bogus");
		assert.match(h.ctx.notifications.at(-1)!.message, /usage/i);
	} finally {
		await stop(h);
	}
});

test("web-ui: BRIGADEV_WEB_PORT picks the port", async () => {
	const probe = setup();
	await probe.command("start");
	const free = probe.port();
	await probe.command("stop");
	const before = process.env.BRIGADEV_WEB_PORT;
	process.env.BRIGADEV_WEB_PORT = String(free);
	const h = setup();
	try {
		await h.command("start");
		assert.equal(h.port(), free);
	} finally {
		if (before === undefined) delete process.env.BRIGADEV_WEB_PORT;
		else process.env.BRIGADEV_WEB_PORT = before;
		await stop(h);
	}
});

test("web-ui: session_shutdown closes the server", async () => {
	const h = setup();
	await h.command("start");
	const port = h.port();
	await stop(h);
	await assert.rejects(get(port, "/"));
});

test("web-ui: bus state from before start is replayable, keyed to the newest snapshot", async () => {
	const h = setup();
	try {
		h.pi.events.emit(BUS.agent, { id: "l:0", status: "running", tokens: 1 });
		h.pi.events.emit(BUS.agent, { id: "l:0", status: "done", tokens: 9 });
		h.pi.events.emit(BUS.phase, { scope: "loop", phase: "explore" });
		h.pi.events.emit(BUS.check, { id: "c1", command: "npm test", outcome: "pass", at: 1 });
		h.pi.events.emit(BUS.guard, { id: "g1", action: "allow", at: 1 });
		h.pi.events.emit(BUS.prompt, { id: "p1", status: "open" });
		h.pi.events.emit(BUS.mode, { scope: "mode", mode: "default" });
		h.pi.events.emit(BUS.todo, { scope: "todo", todos: [] });
		await h.command("start");
		const events = await snapshot(h.port(), tokenOf(h.url()));
		const types = events.map((e) => e.type);
		assert.deepEqual(types, ["brigadev_agent", "brigadev_phase", "brigadev_check", "brigadev_guard", "brigadev_prompt", "brigadev_mode", "brigadev_todo"]);
		assert.equal(events[0].data.status, "done");
		assert.equal(events[0].key, "l:0");
		assert.deepEqual(events.map((e) => e.seq), [...events.map((e) => e.seq)].sort((a, b) => a - b));
	} finally {
		await stop(h);
	}
});

test("web-ui: core events become compact run, message and tool events", async () => {
	const h = setup();
	try {
		await h.command("start");
		const { pi, ctx } = h;
		await pi.fire("agent_start", { type: "agent_start" }, ctx);
		await pi.fire("message_end", { type: "message_end", message: { role: "user", content: [{ type: "text", text: "fix it" }] } }, ctx);
		await pi.fire("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: "SECRET" }, { type: "text", text: "on it" }, { type: "toolCall", name: "edit", arguments: { content: "BODY" } }] } }, ctx);
		await pi.fire("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "x".repeat(30_000) }] } }, ctx);
		await pi.fire("message_end", { type: "message_end", message: { role: "toolResult", content: [{ type: "text", text: "RESULT" }] } }, ctx);
		await pi.fire("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } }, ctx);
		await pi.fire("tool_execution_start", { toolCallId: "t1", toolName: "edit", args: { path: "lib/a.ts", oldText: "OLD", newText: "NEW BODY" } }, ctx);
		await pi.fire("tool_execution_start", { toolCallId: "t2", toolName: "bash", args: { command: `echo ${"y".repeat(400)}\nsecond` } }, ctx);
		await pi.fire("tool_execution_end", { toolCallId: "t1", toolName: "edit", result: { content: [{ type: "text", text: "FULL RESULT" }] }, isError: false, durationMs: 12 }, ctx);
		await pi.fire("tool_execution_end", { toolCallId: "t2", toolName: "bash", result: "FULL", isError: true, durationMs: 5 }, ctx);
		await pi.fire("agent_end", { type: "agent_end" }, ctx);

		const events = await snapshot(h.port(), tokenOf(h.url()));
		const raw = JSON.stringify(events);
		for (const leak of ["SECRET", "BODY", "RESULT", "OLD", "FULL"]) assert.ok(!raw.includes(leak), `leaked ${leak}`);

		const messages = events.filter((e) => e.type === "message").map((e) => e.data);
		assert.equal(messages.length, 3, "user, assistant, assistant (no tool-only or toolResult)");
		assert.deepEqual([messages[0].role, messages[0].text], ["user", "fix it"]);
		assert.deepEqual([messages[1].role, messages[1].text], ["assistant", "on it"]);
		assert.ok(messages[2].text.length <= 20_100);

		const tools = events.filter((e) => e.type === "tool").map((e) => e.data);
		assert.equal(tools.length, 2, "one snapshot per tool call");
		const edit = tools.find((t) => t.id === "t1");
		assert.deepEqual({ ...edit, at: undefined }, { id: "t1", name: "edit", summary: "lib/a.ts", status: "done", durationMs: 12, at: undefined });
		const bash = tools.find((t) => t.id === "t2");
		assert.equal(bash.status, "error");
		assert.ok(bash.summary.length <= 200);
		assert.ok(!bash.summary.includes("\n"));

		const runs = events.filter((e) => e.type === "run").map((e) => e.data);
		assert.equal(runs.length, 1);
		assert.equal(runs[0].running, false);
	} finally {
		await stop(h);
	}
});

test("web-ui: assistant streaming text is a throttled keyed snapshot cleared at message_end", async () => {
	const h = setup();
	try {
		await h.command("start");
		const { pi, ctx } = h;
		const live = () => (pi as any).__live as any;
		void live;
		const update = (text: string) => pi.fire("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] }, assistantMessageEvent: { type: "text_delta" } }, ctx);
		await update("a");
		await update("ab");
		await update("abc");
		await new Promise((r) => setTimeout(r, 260));
		let events = await snapshot(h.port(), tokenOf(h.url()));
		let lives = events.filter((e) => e.type === "assistant_live");
		assert.equal(lives.length, 1, "keyed: one snapshot");
		assert.equal(lives[0].data.text, "abc", "the trailing update is flushed");
		assert.equal(lives[0].data.active, true);
		await pi.fire("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "abc" }] } }, ctx);
		events = await snapshot(h.port(), tokenOf(h.url()));
		lives = events.filter((e) => e.type === "assistant_live");
		assert.equal(lives.length, 1);
		assert.equal(lives[0].data.active, false);
		assert.equal(lives[0].data.text, "");
		// user message updates never show as assistant text
		await pi.fire("message_update", { type: "message_update", message: { role: "user", content: [{ type: "text", text: "u" }] } }, ctx);
		await new Promise((r) => setTimeout(r, 200));
		events = await snapshot(h.port(), tokenOf(h.url()));
		assert.equal(events.filter((e) => e.type === "assistant_live")[0].data.active, false);
	} finally {
		await stop(h);
	}
});

test("web-ui: a live bus event reaches an open SSE stream", async () => {
	const h = setup();
	try {
		await h.command("start");
		const got = await new Promise<any>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: h.port(), path: `/events?token=${tokenOf(h.url())}` }, (res) => {
				res.setEncoding("utf8");
				res.on("data", (chunk: string) => {
					const m = /^data: (.*)$/m.exec(chunk);
					if (m) (req.destroy(), resolve(JSON.parse(m[1])));
				});
			});
			req.on("error", (e) => {
				if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
			});
			req.end();
			setTimeout(() => h.pi.events.emit(BUS.guard, { id: "g9", action: "block", at: 1 }), 50);
		});
		assert.equal(got.type, "brigadev_guard");
		assert.equal(got.data.id, "g9");
	} finally {
		await stop(h);
	}
});

test("web-ui: prompt actions send a user message: followUp when busy, plain when idle, steer on request", async () => {
	const h = setup();
	try {
		await h.command("start");
		const [port, token] = [h.port(), tokenOf(h.url())];
		h.ctx.idle = false;
		assert.equal(await post(port, token, { action: "prompt", text: "busy" }), 202);
		assert.equal(await post(port, token, { action: "prompt", text: "now", deliverAs: "steer" }), 202);
		h.ctx.idle = true;
		assert.equal(await post(port, token, { action: "prompt", text: "idle" }), 202);
		assert.equal(await post(port, token, { action: "prompt", text: "idle steer", deliverAs: "steer" }), 202);
		assert.deepEqual(h.sent, [
			{ text: "busy", options: { deliverAs: "followUp" } },
			{ text: "now", options: { deliverAs: "steer" } },
			{ text: "idle", options: undefined },
			{ text: "idle steer", options: undefined },
		]);
	} finally {
		await stop(h);
	}
});

test("web-ui: abort calls the latest ctx's abort", async () => {
	const h = setup();
	try {
		await h.command("start");
		const later = createFakeCtx({ cwd: "/tmp" }) as any;
		let laterAborted = 0;
		later.abort = () => void laterAborted++;
		await h.pi.fire("agent_start", { type: "agent_start" }, later);
		assert.equal(await post(h.port(), tokenOf(h.url()), { action: "abort" }), 202);
		assert.equal(laterAborted, 1);
		assert.equal(h.ctx.aborted, 0);
	} finally {
		await stop(h);
	}
});

test("web-ui: answer and cancel-agent are re-emitted on the bus, validated; invalid ones never are", async () => {
	const h = setup();
	try {
		await h.command("start");
		const [port, token] = [h.port(), tokenOf(h.url())];
		assert.equal(await post(port, token, { action: "answer", id: "p1", value: "Option A" }), 202);
		assert.equal(await post(port, token, { action: "cancel-agent", id: "l:0", junk: 1 }), 202);
		assert.equal(await post(port, token, { action: "answer", id: "p1" }), 400);
		const actions = h.pi.emitted.filter((e) => e.channel === BUS.action).map((e) => e.data);
		assert.deepEqual(actions, [
			{ action: "answer", id: "p1", value: "Option A" },
			{ action: "cancel-agent", id: "l:0" },
		]);
		assert.equal(h.sent.length, 0);
	} finally {
		await stop(h);
	}
});
