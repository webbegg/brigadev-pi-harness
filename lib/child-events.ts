// One shared event format for a subagent child's output stream, and the single
// fold that builds a run snapshot from it. Pure: no Pi runtime imports, so the
// run loop, the viewer, and tests all read a child the same way.

import type { Message } from "@earendil-works/pi-ai";
import { addUsage, emptyTally, type Tally } from "./cost.ts";

export type ChildEvent =
	/** A finished message (assistant, tool result, or user). */
	| { type: "message"; message: Message }
	/** The child started a tool call; the stall watchdog allows tool time for it. */
	| { type: "tool_start"; id: string; name: string }
	/** A tool call returned its result. */
	| { type: "tool_end"; id: string; name: string }
	/** Any other sign of life from the child. */
	| { type: "activity"; label: string };

/** The part of a run the fold owns. */
export interface ChildSnapshot {
	messages: Message[];
	usage: Tally;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
}

export const emptySnapshot = (): ChildSnapshot => ({ messages: [], usage: emptyTally() });

/** Parses one line of `pi --mode json` output into shared events; blank or broken lines yield none. */
export function parseChildLine(line: string): ChildEvent[] {
	if (!line.trim()) return [];
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return [];
	}
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
	if (event.type !== "message") return false;
	const msg = event.message;
	snapshot.messages.push(msg);
	if (msg.role === "assistant") {
		addUsage(snapshot.usage, msg.usage);
		if (msg.model) snapshot.model = msg.provider ? `${msg.provider}/${msg.model}` : msg.model;
		if (msg.stopReason) snapshot.stopReason = msg.stopReason;
		if (msg.errorMessage) snapshot.errorMessage = msg.errorMessage;
	}
	return true;
}
