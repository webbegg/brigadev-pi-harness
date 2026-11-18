// One shared event format for a subagent child's output stream, and the single
// fold that builds a run snapshot from it. Pure: no Pi runtime imports, so the
// run loop, the viewer, and tests all read a child the same way. The stream is
// Pi's JSON event stream (`--mode json`, docs/json.md): one JSON record per line,
// a session header then session events. Anything that is not a message is a sign of life.

import type { Message } from "@earendil-works/pi-ai";
import { addUsage, emptyTally, type Tally } from "./cost.ts";

/** Longest live text kept for an in-progress assistant message; older text is dropped (the final message is authoritative). */
export const MAX_PARTIAL_CHARS = 64 * 1024;

export type ChildEvent =
	/** A finished message (assistant, tool result, or user). */
	| { type: "message"; message: Message }
	/** The child started a tool call; the stall watchdog allows tool time for it. */
	| { type: "tool_start"; id: string; name: string }
	/** A tool call returned its result. */
	| { type: "tool_end"; id: string; name: string }
	/** Streaming text of the assistant message in progress (Pi json.md `message_update` / `text_delta`); `reset` starts a new message. */
	| { type: "partial"; delta: string; reset?: boolean }
	/** The agent's run phase (json.md, "Event sequence" and "Agent and turn events"): a low-level run started or ended; `settled` means Pi will not continue by itself (`aborted` when the run was aborted). */
	| { type: "run"; phase: "start" | "end" | "settled"; aborted?: boolean }
	/** Any other sign of life from the child. */
	| { type: "activity"; label: string };

/** The part of a run the fold owns. */
export interface ChildSnapshot {
	messages: Message[];
	usage: Tally;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	/** Live text of the assistant message in progress, cleared when its `message_end` arrives. Bounded by MAX_PARTIAL_CHARS. */
	partial?: string;
}

/** A fresh snapshot (no production caller: the run loop folds into its own RunResult; tests start from this). */
export const emptySnapshot = (): ChildSnapshot => ({ messages: [], usage: emptyTally() });

const RUN_PHASES = { agent_start: "start", agent_end: "end", agent_settled: "settled" } as const;

/** Parses one line of `pi --mode json` output into shared events; blank or broken lines yield none. */
export function parseChildLine(line: string): ChildEvent[] {
	if (!line.trim()) return [];
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return [];
	}
	if (typeof event?.type === "string" && Object.hasOwn(RUN_PHASES, event.type)) {
		const phase = RUN_PHASES[event.type as keyof typeof RUN_PHASES];
		return [{ type: "activity", label: event.type }, phase === "settled" ? { type: "run", phase, aborted: event.aborted === true } : { type: "run", phase }];
	}
	// Streaming (Pi docs/json.md: `message_update` carries only deltas; `message_end` is the authoritative message).
	// Every update is a sign of life; only text deltas become live text.
	if (event?.type === "message_update") {
		const update = event.assistantMessageEvent;
		const events: ChildEvent[] = [{ type: "activity", label: "message_update" }];
		if (update?.type === "text_delta" && typeof update.delta === "string" && update.delta) events.push({ type: "partial", delta: update.delta });
		return events;
	}
	if (event?.type === "message_start" && event.message?.role === "assistant") return [{ type: "activity", label: "message_start" }, { type: "partial", delta: "", reset: true }];
	const message = event?.type === "message_end" ? event.message : undefined;
	if (!message) return [{ type: "activity", label: String(event?.type ?? "event") }];

	const events: ChildEvent[] = [];
	if (message.role === "assistant" && Array.isArray(message.content)) {
		const calls = message.content.filter((part: any) => part?.type === "toolCall");
		for (const call of calls) events.push({ type: "tool_start", id: String(call.id), name: String(call.name) });
		if (!calls.length) events.push({ type: "activity", label: "assistant message" });
	} else if (message.role === "toolResult") {
		events.push({ type: "tool_end", id: String(message.toolCallId), name: String(message.toolName ?? "tool") });
	} else {
		events.push({ type: "activity", label: "message_end" });
	}
	events.push({ type: "message", message });
	return events;
}

/** Applies one event to the snapshot. Returns true when the snapshot changed. */
export function foldChildEvent(snapshot: ChildSnapshot, event: ChildEvent): boolean {
	if (event.type === "partial") {
		if (event.reset) {
			if (snapshot.partial === undefined) return false;
			delete snapshot.partial;
			return true;
		}
		const text = (snapshot.partial ?? "") + event.delta;
		snapshot.partial = text.length > MAX_PARTIAL_CHARS ? `…${text.slice(-MAX_PARTIAL_CHARS)}` : text;
		return true;
	}
	if (event.type !== "message") return false;
	const msg = event.message;
	snapshot.messages.push(msg);
	if (msg.role === "assistant") {
		// The finished message replaces the live text.
		delete snapshot.partial;
		addUsage(snapshot.usage, msg.usage);
		if (msg.model) snapshot.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
		if (msg.stopReason) snapshot.stopReason = msg.stopReason;
		if (msg.errorMessage) snapshot.errorMessage = msg.errorMessage;
	}
	return true;
}
