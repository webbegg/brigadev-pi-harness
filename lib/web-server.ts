// The web UI's local HTTP server: one static page, a one-time sign-in, an SSE stream of the event log, and one POST
// endpoint for actions. It is the only listener the harness opens, so it is strict: loopback only, a Host check
// against DNS rebinding, an Origin check on writes, security headers, and no long-lived secret in any URL:
// - the URL the user opens carries a bootstrap `code` (32 random bytes, valid 60 s, spent on first use); it
//   authorizes nothing but `POST /session`, where the page trades it for a session secret;
// - the secret is random, lives only in the server's memory and the page's JS variable, and travels in an
//   `Authorization: Bearer` header; a code or secret in a query string is refused.
// Codes and secrets are compared in constant time. node:http and node:crypto only.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { type Action, parseAction } from "./bus.ts";
import type { WebEvent, WebLog } from "./web-log.ts";

export const MAX_BODY_BYTES = 64 * 1024;
/** Past this much unflushed SSE data a client is too slow to keep. */
const MAX_SSE_BACKLOG = 4 * 1024 * 1024;
/** How much of a rejected oversize body is read and discarded before the connection is cut. */
const MAX_DRAIN_BYTES = 1024 * 1024;

/** How long a bootstrap code can be exchanged. */
export const CODE_TTL_MS = 60_000;
/** Unspent codes and live session secrets kept; the oldest go first. */
const MAX_CODES = 32;
const MAX_SECRETS = 64;
/** Query parameters that look like credentials: a request carrying one is refused, whatever else it carries. */
const CREDENTIAL_PARAMS = ["token", "secret", "code", "access_token", "authorization", "auth", "key"];

export interface WebServerOptions {
	/** Always loopback; any other value is refused. */
	host?: string;
	/** 0 = ephemeral. */
	port: number;
	html: string;
	log: WebLog;
	onAction: (action: Action) => void | Promise<void>;
	/** SSE keep-alive comment interval. */
	heartbeatMs?: number;
	/** Unflushed SSE bytes past which a client is too slow to keep (default 4 MB). */
	maxBacklogBytes?: number;
	/** The clock for code expiry (default `Date.now`); tests inject one. */
	now?: () => number;
}

export interface WebServer {
	/** `http://127.0.0.1:<port>/`: where the page lives. It carries no credential. */
	url: string;
	port: number;
	/** Mints a fresh one-time code and returns `url` with it (`?code=...`). Earlier unspent codes stay valid until their own expiry. */
	openUrl(): string;
	/** Stops listening, ends every stream, and forgets every code and secret. */
	close(): Promise<void>;
}

const CSP = "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const digest = (text: string): Buffer => createHash("sha256").update(text, "utf8").digest();

