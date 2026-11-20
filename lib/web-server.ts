// The web UI's local HTTP server: one static page, an SSE stream of the event log, and one POST endpoint for actions.
// It is the only listener the harness opens, so it is strict: loopback only, a random token on every request
// (constant-time compare), a Host check against DNS rebinding, an Origin check on writes, and security headers.
// node:http and node:crypto only.

import { timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { type Action, parseAction } from "./bus.ts";
import type { WebEvent, WebLog } from "./web-log.ts";

export const MAX_BODY_BYTES = 64 * 1024;
/** Past this much unflushed SSE data a client is too slow to keep. */
const MAX_SSE_BACKLOG = 4 * 1024 * 1024;
/** How much of a rejected oversize body is read and discarded before the connection is cut. */
const MAX_DRAIN_BYTES = 1024 * 1024;

export interface WebServerOptions {
	/** Always loopback; any other value is refused. */
	host?: string;
	/** 0 = ephemeral. */
	port: number;
	token: string;
	html: string;
	log: WebLog;
	onAction: (action: Action) => void | Promise<void>;
	/** SSE keep-alive comment interval. */
	heartbeatMs?: number;
}

export interface WebServer {
	/** `http://127.0.0.1:<port>/?token=<token>`. */
	url: string;
	port: number;
	close(): Promise<void>;
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function tokenMatches(given: string | undefined, expected: string): boolean {
	const a = Buffer.from(given ?? "", "utf8");
	const b = Buffer.from(expected, "utf8");
	if (a.length !== b.length) {
		timingSafeEqual(b, b);
		return false;
	}
	return timingSafeEqual(a, b);
}

function setSecurityHeaders(res: ServerResponse): void {
	res.setHeader("Content-Security-Policy", CSP);
	res.setHeader("X-Content-Type-Options", "nosniff");
	res.setHeader("Cache-Control", "no-store");
	res.setHeader("Referrer-Policy", "no-referrer");
}

function reply(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
	if (res.headersSent) return;
	const text = JSON.stringify(body);
	res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...extra });
	res.end(text);
}

