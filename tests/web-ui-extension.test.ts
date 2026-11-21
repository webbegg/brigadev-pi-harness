import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import webUi from "../extensions/web-ui.ts";
import { BUS, CHANNELS, createBus, type Bus } from "../lib/bus.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

// These tests are about the parent session, whatever shell runs them (a subagent's shell has BRIGADEV_CHILD=1).
delete process.env.BRIGADEV_CHILD;

interface Harness {
	pi: ReturnType<typeof createFakePi>;
	ctx: ReturnType<typeof createFakeCtx> & { aborted: number };
	sent: Array<{ text: string; options: unknown }>;
	command: (args?: string) => Promise<void>;
	/** The latest URL the command printed. */
	url(): string;
	port(): number;
}

const URL_RE = /http:\/\/127\.0\.0\.1:\d+\/(\?code=[A-Za-z0-9_-]{43})?/;

function setup(bus?: Bus): Harness {
	const pi = createFakePi();
	if (bus) pi.events = bus;
	const sent: Harness["sent"] = [];
	(pi as any).sendUserMessage = (text: string, options?: unknown) => void sent.push({ text, options });
	webUi(pi as any);
	const ctx = createFakeCtx({ cwd: "/tmp" }) as Harness["ctx"];
	ctx.aborted = 0;
	(ctx as any).abort = () => void ctx.aborted++;
	const urlOf = () => {
		const n = [...ctx.notifications].reverse().find((x) => URL_RE.test(x.message));
		assert.ok(n, `no url notified: ${JSON.stringify(ctx.notifications)}`);
		return URL_RE.exec(n.message)![0];
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

const codeOf = (url: string) => new URL(url).searchParams.get("code")!;
const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });

function get(port: number, path: string, headers: Record<string, string> = {}, method = "GET"): Promise<{ status: number; body: string; headers: Record<string, unknown> }> {
	return new Promise((resolve, reject) => {
		// agent: false, so a restart on the same port never reuses a socket of the server that was stopped.
		const req = request({ host: "127.0.0.1", port, path, headers, method, agent: false }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(), headers: res.headers }));
		});
		req.on("error", reject);
		req.end();
	});
}

/** What the page does with the link's code. */
async function exchange(port: number, code: string): Promise<{ status: number; secret?: string }> {
	const reply = await get(port, "/session", { "x-brigadev-code": code }, "POST");
	return { status: reply.status, secret: reply.status === 200 ? JSON.parse(reply.body).secret : undefined };
}

/** Exchanges the latest printed link for a session secret. */
async function login(h: Harness): Promise<string> {
	const reply = await exchange(h.port(), codeOf(h.url()));
	assert.equal(reply.status, 200);
	return reply.secret!;
}

function post(port: number, secret: string, body: unknown): Promise<number> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port, method: "POST", path: "/action", headers: { "content-type": "application/json", ...auth(secret) }, agent: false }, (res) => {
			res.resume();
			resolve(res.statusCode ?? 0);
		});
		req.on("error", reject);
		req.end(JSON.stringify(body));
	});
}