/** The index of the stored digest equal to `given`, or -1. Compares fixed-size digests against every entry, with no early exit. */
function findDigest(given: string | undefined, stored: Array<{ digest: Buffer }>): number {
	const probe = digest(given ?? "");
	let found = -1;
	stored.forEach((entry, index) => {
		if (timingSafeEqual(probe, entry.digest) && found < 0) found = index;
	});
	return found;
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
	const { html, log, onAction } = options;
	const heartbeatMs = options.heartbeatMs ?? 15_000;
	const maxBacklog = options.maxBacklogBytes ?? MAX_SSE_BACKLOG;
	const now = options.now ?? Date.now;
	let codes: Array<{ digest: Buffer; expires: number }> = [];
	let secrets: Array<{ digest: Buffer }> = [];
	const streams = new Set<{ res: ServerResponse; stop: () => void }>();
	const sockets = new Set<Socket>();
	let port = 0;

	const hostOk = (req: IncomingMessage): boolean => {
		const h = req.headers.host;
		return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
	};

	const hasCredentialQuery = (url: URL): boolean => CREDENTIAL_PARAMS.some((name) => url.searchParams.has(name));
	const bearer = (req: IncomingMessage): string | undefined => {
		const value = req.headers.authorization;
		const match = typeof value === "string" ? /^Bearer ([^\s]+)$/i.exec(value) : null;
		return match?.[1];
	};
	/** A request is signed in when its Bearer header is a live session secret and the URL carries no credential. */
	const signedIn = (req: IncomingMessage, url: URL): boolean => !hasCredentialQuery(url) && findDigest(bearer(req), secrets) >= 0;

	function mintCode(): string {
		const code = randomBytes(32).toString("base64url");
		const at = now();
		codes = codes.filter((c) => c.expires > at);
		codes.push({ digest: digest(code), expires: at + CODE_TTL_MS });
		if (codes.length > MAX_CODES) codes = codes.slice(-MAX_CODES);
		return code;
	}

	/** Spends `code` and returns a new session secret, or undefined when it is unknown, spent or expired. */
	function exchangeCode(code: string | undefined): string | undefined {
		const at = now();
		const index = findDigest(code, codes);
		const entry = index >= 0 ? codes[index] : undefined;
		codes = codes.filter((c) => c.expires > at && c !== entry);
		if (!entry || entry.expires <= at) return undefined;
		const secret = randomBytes(32).toString("base64url");
		secrets.push({ digest: digest(secret) });
		if (secrets.length > MAX_SECRETS) secrets = secrets.slice(-MAX_SECRETS);
		return secret;
	}

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
		const frame = (event: WebEvent) => `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
		// While the replay is still being written, live events wait here (the replay yields to a slow reader, so they cannot go out yet).
		let replaying = true;
		const waiting: Array<{ seq: number; text: string }> = [];
		let waitingBytes = 0;
		const push = (event: WebEvent) => {
			if (event.seq <= sent || res.destroyed) return;
			const text = frame(event);
			if (replaying) {
				waiting.push({ seq: event.seq, text });
				waitingBytes += text.length;
				if (waitingBytes > maxBacklog) res.destroy();
				return;
			}
			sent = event.seq;
			res.write(text);
			if (res.writableLength > maxBacklog) res.destroy();
		};
		const drained = () =>
			new Promise<void>((resolve) => {
				const done = () => {
					res.off("drain", done);
					res.off("close", done);
					resolve();
				};
				res.once("drain", done);
				res.once("close", done);
			});
		/** One frame, in seq order and once; waits for the socket to drain when it is full. */
		const write = async (seq: number, text: string) => {
			if (seq <= sent || res.destroyed) return;
			sent = seq;
			if (!res.write(text)) await drained();
		};
		streams.add(stream);
		// Subscribe before reading the log: nothing appended after this point is missing from both the snapshot and the queue.
		unsubscribe = log.subscribe(push);
		const backlog = log.since(sent);
		void (async () => {
			for (const event of backlog) {
				if (res.destroyed) return;
				await write(event.seq, frame(event));
			}
			while (waiting.length > 0) {
				if (res.destroyed) return;
				const next = waiting.shift()!;
				waitingBytes -= next.text.length;
				await write(next.seq, next.text);
			}
			// Nothing awaits between the empty check and this line, so no live event slips in between.
			replaying = false;
		})().catch(() => res.destroy());
		heartbeat = setInterval(() => {
			if (!res.destroyed && !replaying) res.write(": ping\n\n");
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
		if (route !== "/" && route !== "/events" && route !== "/action" && route !== "/session") return reply(res, 404, { error: "not found" });

		if (route === "/action" || route === "/session") {
			if (req.method !== "POST") return reply(res, 405, { error: "method not allowed" }, { Allow: "POST" });
			if (route === "/action" && !signedIn(req, url)) return reply(res, 401, { error: "unauthorized" });
			const origin = req.headers.origin;
			if (origin !== undefined && origin !== `http://${req.headers.host}`) return reply(res, 403, { error: "forbidden origin" });
			if (route === "/action") return readAction(req, res);
			// The one-time exchange: the code in a header (never the query), spent whether or not it was in time.
			req.resume();
			const header = req.headers["x-brigadev-code"];
			const secret = hasCredentialQuery(url) ? undefined : exchangeCode(Array.isArray(header) ? header[0] : header);
			if (!secret) return reply(res, 401, { error: "unauthorized" });
			return reply(res, 200, { secret });
		}

		if (req.method !== "GET") return reply(res, 405, { error: "method not allowed" }, { Allow: "GET" });
		if (route === "/events") {
			if (!signedIn(req, url)) return reply(res, 401, { error: "unauthorized" });
			return serveEvents(req, res, url);
		}
		// The page is static and holds no session data, so it needs no credential: it trades the `code` in its address for a
		// secret and keeps that in memory, and a reload (which has no code) must still load it to say what happened.
		// Everything with data (/events, /action) is gated.
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
		url: `http://127.0.0.1:${port}/`,
		port,
		openUrl: () => `http://127.0.0.1:${port}/?code=${mintCode()}`,
		close() {
			codes = [];
			secrets = [];
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
