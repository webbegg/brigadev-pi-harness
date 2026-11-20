import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { Action } from "../lib/bus.ts";
import { createWebLog } from "../lib/web-log.ts";
import { startWebServer, type WebServer } from "../lib/web-server.ts";

const TOKEN = "t".repeat(64);
const HTML = "<!doctype html><title>x</title>";

async function boot(options: { heartbeatMs?: number } = {}) {
	const log = createWebLog();
	const actions: Action[] = [];
	const server = await startWebServer({ host: "127.0.0.1", port: 0, token: TOKEN, html: HTML, log, onAction: (a) => void actions.push(a), ...options });
	return { log, actions, server };
}

interface Reply {
	status: number;
	headers: Record<string, string | string[] | undefined>;
	body: string;
}

function send(server: WebServer, options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Reply> {
	return new Promise((resolve, reject) => {
		const req = request({ host: "127.0.0.1", port: server.port, method: options.method ?? "GET", path: options.path, headers: options.headers }, (res) => {
			const chunks: Buffer[] = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
		});
		req.on("error", reject);
		req.end(options.body);
	});
}

const post = (server: WebServer, body: unknown, headers: Record<string, string> = {}) =>
	send(server, { method: "POST", path: "/action", headers: { "content-type": "application/json", "x-brigadev-token": TOKEN, ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

interface Sse {
	events: Array<{ id: number; data: any }>;
	raw: string[];
	headers: Record<string, string | string[] | undefined>;
	status: number;
	waitFor(count: number): Promise<void>;
	close(): void;
}

function sse(server: WebServer, path: string, headers: Record<string, string> = {}): Promise<Sse> {
	return new Promise((resolve, reject) => {
		const state = { events: [] as Sse["events"], raw: [] as string[] };
		const waiters: Array<{ count: number; done: () => void }> = [];
		let buffer = "";
		const req = request({ host: "127.0.0.1", port: server.port, path, headers }, (res) => {
			res.setEncoding("utf8");
			res.on("data", (chunk: string) => {
				buffer += chunk;
				let at: number;
				while ((at = buffer.indexOf("\n\n")) >= 0) {
					const message = buffer.slice(0, at);
					buffer = buffer.slice(at + 2);
					state.raw.push(message);
					const id = /^id: (\d+)$/m.exec(message);
					const data = /^data: (.*)$/m.exec(message);
					if (id && data) state.events.push({ id: Number(id[1]), data: JSON.parse(data[1]) });
				}
				for (const w of [...waiters]) if (state.events.length >= w.count) w.done();
			});
			resolve({
				...state,
				events: state.events,
				raw: state.raw,
				headers: res.headers,
				status: res.statusCode ?? 0,
				waitFor: (count) =>
					new Promise((ok, fail) => {
						if (state.events.length >= count) return ok();
						const timer = setTimeout(() => fail(new Error(`waited for ${count} events, got ${state.events.length}`)), 3000);
						waiters.push({ count, done: () => (clearTimeout(timer), ok()) });
					}),
				close: () => req.destroy(),
			});
		});
		req.on("error", (e) => {
			if ((e as NodeJS.ErrnoException).code !== "ECONNRESET") reject(e);
		});
		req.end();
	});
}

const q = (extra = "") => `/events?token=${TOKEN}${extra}`;

test("web-server: binds to loopback on an ephemeral port and builds the url", async () => {
	const { server } = await boot();
	try {
		assert.ok(server.port > 0);
		assert.equal(server.url, `http://127.0.0.1:${server.port}/?token=${TOKEN}`);
	} finally {
		await server.close();
	}
});

test("web-server: GET / serves the static page without the token (it holds no data; a reload after the page strips the token still loads), with security headers", async () => {
	const { server } = await boot();
	try {
		for (const path of ["/", "/?token=nope"]) {
			const bare = await send(server, { path });
			assert.equal(bare.status, 200, path);
			assert.equal(bare.body, HTML, path);
		}
		const ok = await send(server, { path: `/?token=${TOKEN}` });
		assert.equal(ok.status, 200);
		assert.equal(ok.body, HTML);
		assert.match(String(ok.headers["content-type"]), /^text\/html/);
		assert.match(String(ok.headers["content-security-policy"]), /default-src 'self'/);
		assert.match(String(ok.headers["content-security-policy"]), /script-src[^;]*'unsafe-inline'/);
		assert.equal(ok.headers["x-content-type-options"], "nosniff");
		assert.equal(ok.headers["cache-control"], "no-store");
		assert.equal(ok.headers["referrer-policy"], "no-referrer");
		const denied = await send(server, { path: "/" });
		assert.equal(denied.headers["x-content-type-options"], "nosniff", "headers on errors too");
	} finally {
		await server.close();
	}
});

test("web-server: every other path is 404", async () => {
	const { server } = await boot();
	try {
		for (const path of ["/index.html", "/favicon.ico", "/actions", "/events/x", `/foo?token=${TOKEN}`, "/../etc/passwd"]) {
			assert.equal((await send(server, { path })).status, 404, path);
		}
	} finally {
		await server.close();
	}
});

test("web-server: /events and /action answer 401 without or with a wrong token", async () => {
	const { server, actions } = await boot();
	try {
		assert.equal((await send(server, { path: "/events" })).status, 401);
		assert.equal((await send(server, { path: "/events?token=wrong" })).status, 401);
		assert.equal((await send(server, { method: "POST", path: "/action", headers: { "content-type": "application/json" }, body: '{"action":"abort"}' })).status, 401);
		assert.equal((await post(server, { action: "abort" }, { "x-brigadev-token": "wrong" })).status, 401);
		assert.equal((await post(server, { action: "abort" }, { "x-brigadev-token": "" })).status, 401);
		assert.deepEqual(actions, []);
	} finally {
		await server.close();
	}
});

test("web-server: a request whose Host is not loopback:<port> is 403 on every endpoint", async () => {
	const { server, actions } = await boot();
	try {
		const bad = [`evil.example:${server.port}`, "127.0.0.1", "127.0.0.1:1", `localhost.evil.com:${server.port}`, `127.0.0.1.evil.com:${server.port}`];
		for (const host of bad) {
			assert.equal((await send(server, { path: `/?token=${TOKEN}`, headers: { host } })).status, 403, host);
			assert.equal((await send(server, { path: q(), headers: { host } })).status, 403, host);
			assert.equal((await post(server, { action: "abort" }, { host })).status, 403, host);
		}
		assert.equal((await send(server, { path: `/?token=${TOKEN}`, headers: { host: `localhost:${server.port}` } })).status, 200);
		assert.deepEqual(actions, []);
	} finally {
		await server.close();
	}
});

test("web-server: POST with a cross Origin is 403; same origin and no Origin pass", async () => {
	const { server, actions } = await boot();
	try {
		assert.equal((await post(server, { action: "abort" }, { origin: "http://evil.example" })).status, 403);
		assert.equal((await post(server, { action: "abort" }, { origin: `http://127.0.0.1:${server.port + 1}` })).status, 403);
		assert.equal((await post(server, { action: "abort" }, { origin: "null" })).status, 403);
		assert.equal(actions.length, 0);
		assert.equal((await post(server, { action: "abort" }, { origin: `http://127.0.0.1:${server.port}` })).status, 202);
		assert.equal((await post(server, { action: "abort" }, { origin: `http://localhost:${server.port}`, host: `localhost:${server.port}` })).status, 202);
		assert.equal((await post(server, { action: "abort" })).status, 202);
		assert.equal(actions.length, 3);
	} finally {
		await server.close();
	}
});

test("web-server: POST /action validates with parseAction and routes the parsed action", async () => {
	const { server, actions } = await boot();
	try {
		const ok = await post(server, { action: "answer", id: "p1", value: true, extra: "dropped" });
		assert.equal(ok.status, 202);
		assert.deepEqual(actions, [{ action: "answer", id: "p1", value: true }]);
		assert.equal((await post(server, { action: "prompt", text: "go", deliverAs: "steer" })).status, 202);
		assert.deepEqual(actions[1], { action: "prompt", text: "go", deliverAs: "steer" });
		for (const bad of [{ action: "rm" }, { action: "answer", id: "p" }, [], "null", "{not json", ""]) {
			const reply = await post(server, bad as any);
			assert.equal(reply.status, 400, JSON.stringify(bad));
		}
		const wrongType = await send(server, { method: "POST", path: "/action", headers: { "content-type": "text/plain", "x-brigadev-token": TOKEN }, body: '{"action":"abort"}' });
		assert.equal(wrongType.status, 400);
		assert.equal(actions.length, 2);
		assert.equal((await send(server, { method: "GET", path: "/action", headers: { "x-brigadev-token": TOKEN } })).status, 405);
	} finally {
		await server.close();
	}
});

test("web-server: a handler that throws answers 500 and the server keeps working", async () => {
	const log = createWebLog();
	let fail = true;
	const server = await startWebServer({
		host: "127.0.0.1",
		port: 0,
		token: TOKEN,
		html: HTML,
		log,
		onAction: () => {
			if (fail) throw new Error("boom");
		},
	});
	try {
		assert.equal((await post(server, { action: "abort" })).status, 500);
		fail = false;
		assert.equal((await post(server, { action: "abort" })).status, 202);
	} finally {
		await server.close();
	}
});

test("web-server: a body over 64 KB is 413, declared or streamed", async () => {
	const { server, actions } = await boot();
	try {
		const big = JSON.stringify({ action: "prompt", text: "x".repeat(70 * 1024) });
		assert.equal((await post(server, big)).status, 413);
		const exact = JSON.stringify({ action: "abort", pad: "y".repeat(60 * 1024) });
		assert.equal((await post(server, exact)).status, 202);
		// chunked: no content-length to reject early
		const chunked = await new Promise<number>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/action", headers: { "content-type": "application/json", "x-brigadev-token": TOKEN, "transfer-encoding": "chunked" } }, (res) => {
				res.resume();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.write('{"action":"prompt","text":"');
			req.write("z".repeat(40 * 1024));
			req.write("z".repeat(40 * 1024));
			req.end('"}');
		});
		assert.equal(chunked, 413);
		assert.equal(actions.length, 1);
	} finally {
		await server.close();
	}
});

test("web-server: SSE replays since=N, then streams new events with id and json data", async () => {
	const { server, log } = await boot();
	const client: Sse[] = [];
	try {
		log.append({ type: "message", data: { text: "one" } });
		log.append({ type: "message", data: { text: "two" } });
		log.append({ type: "message", data: { text: "three" } });
		const all = await sse(server, q());
		client.push(all);
		assert.equal(all.status, 200);
		assert.match(String(all.headers["content-type"]), /^text\/event-stream/);
		assert.equal(all.headers["cache-control"], "no-store");
		assert.equal(all.headers["x-content-type-options"], "nosniff");
		await all.waitFor(3);
		assert.deepEqual(all.events.map((e) => e.id), [1, 2, 3]);
		assert.equal(all.events[0].data.seq, 1);
		assert.equal(all.events[0].data.type, "message");
		assert.deepEqual(all.events[0].data.data, { text: "one" });

		const since = await sse(server, q("&since=2"));
		client.push(since);
		await since.waitFor(1);
		assert.deepEqual(since.events.map((e) => e.id), [3]);

		log.append({ type: "message", data: { text: "four" } });
		await since.waitFor(2);
		await all.waitFor(4);
		assert.deepEqual(since.events.map((e) => e.id), [3, 4]);
		assert.equal(all.events[3].data.data.text, "four");
	} finally {
		for (const c of client) c.close();
		await server.close();
	}
});

test("web-server: Last-Event-ID wins over ?since= on reconnect", async () => {
	const { server, log } = await boot();
	let c: Sse | undefined;
	try {
		for (let i = 0; i < 5; i++) log.append({ type: "message", data: { i } });
		c = await sse(server, q("&since=0"), { "last-event-id": "3" });
		await c.waitFor(2);
		assert.deepEqual(c.events.map((e) => e.id), [4, 5]);
		c.close();
		c = await sse(server, q("&since=4"), { "last-event-id": "junk" });
		await c.waitFor(1);
		assert.deepEqual(c.events.map((e) => e.id), [5], "an invalid header falls back to since");
	} finally {
		c?.close();
		await server.close();
	}
});

test("web-server: SSE replay is a bounded snapshot of keyed events", async () => {
	const { server, log } = await boot();
	let c: Sse | undefined;
	try {
		log.append({ type: "brigadev_agent", data: { id: "a", status: "running" } });
		log.append({ type: "brigadev_agent", data: { id: "a", status: "done" } });
		c = await sse(server, q());
		await c.waitFor(1);
		await new Promise((r) => setTimeout(r, 30));
		assert.deepEqual(c.events.map((e) => e.data.data.status), ["done"]);
	} finally {
		c?.close();
		await server.close();
	}
});

test("web-server: SSE sends a heartbeat comment and drops the subscriber when the client leaves", async () => {
	const { server, log } = await boot({ heartbeatMs: 20 });
	try {
		const c = await sse(server, q());
		await new Promise((r) => setTimeout(r, 90));
		assert.ok(c.raw.some((m) => m.startsWith(":")), "heartbeat comment");
		c.close();
		await new Promise((r) => setTimeout(r, 50));
		assert.doesNotThrow(() => log.append({ type: "message", data: {} }));
	} finally {
		await server.close();
	}
});

test("web-server: close() ends open streams and stops listening", async () => {
	const { server } = await boot();
	const port = server.port;
	const c = await sse(server, q());
	await server.close();
	await assert.rejects(send({ ...server, port }, { path: "/" }));
	c.close();
});