/** Reads the replay of /events (what the log holds now) and closes. */
function snapshot(port: number, secret: string): Promise<any[]> {
	return new Promise((resolve, reject) => {
		const events: any[] = [];
		const req = request({ host: "127.0.0.1", port, path: "/events?since=0", headers: auth(secret) }, (res) => {
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

test("web-ui: publishes the session's project and branch at start and after each run", async () => {
	const h = setup();
	let branch = "feat/one";
	(h.pi as any).exec = async (command: string, args: string[]) => ({ stdout: command === "git" && args.includes("symbolic-ref") ? `${branch}\n` : "", stderr: "", code: 0, killed: false });
	const ctx = createFakeCtx({ cwd: "/tmp/my-proj" }) as any;
	try {
		await h.pi.fire("session_start", { type: "session_start", reason: "startup" }, ctx);
		await h.command("");
		const secret = await login(h);
		const first = (await snapshot(h.port(), secret)).filter((e) => e.type === "session");
		assert.deepEqual(first.at(-1)?.data, { id: "session", project: "my-proj", branch: "feat/one" });
		branch = "feat/two";
		await h.pi.fire("agent_end", { type: "agent_end" }, ctx);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const second = (await snapshot(h.port(), secret)).filter((e) => e.type === "session");
		assert.equal(second.at(-1)?.data.branch, "feat/two");
	} finally {
		await stop(h);
	}
});

test("web-ui: never starts a server without the command", async () => {
	const h = setup();
	await h.pi.fire("agent_start", { type: "agent_start" }, h.ctx);
	assert.deepEqual(h.ctx.notifications, []);
	assert.deepEqual(h.ctx.statuses, []);
});

test("web-ui: start prints a one-time link (code in the query, 60 s) and sets the status; the page it serves holds no secret", async () => {
	const h = setup();
	try {
		await h.command("");
		const url = h.url();
		assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/\?code=[A-Za-z0-9_-]{43}$/);
		assert.match(h.ctx.notifications.at(-1)!.message, /60 s/);
		assert.deepEqual(h.ctx.statuses.at(-1), { key: "brigadev-web", text: `web :${h.port()}` });
		const page = await get(h.port(), `/?code=${codeOf(url)}`);
		assert.equal(page.status, 200);
		assert.match(page.body, /<html/i);
		assert.ok(!page.body.includes(codeOf(url)), "the page does not echo the code");
		const exchanged = await exchange(h.port(), codeOf(url));
		assert.equal(exchanged.status, 200);
		assert.equal((await exchange(h.port(), codeOf(url))).status, 401, "the link works once");
	} finally {
		await stop(h);
	}
});

test("web-ui: open mints a new code for the running server; start while running behaves like open; status shows the url without a code", async () => {
	const h = setup();
	try {
		await h.command("open");
		assert.match(h.ctx.notifications.at(-1)!.message, /not running/i);

		await h.command("start");
		const first = h.url();
		const port = h.port();
		await h.command("open");
		const second = h.url();
		assert.equal(new URL(second).port, String(port), "the same server");
		assert.notEqual(codeOf(second), codeOf(first));
		await h.command("start");
		const third = h.url();
		assert.equal(new URL(third).port, String(port));
		assert.notEqual(codeOf(third), codeOf(second));
		assert.equal(h.ctx.statuses.filter((s) => s.text === `web :${port}`).length >= 1, true);

		// every link works once; minting a new one did not spend or revoke the others
		for (const url of [first, second, third]) assert.equal((await exchange(port, codeOf(url))).status, 200);
		assert.equal((await exchange(port, codeOf(second))).status, 401);

		await h.command("status");
		const status = h.ctx.notifications.at(-1)!.message;
		assert.match(status, /running/);
		assert.ok(status.includes(`http://127.0.0.1:${port}/`));
		assert.ok(!/code=/.test(status), `status shows no code: ${status}`);
	} finally {
		await stop(h);
	}
});

test("web-ui: status, stop, and a restart with a fresh link", async () => {
	const h = setup();
	try {
		await h.command("status");
		assert.match(h.ctx.notifications.at(-1)!.message, /not running/i);
		await h.command("start");
		const url = h.url();
		const port = h.port();
		await h.command("stop");
		assert.deepEqual(h.ctx.statuses.at(-1), { key: "brigadev-web", text: undefined });
		await assert.rejects(get(port, "/"));
		await h.command("stop");
		assert.match(h.ctx.notifications.at(-1)!.message, /not running/i);
		await h.command("start");
		assert.notEqual(codeOf(h.url()), codeOf(url));
		await h.command("bogus");
		assert.match(h.ctx.notifications.at(-1)!.message, /usage: \/brigadev:web \[start\|open\|stop\|status\]/i);
	} finally {
		await stop(h);
	}
});

test("web-ui: stop revokes every session secret: after a restart on the same port an old secret is 401", async () => {
	const probe = setup();
	await probe.command("start");
	const free = probe.port();
	await probe.command("stop");
	const before = process.env.BRIGADEV_WEB_PORT;
	process.env.BRIGADEV_WEB_PORT = String(free);
	const h = setup();
	try {
		await h.command("start");
		const secret = await login(h);
		await h.command("open");
		const other = await login(h); // another tab, another link
		assert.equal(await post(free, secret, { action: "abort" }), 202);
		assert.equal(await post(free, other, { action: "abort" }), 202);
		await h.command("stop");
		await h.command("start");
		assert.equal(h.port(), free);
		assert.equal(await post(free, secret, { action: "abort" }), 401);
		assert.equal(await post(free, other, { action: "abort" }), 401);
		assert.equal((await get(free, "/events", auth(secret))).status, 401);
		assert.equal(await post(free, await login(h), { action: "abort" }), 202);
	} finally {
		if (before === undefined) delete process.env.BRIGADEV_WEB_PORT;
		else process.env.BRIGADEV_WEB_PORT = before;
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

test("web-ui: the page keeps the secret in a JS variable only (static check: no storage, cookie, IndexedDB, EventSource or query-string credential)", async () => {
	const h = setup();
	try {
		await h.command("start");
		const { body: page } = await get(h.port(), "/");
		for (const forbidden of ["localStorage", "sessionStorage", "document.cookie", "indexedDB", "EventSource", "x-brigadev-token", "?token=", "token="]) {
			assert.ok(!page.includes(forbidden), `the page uses ${forbidden}`);
		}
		// what it does instead
		assert.match(page, /history\.replaceState/);
		assert.match(page, /\/session/);
		assert.match(page, /X-Brigadev-Code/i);
		assert.match(page, /Bearer /);
		assert.match(page, /Last-Event-ID/i);
		assert.ok(page.includes("This link was already used or expired. In pi, run /brigadev:web open for a new one."));
		// the code is read from `location`, removed from the address bar before anything else uses it
		assert.ok(page.indexOf("replaceState") < page.indexOf("/session"), "the address is cleaned before the exchange");
		assert.ok(!/["']\/events\?[^"']*(secret|token|code)/i.test(page), "no credential in the /events query");
	} finally {
		await stop(h);
	}
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
		const events = await snapshot(h.port(), await login(h));
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

		const events = await snapshot(h.port(), await login(h));
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

test("web-ui: tool summaries are redacted before they reach the page", async () => {
	const h = setup();
	try {
		await h.command("start");
		const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
		await h.pi.fire("tool_execution_start", { toolCallId: "r1", toolName: "bash", args: { command: `git clone https://me:${token}@github.com/o/r && curl -H "Authorization: Bearer abc.def" x --password=hunter2` } }, h.ctx);
		await h.pi.fire("tool_execution_end", { toolCallId: "r1", toolName: "bash", isError: false, durationMs: 1 }, h.ctx);
		const raw = JSON.stringify(await snapshot(h.port(), await login(h)));
		for (const leak of [token, "me:", "abc.def", "hunter2"]) assert.ok(!raw.includes(leak), `leaked ${leak}`);
		assert.match(raw, /https:\/\/\*\*\*@github\.com/);
	} finally {
		await stop(h);
	}
});

test("web-ui: a tool call made inside a codemode script is on the timeline, marked with its parent", async () => {
	const h = setup();
	try {
		await h.command("start");
		await h.pi.fire("agent_start", { type: "agent_start" }, h.ctx);
		await h.pi.fire("tool_execution_start", { toolCallId: "c1", toolName: "codemode", args: {} }, h.ctx);
		await h.pi.fire("tool_execution_start", { toolCallId: "c1/1", parentToolCallId: "c1", toolName: "read", args: { path: "lib/a.ts" } }, h.ctx);
		await h.pi.fire("tool_execution_end", { toolCallId: "c1/1", parentToolCallId: "c1", toolName: "read", isError: false, durationMs: 3 }, h.ctx);
		await h.pi.fire("tool_execution_end", { toolCallId: "c1", toolName: "codemode", isError: false, durationMs: 9 }, h.ctx);
		const tools = (await snapshot(h.port(), await login(h))).filter((e) => e.type === "tool").map((e) => e.data);
		const nested = tools.find((t) => t.id === "c1/1");
		const parent = tools.find((t) => t.id === "c1");
		assert.deepEqual([nested.name, nested.summary, nested.parentId, nested.status], ["read", "lib/a.ts", "c1", "done"]);
		assert.deepEqual([parent.name, parent.parentId], ["codemode", undefined]);
	} finally {
		await stop(h);
	}
});

test("web-ui: assistant streaming text is a throttled keyed snapshot cleared at message_end", async () => {
	const h = setup();
	try {
		await h.command("start");
		const { pi, ctx } = h;
		const secret = await login(h);
		const update = (text: string) => pi.fire("message_update", { type: "message_update", message: { role: "assistant", content: [{ type: "text", text }] }, assistantMessageEvent: { type: "text_delta" } }, ctx);
		await update("a");
		await update("ab");
		await update("abc");
		await new Promise((r) => setTimeout(r, 260));
		let events = await snapshot(h.port(), secret);
		let lives = events.filter((e) => e.type === "assistant_live");
		assert.equal(lives.length, 1, "keyed: one snapshot");
		assert.equal(lives[0].data.text, "abc", "the trailing update is flushed");
		assert.equal(lives[0].data.active, true);
		await pi.fire("message_end", { type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "abc" }] } }, ctx);
		events = await snapshot(h.port(), secret);
		lives = events.filter((e) => e.type === "assistant_live");
		assert.equal(lives.length, 1);
		assert.equal(lives[0].data.active, false);
		assert.equal(lives[0].data.text, "");
		// user message updates never show as assistant text
		await pi.fire("message_update", { type: "message_update", message: { role: "user", content: [{ type: "text", text: "u" }] } }, ctx);
		await new Promise((r) => setTimeout(r, 200));
		events = await snapshot(h.port(), secret);
		assert.equal(events.filter((e) => e.type === "assistant_live")[0].data.active, false);
	} finally {
		await stop(h);
	}
});

test("web-ui: a live bus event reaches an open SSE stream", async () => {
	const h = setup();
	try {
		await h.command("start");
		const secret = await login(h);
		const got = await new Promise<any>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: h.port(), path: "/events", headers: auth(secret) }, (res) => {
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
		const [port, secret] = [h.port(), await login(h)];
		h.ctx.idle = false;
		assert.equal(await post(port, secret, { action: "prompt", text: "busy" }), 202);
		assert.equal(await post(port, secret, { action: "prompt", text: "now", deliverAs: "steer" }), 202);
		h.ctx.idle = true;
		assert.equal(await post(port, secret, { action: "prompt", text: "idle" }), 202);
		assert.equal(await post(port, secret, { action: "prompt", text: "idle steer", deliverAs: "steer" }), 202);
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
		assert.equal(await post(h.port(), await login(h), { action: "abort" }), 202);
		assert.equal(laterAborted, 1);
		assert.equal(h.ctx.aborted, 0);
	} finally {
		await stop(h);
	}
});

test("web-ui: an answer to a prompt that is not open (never opened, answered, dismissed by an abort) is refused with 409 and never reaches the bus", async () => {
	const h = setup();
	try {
		await h.command("start");
		const [port, secret] = [h.port(), await login(h)];
		const answers = () => h.pi.emitted.filter((e) => e.channel === BUS.action).length;
		assert.equal(await post(port, secret, { action: "answer", id: "nope", value: "A" }), 409, "never opened");
		h.pi.events.emit(BUS.prompt, { id: "p2", status: "open", at: 1 });
		h.pi.events.emit(BUS.prompt, { id: "p2", status: "dismissed", at: 2 });
		assert.equal(await post(port, secret, { action: "answer", id: "p2", value: "A" }), 409, "dismissed (the run was aborted)");
		h.pi.events.emit(BUS.prompt, { id: "p3", status: "open", at: 3 });
		h.pi.events.emit(BUS.prompt, { id: "p3", status: "answered", by: "tui", at: 4 });
		assert.equal(await post(port, secret, { action: "answer", id: "p3", value: "A" }), 409, "already answered in the terminal");
		assert.equal(answers(), 0);
	} finally {
		await stop(h);
	}
});

test("web-ui: answer and cancel-agent are re-emitted on the bus, validated; invalid ones never are", async () => {
	const h = setup();
	try {
		await h.command("start");
		const [port, secret] = [h.port(), await login(h)];
		h.pi.events.emit(BUS.prompt, { id: "p1", status: "open", at: 1 });
		assert.equal(await post(port, secret, { action: "answer", id: "p1", value: "Option A" }), 202);
		assert.equal(await post(port, secret, { action: "cancel-agent", id: "l:0", junk: 1 }), 202);
		assert.equal(await post(port, secret, { action: "answer", id: "p1" }), 400);
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

/** A bus that counts its live subscriptions per channel. */
function countingBus() {
	const inner = createBus();
	const live = new Map<string, number>();
	const bus: Bus = {
		emit: (channel, data) => inner.emit(channel, data),
		on(channel, handler) {
			const off = inner.on(channel, handler);
			live.set(channel, (live.get(channel) ?? 0) + 1);
			let done = false;
			return () => {
				if (done) return;
				done = true;
				off();
				live.set(channel, (live.get(channel) ?? 1) - 1);
			};
		},
	};
	return { bus, live: (channel: string) => live.get(channel) ?? 0 };
}

test("web-ui: session_shutdown removes every bus listener, so a reload on the same bus leaves exactly one", async () => {
	const counted = countingBus();
	const channels = Object.keys(CHANNELS);
	const first = setup(counted.bus);
	for (const channel of channels) assert.equal(counted.live(channel), 1, `${channel} after the first load`);
	const second = setup(counted.bus); // a reload: Pi's bus outlives the extension
	for (const channel of channels) assert.equal(counted.live(channel), 2, `${channel} with both loaded`);
	await stop(first);
	for (const channel of channels) assert.equal(counted.live(channel), 1, `${channel} after the first one shut down`);

	// and the one left still feeds its own log, once
	try {
		await second.command("start");
		counted.bus.emit(BUS.guard, { id: "g1", action: "allow", at: 1 });
		const guards = (await snapshot(second.port(), await login(second))).filter((e) => e.type === "brigadev_guard");
		assert.equal(guards.length, 1);
	} finally {
		await stop(second);
	}
	for (const channel of channels) assert.equal(counted.live(channel), 0, `${channel} after both shut down`);
});
