// `/btw <question>`: a side question answered by a read-only agent whose answer is shown to the user and never
// enters the main session's model context. Pure: no Pi imports. What is here is the marking (which launches are
// asides), their invisibility to `subagent_wait` / `subagent_cancel`, and the text of the answer entry and its card.
// The extension launches the aside through the same async path as any subagent (shared slot cap, guard, run folder,
// viewer row) and records the answer with `pi.appendEntry` (docs/extensions.md, "pi.appendEntry(customType, data?)":
// custom entries "do NOT participate in LLM context"), drawn by "pi.registerEntryRenderer(customType, renderer)".
// Adapted from davi7 `subagents/src/by-the-way.ts` (`origin: "btw"`, `isModelVisible`).

import type { LaunchResult } from "./subagent-launch.ts";
import type { LaunchSummary, SubagentRegistry, WaitOutcome } from "./subagent-registry.ts";

export const BTW_AGENT = "brigadev-explore";
/** The delegation reason of every aside (`reason` of the launch). */
export const BTW_REASON = "by the way";
/** Custom entry type of a recorded answer. */
export const BTW_ENTRY_TYPE = "brigadev-btw";
export const BTW_TITLE_MAX = 60;
/** Characters of the answer kept in the session entry: the full text stays in the run folder. */
export const BTW_ANSWER_MAX = 20_000;
/** Lines of the answer the collapsed card shows. */
export const BTW_CARD_LINES = 8;

/** A one-line title from the first non-empty line of the question. */
export function btwTitle(question: string): string {
	const first = question.split("\n").find((line) => line.trim())?.trim().replace(/\s+/g, " ") ?? "";
	if (!first) return "by the way";
	const chars = Array.from(first);
	return chars.length <= BTW_TITLE_MAX ? first : `${chars.slice(0, BTW_TITLE_MAX - 1).join("")}…`;
}

/** The task the aside agent gets: the question verbatim, with the shape of the answer asked for. */
export function btwTask(question: string): string {
	return ["Answer this side question directly and concisely, in plain prose (a short list of path:line references is fine). This is read-only: do not edit, write, or run anything.", "", "Question:", question.trim()].join("\n");
}

/** Which launches are asides, by registry launch id, with their question. */
export interface AsideTracker {
	mark(id: string, question: string): void;
	has(id: string): boolean;
	question(id: string): string | undefined;
	/** Whether the model's tools may see this launch (davi7 `isModelVisible`): false for an aside. */
	isModelVisible(id: string): boolean;
	clear(): void;
}

export function createAsideTracker(): AsideTracker {
	const asides = new Map<string, string>();
	return {
		mark: (id, question) => void asides.set(id, question),
		has: (id) => asides.has(id),
		question: (id) => asides.get(id),
		isModelVisible: (id) => !asides.has(id),
		clear: () => asides.clear(),
	};
}

/**
 * The registry as the model's tools see it: an aside answers `unknown` (exactly like an id that was never started) and is
 * never waited for or cancelled through them. Every other id goes to the registry untouched.
 */
export function hideAsides(registry: Pick<SubagentRegistry<LaunchResult>, "wait" | "cancel">, asides: Pick<AsideTracker, "isModelVisible">): Pick<SubagentRegistry<LaunchResult>, "wait" | "cancel"> {
	const unknown = async (): Promise<WaitOutcome<LaunchResult>> => ({ status: "unknown" });
	return {
		wait: (id, timeoutMs, signal) => (asides.isModelVisible(id) ? registry.wait(id, timeoutMs, signal) : unknown()),
		cancel: (id) => (asides.isModelVisible(id) ? registry.cancel(id) : unknown()),
	};
}

/** The data of a recorded answer (the custom entry's `data`). */
export interface BtwEntryData {
	id: string;
	title: string;
	question: string;
	status: "answered" | "failed";
	answer?: string;
	error?: string;
}

const capAnswer = (text: string): string => (text.length <= BTW_ANSWER_MAX ? text : `${text.slice(0, BTW_ANSWER_MAX)}\n\n(answer cut at ${BTW_ANSWER_MAX} characters; the full text is in the run folder)`);

/** The entry for a settled aside: its answer, or why it failed. */
export function btwEntry(input: { id: string; question: string; launch: Pick<LaunchSummary, "error">; result?: LaunchResult }): BtwEntryData {
	const base = { id: input.id, title: btwTitle(input.question), question: input.question };
	const text = input.result?.content.map((c) => c.text).join("\n").trim();
	if (input.launch.error !== undefined) return { ...base, status: "failed", error: input.launch.error };
	if (!input.result || !text) return { ...base, status: "failed", error: "no answer was produced" };
	if (input.result.isError) return { ...base, status: "failed", error: capAnswer(text) };
	return { ...base, status: "answered", answer: capAnswer(text) };
}

export interface BtwCardLine {
	text: string;
	tone: "success" | "error" | "dim" | "muted";
}

/**
 * The card of a recorded answer: a header, then (collapsed) the first lines and how many more there are, or (expanded)
 * only the header, because the renderer appends the whole body as markdown.
 */
export function btwCard(data: BtwEntryData | undefined, expanded: boolean): { lines: BtwCardLine[]; hidden: number; body: string } {
	const failed = data?.status === "failed";
	const header: BtwCardLine = { text: `${failed ? "✗" : "■"} by the way · ${data?.title ?? "?"} · ${failed ? "failed" : "answered"} · ${data?.id ?? "?"}`, tone: failed ? "error" : "success" };
	const body = failed ? `Error: ${data?.error ?? "unknown"}` : (data?.answer ?? "(no answer)");
	if (expanded) return { lines: [header], hidden: 0, body };
	const bodyLines = body.split("\n");
	const lines: BtwCardLine[] = [header, ...bodyLines.slice(0, BTW_CARD_LINES).map((text): BtwCardLine => ({ text: `  ${text}`, tone: failed ? "error" : "dim" }))];
	const hidden = Math.max(0, bodyLines.length - BTW_CARD_LINES);
	if (hidden > 0) lines.push({ text: `  … ${hidden} more line${hidden === 1 ? "" : "s"}`, tone: "muted" });
	return { lines, hidden, body };
}
