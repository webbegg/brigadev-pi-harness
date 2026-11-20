// `/brigadev:web`: a local web UI for the parent session. The server starts only with the command (never in a
// child, never on load), but the log is fed from load on, so state from before `start` is replayable. It observes
// the brigadev bus (lib/bus.ts) and a few compact core events, and never changes what the agent does: the only
// ways in are the validated actions of lib/web-server.ts (send a prompt, abort, answer, cancel a subagent).

import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Action, BUS, CHANNELS, publish } from "../lib/bus.ts";
import { ASSETS_ROOT, isChildSession } from "../lib/runtime.ts";
import { createWebLog } from "../lib/web-log.ts";
import { startWebServer, type WebServer } from "../lib/web-server.ts";

const STATUS_KEY = "brigadev-web";
const USAGE = "Usage: /brigadev:web [start|stop|status]";
const MAX_MESSAGE_CHARS = 20_000;
const MAX_SUMMARY_CHARS = 200;
const LIVE_THROTTLE_MS = 150;
/** Tool argument fields worth a one-line summary, in order. Bodies (content, oldText, ...) are never forwarded. */
const SUMMARY_FIELDS = ["path", "file_path", "command", "pattern", "agent", "question"] as const;

/** The text parts of a message, thinking and tool calls left out. */
function textOf(message: unknown): string {
	const content = (message as { content?: unknown } | undefined)?.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

const cap = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

function summarize(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const a = args as Record<string, unknown>;
	let text = "";
	for (const field of SUMMARY_FIELDS) {
		if (typeof a[field] === "string" && a[field]) {
			text = a[field] as string;
			break;
		}
	}
	if (!text && Array.isArray(a.tasks)) {
		text = a.tasks
			.map((t) => (t as { agent?: unknown })?.agent)
			.filter((agent): agent is string => typeof agent === "string")
			.join(", ");
	}
	return cap(text.replace(/\s+/g, " ").trim(), MAX_SUMMARY_CHARS);
}

function configuredPort(): number {
	const raw = process.env.BRIGADEV_WEB_PORT;
	if (!raw) return 0;
	const port = Number(raw);
	return Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 0;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	const log = createWebLog();
	let ctx: any;
	let server: WebServer | undefined;
	let starting: Promise<WebServer> | undefined;

	const guarded =
		<E>(fn: (event: E) => void) =>
		(event: E, context: unknown) => {
			ctx = context ?? ctx;
			try {
				fn(event);
			} catch {
				// A UI is an observer: its failure must not change what the agent does.
			}
		};

	// The bus: every outbound channel, from load on.
	for (const [channel, spec] of Object.entries(CHANNELS)) {
		pi.events.on(channel, (data) => {
			try {
				log.append({ type: spec.as, data });
			} catch {
				// see above
			}
		});
	}

	// Core events, reduced to compact UI events.
	let messageSeq = 0;
	let liveActive = false;
	let liveText: string | undefined;
	let liveTimer: NodeJS.Timeout | undefined;
	let liveAt = 0;
	const flushLive = () => {
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = undefined;
		if (liveText === undefined) return;
		liveAt = Date.now();
		liveActive = true;
		log.append({ type: "assistant_live", data: { id: "live", text: liveText, active: true } });
		liveText = undefined;
	};
	const endLive = () => {
		if (liveTimer) clearTimeout(liveTimer);
		liveTimer = undefined;
		liveText = undefined;
		if (!liveActive) return;
		liveActive = false;
		log.append({ type: "assistant_live", data: { id: "live", text: "", active: false } });
	};

	pi.on(
		"agent_start",
		guarded(() => log.append({ type: "run", data: { id: "run", running: true, at: Date.now() } })),
	);
	pi.on(
		"agent_end",
		guarded(() => {
			endLive();
			log.append({ type: "run", data: { id: "run", running: false, at: Date.now() } });
		}),
	);
	pi.on(
		"message_update",
		guarded((event: { message?: { role?: string } }) => {
			if (event.message?.role !== "assistant") return;
			const text = textOf(event.message);
			liveText = text.length > MAX_MESSAGE_CHARS ? `…${text.slice(-MAX_MESSAGE_CHARS)}` : text;
			const wait = liveAt + LIVE_THROTTLE_MS - Date.now();
			if (wait <= 0) return flushLive();
			if (!liveTimer) {
				liveTimer = setTimeout(flushLive, wait);
				liveTimer.unref();
			}
		}),
	);
	pi.on(
		"message_end",
		guarded((event: { message?: { role?: string } }) => {
			const role = event.message?.role;
			if (role !== "user" && role !== "assistant") return;
			if (role === "assistant") endLive();
			const text = textOf(event.message).trim();
			if (!text) return;
			log.append({ type: "message", data: { id: `m${++messageSeq}`, role, text: cap(text, MAX_MESSAGE_CHARS), at: Date.now() } });
		}),
	);

	const summaries = new Map<string, string>();
	pi.on(
		"tool_execution_start",
		guarded((event: { toolCallId: string; toolName: string; args?: unknown }) => {
			const summary = summarize(event.args);
			summaries.set(event.toolCallId, summary);
			log.append({ type: "tool", data: { id: event.toolCallId, name: cap(String(event.toolName), 80), summary, status: "running", at: Date.now() } });
		}),
	);
	pi.on(
		"tool_execution_end",
		guarded((event: { toolCallId: string; toolName: string; isError?: boolean; durationMs?: number }) => {
			const summary = summaries.get(event.toolCallId) ?? "";
			summaries.delete(event.toolCallId);
			const durationMs = typeof event.durationMs === "number" ? event.durationMs : undefined;
			log.append({ type: "tool", data: { id: event.toolCallId, name: cap(String(event.toolName), 80), summary, status: event.isError ? "error" : "done", durationMs, at: Date.now() } });
		}),
	);
	pi.on("session_start", guarded(() => {}));
	pi.on(
		"session_shutdown",
		guarded(() => void stop()),
	);

	function handleAction(action: Action): void {
		switch (action.action) {
			case "prompt": {
				if (!ctx) throw new Error("no session yet");
				const idle = ctx.isIdle();
				pi.sendUserMessage(action.text, idle ? undefined : { deliverAs: action.deliverAs ?? "followUp" });
				return;
			}
			case "abort":
				if (!ctx) throw new Error("no session yet");
				ctx.abort();
				return;
			case "answer":
			case "cancel-agent":
				// Other extensions own prompts and subagents; they listen on the bus.
				publish(pi.events, BUS.action, action);
				return;
		}
	}

	async function start(): Promise<WebServer> {
		if (server) return server;
		starting ??= (async () => {
			const html = readFileSync(join(ASSETS_ROOT, "web-ui", "index.html"), "utf8");
			return startWebServer({ host: "127.0.0.1", port: configuredPort(), token: randomBytes(32).toString("hex"), html, log, onAction: handleAction });
		})();
		try {
			server = await starting;
			return server;
		} finally {
			starting = undefined;
		}
	}

	async function stop(): Promise<boolean> {
		const running = server;
		server = undefined;
		if (!running) return false;
		await running.close();
		return true;
	}

	pi.registerCommand("brigadev:web", {
		description: "Open the local web UI for this session: start (default), stop, status",
		handler: async (args: string, context: any) => {
			ctx = context ?? ctx;
			const sub = (args ?? "").trim().split(/\s+/)[0] || "start";
			const notify = (message: string, type?: "info" | "warning" | "error") => context.ui.notify(message, type);
			if (sub === "start") {
				if (server) return notify(`brigadev web UI already running: ${server.url}`);
				try {
					const running = await start();
					context.ui.setStatus(STATUS_KEY, `web :${running.port}`);
					notify(`brigadev web UI: ${running.url}`);
				} catch (error) {
					notify(`brigadev web UI failed to start: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
			} else if (sub === "stop") {
				if (!(await stop())) return notify("brigadev web UI is not running");
				context.ui.setStatus(STATUS_KEY, undefined);
				notify("brigadev web UI stopped");
			} else if (sub === "status") {
				notify(server ? `brigadev web UI running: ${server.url}` : "brigadev web UI is not running");
			} else {
				notify(USAGE, "warning");
			}
		},
	});
}