export async function startWebServer(options: WebServerOptions): Promise<WebServer> {
	const host = options.host ?? "127.0.0.1";
	if (host !== "127.0.0.1") throw new Error("the web UI binds 127.0.0.1 only");
	const { token, html, log, onAction } = options;
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const streams = new Set<{ res: ServerResponse; stop: () => void }>();
	const sockets = new Set<Socket>();
	let port = 0;

	const hostOk = (req: IncomingMessage): boolean => {
		const h = req.headers.host;
		return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
	};

	const queryToken = (url: URL): string | undefined => url.searchParams.get("token") ?? undefined;
	const headerToken = (req: IncomingMessage): string | undefined => {
		const value = req.headers["x-brigadev-token"];
		return Array.isArray(value) ? value[0] : value;
	};

	function serveEvents(req: IncomingMessage, res: ServerResponse, url: URL): void {
		const fromQuery = Number(url.searchParams.get("since"));
		const lastId = req.headers["last-event-id"];
		const fromHeader = typeof lastId === "string" && /^\d+$/.test(lastId) ? Number(lastId) : undefined;
		let sent = fromHeader ?? (Number.isSafeInteger(fromQuery) && fromQuery > 0 ? fromQuery : 0);

		res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", Connection: "keep-alive", "X-Accel-Buffering": "no" });
		res.write("retry: 2000\n\n");

		let heartbeat: NodeJS.Timeout | undefined;
		let unsubscribe: (() => void) | undefined;
		const stream = {
			res,
			stop() {
				if (heartbeat) clearInterval(heartbeat);
				unsubscribe?.();
				heartbeat = undefined;
				unsubscribe = undefined;
				streams.delete(stream);
			},
		};
		const push = (event: WebEvent) => {
			if (event.seq <= sent || res.destroyed) return;
			sent = event.seq;
			res.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
			if (res.writableLength > MAX_SSE_BACKLOG) res.destroy();
		};
		streams.add(stream);
		// Subscribe before replaying: both run synchronously, and `sent` drops anything seen twice.
		unsubscribe = log.subscribe(push);
		for (const event of log.since(sent)) push(event);
		heartbeat = setInterval(() => {
			if (!res.destroyed) res.write(": ping\n\n");
		}, heartbeatMs);
		heartbeat.unref();
		res.on("close", stream.stop);
		req.on("error", stream.stop);
	}

	function readAction(req: IncomingMessage, res: ServerResponse): void {
		const type = String(req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
		if (type !== "application/json") return reply(res, 400, { error: "content-type must be application/json" });
		const declared = Number(req.headers["content-length"]);
		let size = 0;
		let tooBig = false;
		const chunks: Buffer[] = [];

		const rejectTooBig = () => {
			if (tooBig) return;
			tooBig = true;
			chunks.length = 0;
			reply(res, 413, { error: "body too large" }, { Connection: "close" });
		};
		if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) rejectTooBig();

		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (tooBig) {
				// Discard what the client still sends, but not without limit.
				if (size > MAX_DRAIN_BYTES) req.destroy();
				return;
			}
			if (size > MAX_BODY_BYTES) return rejectTooBig();
			chunks.push(chunk);
		});
		req.on("error", () => {});
		req.on("end", () => {
			if (tooBig) return;
			let raw: unknown;
			try {
				raw = JSON.parse(Buffer.concat(chunks).toString("utf8"));
			} catch {
				return reply(res, 400, { error: "invalid json" });
			}
			const action = parseAction(raw);
			if (!action) return reply(res, 400, { error: "invalid action" });
			Promise.resolve()
				.then(() => onAction(action))
				.then(
					() => reply(res, 202, { ok: true }),
					() => reply(res, 500, { error: "action failed" }),
				);
		});
	}

	const server: Server = createServer((req, res) => {
		setSecurityHeaders(res);
		if (!hostOk(req)) return reply(res, 403, { error: "forbidden host" });
		let url: URL;
		try {
			url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
		} catch {
			return reply(res, 404, { error: "not found" });
		}
		const route = url.pathname;
		if (route !== "/" && route !== "/events" && route !== "/action") return reply(res, 404, { error: "not found" });

		if (route === "/action") {
			if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" }, { Allow: "POST" });
			if (!tokenMatches(headerToken(req), token)) return reply(res, 401, { error: "unauthorized" });
			const origin = req.headers.origin;
			if (origin !== undefined && origin !== `http://${req.headers.host}`) return reply(res, 403, { error: "forbidden origin" });
			return readAction(req, res);
		}

		if (req.method !== "GET") return reply(res, 405, { error: "method not allowed" }, { Allow: "GET" });
		if (route === "/events") {
			if (!tokenMatches(queryToken(url) ?? headerToken(req), token)) return reply(res, 401, { error: "unauthorized" });
			return serveEvents(req, res, url);
		}
		// The page is static and holds no session data, so it needs no token: it strips the token from the address bar
		// and keeps it in the tab, and a reload must still load it. Everything with data (/events, /action) is gated.
		res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": Buffer.byteLength(html) });
		res.end(html);
	});
	server.on("connection", (socket) => {
		sockets.add(socket);
		socket.on("close", () => sockets.delete(socket));
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: options.port }, () => {
			server.off("error", reject);
			resolve();
		});
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("web server has no address");
	port = address.port;

	let closing: Promise<void> | undefined;
	return {
		url: `http://127.0.0.1:${port}/?token=${token}`,
		port,
		close() {
			closing ??= new Promise<void>((resolve) => {
				for (const stream of [...streams]) {
					stream.stop();
					stream.res.end();
				}
				server.close(() => resolve());
				for (const socket of sockets) socket.destroy();
			});
			return closing;
		},
	};
}

export const start = startWebServer;
