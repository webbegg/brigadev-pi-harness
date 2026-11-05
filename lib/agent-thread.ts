// Turns a subagent run's messages into readable rows for the Agents viewer:
// assistant text, tool calls with a short argument preview, and the first
// lines of each tool result. Pure.

import type { Row } from "./two-pane.ts";
import { wrapText } from "./two-pane.ts";

interface PartLike {
	type?: string;
	text?: string;
	name?: string;
	arguments?: Record<string, unknown>;
}

export interface MessageLike {
	role?: string;
	content?: string | PartLike[];
	toolName?: string;
	isError?: boolean;
}

const RESULT_PREVIEW_LINES = 3;

function argPreview(name: string, args: Record<string, unknown> | undefined): string {
	if (!args) return "";
	if (name === "bash" && typeof args.command === "string") return `$ ${args.command.split("\n")[0]}`;
	if (typeof args.path === "string") return args.path;
	if (typeof args.pattern === "string") return `/${args.pattern}/`;
	const json = JSON.stringify(args);
	return json.length > 100 ? `${json.slice(0, 99)}…` : json;
}

function textOf(content: MessageLike["content"]): string {
	if (typeof content === "string") return content;
	return (content ?? []).filter((p) => p.type === "text").map((p) => p.text ?? "").join("\n");
}

export function threadRows(header: string[], messages: readonly MessageLike[], width: number): Row[] {
	const rows: Row[] = header.map((text, i) => ({ text, tone: i === 0 ? "accent" : "muted" }));
	rows.push({ text: "" });
	for (const message of messages) {
		if (message.role === "assistant" && Array.isArray(message.content)) {
			for (const part of message.content) {
				if (part.type === "text" && part.text?.trim()) {
					for (const line of wrapText(part.text.trim(), width)) rows.push({ text: line, tone: "text" });
					rows.push({ text: "" });
				} else if (part.type === "toolCall" && part.name) {
					rows.push({ text: `→ ${part.name} ${argPreview(part.name, part.arguments)}`, tone: "accent" });
				}
			}
		} else if (message.role === "toolResult") {
			const lines = textOf(message.content).split("\n").filter((l) => l.trim());
			const shown = lines.slice(0, RESULT_PREVIEW_LINES);
			for (const line of shown) rows.push({ text: `  ${line}`, tone: message.isError ? "error" : "dim" });
			const hidden = lines.length - shown.length;
			if (hidden > 0) rows.push({ text: `  … ${hidden} more line${hidden === 1 ? "" : "s"}`, tone: "dim" });
		}
	}
	return rows;
}
