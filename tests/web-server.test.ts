import assert from "node:assert/strict";
import { request } from "node:http";
import { test } from "node:test";
import type { Action } from "../lib/bus.ts";
import { createWebLog, type WebLogOptions } from "../lib/web-log.ts";
import { startWebServer, type WebServer, type WebServerOptions } from "../lib/web-server.ts";

const HTML = "<!doctype html><title>x</title>";

async function boot(options: Partial<WebServerOptions> & { logOptions?: WebLogOptions } = {}) {
	const { logOptions, ...rest } = options;
	const log = createWebLog(logOptions);
	const actions: Action[] = [];
	const server = await startWebServer({ host: "127.0.0.1", port: 0, html: HTML, log, onAction: (a) => void actions.push(a), ...rest });
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

/** The bootstrap code a URL carries. */
const codeOf = (url: string) => new URL(url).searchParams.get("code")!;
const auth = (secret: string) => ({ authorization: `Bearer ${secret}` });

/** What the page does: POST /session with the code in a header. */
const exchange = (server: WebServer, code: string, headers: Record<string, string> = {}) => send(server, { method: "POST", path: "/session", headers: { "x-brigadev-code": code, ...headers } });

/** A fresh one-time link, exchanged: the session secret. */
async function login(server: WebServer): Promise<string> {
	const reply = await exchange(server, codeOf(server.openUrl()));
	assert.equal(reply.status, 200, reply.body);
	return JSON.parse(reply.body).secret as string;
}

const post = (server: WebServer, secret: string, body: unknown, headers: Record<string, string> = {}) =>
	send(server, { method: "POST", path: "/action", headers: { "content-type": "application/json", ...auth(secret), ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

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

test("web-server: binds to loopback on an ephemeral port; its url carries no secret, openUrl() a fresh one-time code (32 random bytes, base64url) each time", async () => {
	const { server } = await boot();
	try {
		assert.ok(server.port > 0);
		assert.equal(server.url, `http://127.0.0.1:${server.port}/`);
		const first = server.openUrl();
		const second = server.openUrl();
		assert.match(first, new RegExp(`^http://127\\.0\\.0\\.1:${server.port}/\\?code=[A-Za-z0-9_-]{43}$`));
		assert.notEqual(codeOf(first), codeOf(second));
	} finally {
		await server.close();
	}
});

test("web-server: GET / serves the static page with no secret in it, with security headers", async () => {
	const { server } = await boot();
	try {
		const code = codeOf(server.openUrl());
		for (const path of ["/", `/?code=${code}`, "/?token=nope"]) {
			const page = await send(server, { path });
			assert.equal(page.status, 200, path);
			assert.equal(page.body, HTML, path);
			assert.ok(!page.body.includes(code));
		}
		const ok = await send(server, { path: "/" });
		assert.match(String(ok.headers["content-type"]), /^text\/html/);
		assert.match(String(ok.headers["content-security-policy"]), /default-src 'self'/);
		assert.match(String(ok.headers["content-security-policy"]), /script-src[^;]*'unsafe-inline'/);
		assert.equal(ok.headers["x-content-type-options"], "nosniff");
		assert.equal(ok.headers["cache-control"], "no-store");
		assert.equal(ok.headers["referrer-policy"], "no-referrer");
		const denied = await send(server, { path: "/events" });
		assert.equal(denied.headers["x-content-type-options"], "nosniff", "headers on errors too");
		// serving the page did not consume the code
		assert.equal((await exchange(server, code)).status, 200);
	} finally {
		await server.close();
	}
});

test("web-server: every other path is 404", async () => {
	const { server } = await boot();
	try {
		for (const path of ["/index.html", "/favicon.ico", "/actions", "/events/x", "/session/x", "/foo", "/../etc/passwd"]) {
			assert.equal((await send(server, { path })).status, 404, path);
		}
	} finally {
		await server.close();
	}
});

test("web-server: the bootstrap code authorizes nothing on /events or /action directly", async () => {
	const { server, actions } = await boot();
	try {
		const code = codeOf(server.openUrl());
		for (const headers of [auth(code), { "x-brigadev-code": code }, { "x-brigadev-token": code }]) {
			assert.equal((await send(server, { path: "/events", headers })).status, 401, JSON.stringify(headers));
			assert.equal((await post(server, code, { action: "abort" }, headers)).status, 401, JSON.stringify(headers));
		}
		for (const query of ["code", "token", "secret"]) assert.equal((await send(server, { path: `/events?${query}=${code}` })).status, 401, query);
		assert.deepEqual(actions, []);
		// none of that spent it
		assert.equal((await exchange(server, code)).status, 200);
	} finally {
		await server.close();
	}
});

test("web-server: a code exchanges once for a secret (JSON, no-store); a second exchange is 401", async () => {
	const { server } = await boot();
	try {
		const code = codeOf(server.openUrl());
		const first = await exchange(server, code);
		assert.equal(first.status, 200);
		assert.match(String(first.headers["content-type"]), /^application\/json/);
		assert.equal(first.headers["cache-control"], "no-store");
		const { secret } = JSON.parse(first.body);
		assert.equal(Buffer.from(secret, "base64url").length >= 32, true);
		assert.notEqual(secret, code);
		assert.equal((await exchange(server, code)).status, 401);
		// the secret authorizes; one secret per exchange, several tabs = several secrets
		const other = await login(server);
		assert.notEqual(other, secret);
		assert.equal((await post(server, secret, { action: "abort" })).status, 202);
		assert.equal((await post(server, other, { action: "abort" })).status, 202);
	} finally {
		await server.close();
	}
});

test("web-server: a code expires after 60 s (injected clock), consumed or not; a wrong or missing code is 401", async () => {
	let now = 1_000_000;
	const { server } = await boot({ now: () => now });
	try {
		const late = codeOf(server.openUrl());
		const inTime = codeOf(server.openUrl());
		now += 59_999;
		assert.equal((await exchange(server, inTime)).status, 200, "still valid just before 60 s");
		now += 2;
		assert.equal((await exchange(server, late)).status, 401, "expired");
		const fresh = codeOf(server.openUrl());
		assert.equal((await exchange(server, fresh)).status, 200);
		for (const code of ["", "nope", fresh.slice(0, -1), `${fresh}x`]) assert.equal((await exchange(server, code)).status, 401, code);
		assert.equal((await send(server, { method: "POST", path: "/session" })).status, 401);
	} finally {
		await server.close();
	}
});

test("web-server: openUrl() mints a new code and the old unused one still works once, then expires on its own clock", async () => {
	let now = 5_000;
	const { server } = await boot({ now: () => now });
	try {
		const old = codeOf(server.openUrl());
		now += 30_000;
		const next = codeOf(server.openUrl());
		now += 40_000; // old is 70 s old, next 40 s
		assert.equal((await exchange(server, old)).status, 401, "the unused old code expired");
		assert.equal((await exchange(server, next)).status, 200);
		const again = codeOf(server.openUrl());
		const older = codeOf(server.openUrl());
		assert.equal((await exchange(server, again)).status, 200, "open does not revoke the earlier unused code");
		assert.equal((await exchange(server, older)).status, 200);
	} finally {
		await server.close();
	}
});

test("web-server: /session is POST only, and passes the Host and Origin checks", async () => {
	const { server } = await boot();
	try {
		const code = codeOf(server.openUrl());
		assert.equal((await send(server, { path: "/session", headers: { "x-brigadev-code": code } })).status, 405);
		assert.equal((await exchange(server, code, { host: `evil.example:${server.port}` })).status, 403);
		assert.equal((await exchange(server, code, { origin: "http://evil.example" })).status, 403);
		assert.equal((await exchange(server, code, { origin: "null" })).status, 403);
		assert.equal((await send(server, { method: "POST", path: `/session?code=${code}` })).status, 401, "a code in the query is not read");
		assert.equal((await exchange(server, code, { origin: `http://127.0.0.1:${server.port}` })).status, 200, "none of that spent it");
	} finally {
		await server.close();
	}
});

test("web-server: a link captured from the browser's address bar is useless once the page exchanged it (and a thief who exchanges first is visible to the page)", async () => {
	const { server, actions } = await boot();
	try {
		// the page was opened with this URL; the page exchanges at once
		const captured = server.openUrl();
		const page = await exchange(server, codeOf(captured));
		assert.equal(page.status, 200);
		// a later reader of history / a process that kept the URL
		const thief = await exchange(server, codeOf(captured));
		assert.equal(thief.status, 401);
		assert.equal((await send(server, { path: `/events?code=${codeOf(captured)}` })).status, 401);
		assert.equal((await post(server, codeOf(captured), { action: "abort" })).status, 401);
		assert.deepEqual(actions, []);
		// the other order: a third party wins the race, the browser's own exchange fails
		const stolen = codeOf(server.openUrl());
		assert.equal((await exchange(server, stolen)).status, 200);
		assert.equal((await exchange(server, stolen)).status, 401);
	} finally {
		await server.close();
	}
});

test("web-server: /events and /action answer 401 without or with a wrong secret", async () => {
	const { server, actions } = await boot();
	try {
		await login(server);
		assert.equal((await send(server, { path: "/events" })).status, 401);
		assert.equal((await send(server, { path: "/events", headers: auth("wrong") })).status, 401);
		assert.equal((await send(server, { path: "/events", headers: { authorization: "Basic abc" } })).status, 401);
		assert.equal((await send(server, { method: "POST", path: "/action", headers: { "content-type": "application/json" }, body: '{"action":"abort"}' })).status, 401);
		assert.equal((await post(server, "wrong", { action: "abort" })).status, 401);
		assert.equal((await post(server, "", { action: "abort" })).status, 401);
		assert.deepEqual(actions, []);
	} finally {
		await server.close();
	}
});

test("web-server: the secret works only as an Authorization header; in a query (alone or with the header) it is 401", async () => {
	const { server, actions } = await boot();
	try {
		const secret = await login(server);
		for (const name of ["token", "secret", "code", "access_token"]) {
			assert.equal((await send(server, { path: `/events?${name}=${secret}` })).status, 401, name);
			assert.equal((await send(server, { path: `/events?${name}=${secret}`, headers: auth(secret) })).status, 401, `${name} + header`);
			assert.equal((await post(server, secret, { action: "abort" }, {}).then((r) => r.status)), 202);
			assert.equal((await send(server, { method: "POST", path: `/action?${name}=${secret}`, headers: { "content-type": "application/json", ...auth(secret) }, body: '{"action":"abort"}' })).status, 401, `action ${name}`);
		}
		assert.equal((await send(server, { path: "/events", headers: { "x-brigadev-token": secret } })).status, 401, "the old header is gone");
		const ok = await sse(server, "/events", auth(secret));
		assert.equal(ok.status, 200);
		ok.close();
		assert.equal(actions.length, 4);
	} finally {
		await server.close();
	}
});

test("web-server: a new server never honors a secret of an earlier one (stop revokes)", async () => {
	const first = await boot();
	const secret = await login(first.server);
	assert.equal((await post(first.server, secret, { action: "abort" })).status, 202);
	await first.server.close();
	const second = await boot();
	try {
		assert.equal((await post(second.server, secret, { action: "abort" })).status, 401);
		assert.equal((await send(second.server, { path: "/events", headers: auth(secret) })).status, 401);
	} finally {
		await second.server.close();
	}
});

test("web-server: a request whose Host is not loopback:<port> is 403 on every endpoint", async () => {
	const { server, actions } = await boot();
	try {
		const secret = await login(server);
		const bad = [`evil.example:${server.port}`, "127.0.0.1", "127.0.0.1:1", `localhost.evil.com:${server.port}`, `127.0.0.1.evil.com:${server.port}`];
		for (const host of bad) {
			assert.equal((await send(server, { path: "/", headers: { host } })).status, 403, host);
			assert.equal((await send(server, { path: "/events", headers: { host, ...auth(secret) } })).status, 403, host);
			assert.equal((await post(server, secret, { action: "abort" }, { host })).status, 403, host);
			assert.equal((await exchange(server, codeOf(server.openUrl()), { host })).status, 403, host);
		}
		assert.equal((await send(server, { path: "/", headers: { host: `localhost:${server.port}` } })).status, 200);
		assert.deepEqual(actions, []);
	} finally {
		await server.close();
	}
});

test("web-server: POST with a cross Origin is 403; same origin and no Origin pass", async () => {
	const { server, actions } = await boot();
	try {
		const secret = await login(server);
		assert.equal((await post(server, secret, { action: "abort" }, { origin: "http://evil.example" })).status, 403);
		assert.equal((await post(server, secret, { action: "abort" }, { origin: `http://127.0.0.1:${server.port + 1}` })).status, 403);
		assert.equal((await post(server, secret, { action: "abort" }, { origin: "null" })).status, 403);
		assert.equal(actions.length, 0);
		assert.equal((await post(server, secret, { action: "abort" }, { origin: `http://127.0.0.1:${server.port}` })).status, 202);
		assert.equal((await post(server, secret, { action: "abort" }, { origin: `http://localhost:${server.port}`, host: `localhost:${server.port}` })).status, 202);
		assert.equal((await post(server, secret, { action: "abort" })).status, 202);
		assert.equal(actions.length, 3);
	} finally {
		await server.close();
	}
});

test("web-server: POST /action validates with parseAction and routes the parsed action", async () => {
	const { server, actions } = await boot();
	try {
		const secret = await login(server);
		const ok = await post(server, secret, { action: "answer", id: "p1", value: true, extra: "dropped" });
		assert.equal(ok.status, 202);
		assert.deepEqual(actions, [{ action: "answer", id: "p1", value: true }]);
		assert.equal((await post(server, secret, { action: "prompt", text: "go", deliverAs: "steer" })).status, 202);
		assert.deepEqual(actions[1], { action: "prompt", text: "go", deliverAs: "steer" });
		for (const bad of [{ action: "rm" }, { action: "answer", id: "p" }, [], "null", "{not json", ""]) {
			const reply = await post(server, secret, bad as any);
			assert.equal(reply.status, 400, JSON.stringify(bad));
		}
		const wrongType = await send(server, { method: "POST", path: "/action", headers: { "content-type": "text/plain", ...auth(secret) }, body: '{"action":"abort"}' });
		assert.equal(wrongType.status, 400);
		assert.equal(actions.length, 2);
		assert.equal((await send(server, { method: "GET", path: "/action", headers: auth(secret) })).status, 405);
	} finally {
		await server.close();
	}
});

test("web-server: a handler that throws answers 500 and the server keeps working", async () => {
	let fail = true;
	const { server } = await boot({
		onAction: () => {
			if (fail) throw new Error("boom");
		},
	});
	try {
		const secret = await login(server);
		assert.equal((await post(server, secret, { action: "abort" })).status, 500);
		fail = false;
		assert.equal((await post(server, secret, { action: "abort" })).status, 202);
	} finally {
		await server.close();
	}
});

test("web-server: a body over 64 KB is 413, declared or streamed", async () => {
	const { server, actions } = await boot();
	try {
		const secret = await login(server);
		const big = JSON.stringify({ action: "prompt", text: "x".repeat(70 * 1024) });
		assert.equal((await post(server, secret, big)).status, 413);
		const exact = JSON.stringify({ action: "abort", pad: "y".repeat(60 * 1024) });
		assert.equal((await post(server, secret, exact)).status, 202);
		// chunked: no content-length to reject early
		const chunked = await new Promise<number>((resolve, reject) => {
			const req = request({ host: "127.0.0.1", port: server.port, method: "POST", path: "/action", headers: { "content-type": "application/json", ...auth(secret), "transfer-encoding": "chunked" } }, (res) => {
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
		const secret = await login(server);
		log.append({ type: "message", data: { text: "one" } });
		log.append({ type: "message", data: { text: "two" } });
		log.append({ type: "message", data: { text: "three" } });
		const all = await sse(server, "/events", auth(secret));
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

		const since = await sse(server, "/events?since=2", auth(secret));
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
		const secret = await login(server);
		for (let i = 0; i < 5; i++) log.append({ type: "message", data: { i } });
		c = await sse(server, "/events?since=0", { ...auth(secret), "last-event-id": "3" });
		await c.waitFor(2);
		assert.deepEqual(c.events.map((e) => e.id), [4, 5]);
		c.close();
		c = await sse(server, "/events?since=4", { ...auth(secret), "last-event-id": "junk" });
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
		const secret = await login(server);
		log.append({ type: "brigadev_agent", data: { id: "a", status: "running" } });
		log.append({ type: "brigadev_agent", data: { id: "a", status: "done" } });
		c = await sse(server, "/events", auth(secret));
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
		const secret = await login(server);
		const c = await sse(server, "/events", auth(secret));
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
	const secret = await login(server);
	const port = server.port;
	const c = await sse(server, "/events", auth(secret));
	await server.close();
	await assert.rejects(send({ ...server, port }, { path: "/" }));
	c.close();
});

/** A raw SSE client that does not read until `resume()`, to model a slow browser. */
function slowClient(server: WebServer, secret: string) {
	const ids: number[] = [];
	let buffer = "";
	let closed = false;
	let res: import("node:http").IncomingMessage | undefined;
	const waiters: Array<() => void> = [];
	const req = request({ host: "127.0.0.1", port: server.port, path: "/events", headers: auth(secret) }, (r) => {
		res = r;
		r.setEncoding("utf8");
		r.pause();
		r.on("data", (chunk: string) => {
			buffer += chunk;
			let at: number;
			while ((at = buffer.indexOf("\n\n")) >= 0) {
				const message = buffer.slice(0, at);
				buffer = buffer.slice(at + 2);
				const id = /^id: (\d+)$/m.exec(message);
				if (id) ids.push(Number(id[1]));
			}
			for (const w of [...waiters]) w();
		});
		r.on("close", () => {
			closed = true;
			for (const w of [...waiters]) w();
		});
	});
	req.on("error", () => {});
	req.end();
	return {
		ids,
		isClosed: () => closed,
		resume: () => res?.resume(),
		until: (done: () => boolean, ms = 8000) =>
			new Promise<void>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error(`timed out: ${ids.length} events, closed=${closed}`)), ms);
				const check = () => {
					if (!done()) return;
					clearTimeout(timer);
					resolve();
				};
				waiters.push(check);
				check();
			}),
		close: () => req.destroy(),
	};
}

test("web-server: a replay larger than the backlog cap reaches a slow client complete and in order, without a destroy", async () => {
	const { server, log } = await boot({ maxBacklogBytes: 256 * 1024, logOptions: { maxUnkeyed: 5000 } });
	let client: ReturnType<typeof slowClient> | undefined;
	try {
		const secret = await login(server);
		const total = 700;
		const pad = "x".repeat(8 * 1024); // ~5.6 MB of replay, far past the cap and any socket buffer
		for (let i = 0; i < total; i++) log.append({ type: "message", data: { i, pad } });
		client = slowClient(server, secret);
		await new Promise((r) => setTimeout(r, 300)); // the client reads nothing yet
		client.resume();
		await client.until(() => client!.ids.length >= total || client!.isClosed());
		assert.equal(client.ids.length, total, `got ${client.ids.length} of ${total} (closed=${client.isClosed()})`);
		assert.deepEqual(client.ids, Array.from({ length: total }, (_, i) => i + 1));
		assert.equal(client.isClosed(), false, "the stream stays open");
		// and what happens live after the replay still arrives
		log.append({ type: "message", data: { i: total } });
		await client.until(() => client!.ids.length > total);
		assert.equal(client.ids.at(-1), total + 1);
	} finally {
		client?.close();
		await server.close();
	}
});

test("web-server: events appended during a slow replay arrive after it, in order, once", async () => {
	const { server, log } = await boot({ maxBacklogBytes: 256 * 1024, logOptions: { maxUnkeyed: 5000 } });
	let client: ReturnType<typeof slowClient> | undefined;
	try {
		const secret = await login(server);
		const pad = "x".repeat(8 * 1024);
		for (let i = 0; i < 300; i++) log.append({ type: "message", data: { i, pad } });
		client = slowClient(server, secret);
		await new Promise((r) => setTimeout(r, 200));
		for (let i = 300; i < 310; i++) log.append({ type: "message", data: { i } });
		client.resume();
		await client.until(() => client!.ids.length >= 310 || client!.isClosed());
		assert.deepEqual(client.ids, Array.from({ length: 310 }, (_, i) => i + 1));
	} finally {
		client?.close();
		await server.close();
	}
});

test("web-server: a live client that stops reading past the backlog cap is still cut", async () => {
	const { server, log } = await boot({ maxBacklogBytes: 64 * 1024 });
	let client: ReturnType<typeof slowClient> | undefined;
	try {
		const secret = await login(server);
		client = slowClient(server, secret);
		await new Promise((r) => setTimeout(r, 100));
		const pad = "y".repeat(16 * 1024);
		for (let i = 0; i < 4000 && !client.isClosed(); i++) {
			log.append({ type: "message", data: { i, pad } });
			if (i % 5 === 0) await new Promise((r) => setImmediate(r));
		}
		await client.until(() => client!.isClosed(), 3000);
		assert.equal(client.isClosed(), true);
	} finally {
		client?.close();
		await server.close();
	}
});
