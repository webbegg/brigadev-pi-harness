// What `brigadev-runner status|answer|pause|resume` do with a loop, as functions of a Runner: they read the loop's state, hand a signal over
// (`runner.deliver`, which never schedules), and say what happened. Exit codes (S4): delivered 0; `duplicate` and `closed` are final answers
// (1, printed as such); `invalid` is a usage error (2) with the reason; `not_found` 1. The CLI prints `text` to stdout for 0, stderr otherwise.
import { readFileSync } from "node:fs";
import type { SignalResult } from "@earendil-works/pi-durable";
import { parseTicketList } from "../../lib/ticket-list.ts";
import type { Runner } from "./runner.ts";
import { ANSWER, PAUSE, pauseKey, RESUME, signalExit, signalLine } from "./signals.ts";

export interface ControlResult {
	code: 0 | 1 | 2;
	text: string;
	/** The signal's result, when one was delivered. */
	result?: SignalResult;
}

const failure = (text: string, code: 1 | 2 = 1, result?: SignalResult): ControlResult => ({ code, text, ...(result ? { result } : {}) });
const startAgain = (docPath: string) => `Run \`brigadev-runner start ${docPath}\` to continue the loop (answers are picked up when it starts).`;

/** The loop for a doc and its status, or the failure to report: never started, or finished (a final `closed`). */
async function liveLoop(runner: Runner, docPath: string) {
	const id = await runner.find(docPath);
	if (id === undefined) return { failure: failure(`not_found: no runner state for ${docPath}; it was never started`, 1, "not_found") };
	const status = await runner.status(id);
	if (status.state === "done" || status.state === "stalled" || status.state === "failed" || status.state === "aborted") {
		return { failure: failure(signalLine("closed", `the loop ended (${status.state}); nothing is waiting for a signal`), 1, "closed") };
	}
	return { id, status };
}

export async function answerDecision(runner: Runner, docPath: string, ticketId: string, choice: string, options: { approve?: boolean } = {}): Promise<ControlResult> {
	const loop = await liveLoop(runner, docPath);
	if ("failure" in loop) return loop.failure;
	const { id, status } = loop;
	const open = status.decisions.find((decision) => decision.ticketId === ticketId);
	// An answered or expired decision is no longer open, but its key is still the one to answer: the signal says `duplicate` or `closed`.
	const key = open?.key ?? status.lastKeys[ticketId];
	if (key === undefined) return failure(signalLine("not_found", `no decision for ${ticketId}`), 1, "not_found");

	let value: { choice: string; option?: number; approve?: boolean };
	let said = `${ticketId} answered: ${choice}`;
	if (open && /^\d+$/.test(choice)) {
		const number = Number(choice);
		if (number < 1 || number > open.options.length) {
			return failure(signalLine("invalid", `${choice} is not an option (1-${open.options.length}); to answer with text, say more than a number`), 2, "invalid");
		}
		const label = open.options[number - 1].label;
		value = { choice: label, option: number };
		said = `${ticketId} answered ${number}. ${label}`;
	} else {
		value = { choice };
	}
	if (options.approve) value.approve = true;

	const result = await runner.deliver(id, ANSWER, key, value);
	switch (result) {
		case "delivered":
			return { code: 0, result, text: `${signalLine(result, said)}${options.approve ? " (command approved)" : ""}\n${startAgain(docPath)}` };
		case "duplicate":
			return failure(signalLine(result, `${ticketId} already has an answer`), 1, result);
		case "closed":
			return failure(signalLine(result, `${ticketId}'s decision is closed: its 24 h deadline passed, or the loop ended`), 1, result);
		case "invalid":
			return failure(signalLine(result, "the answer was refused (it must be non-empty text or an option number)"), 2, result);
		default:
			return failure(signalLine(result, `no decision for ${ticketId}`), signalExit(result) === 2 ? 2 : 1, result);
	}
}

export async function pauseLoop(runner: Runner, docPath: string): Promise<ControlResult> {
	const loop = await liveLoop(runner, docPath);
	if ("failure" in loop) return loop.failure;
	const { id, status } = loop;
	if (status.state === "paused") return failure(`already paused: ${status.reason}. Resume with \`brigadev-runner resume ${docPath}\`.`);
	const result = await runner.deliver(id, PAUSE, pauseKey(status.epoch), { by: "cli" });
	if (result === "delivered") return { code: 0, result, text: signalLine(result, "pause requested: the loop pauses at its next pick (a running ticket finishes first)") };
	return failure(signalLine(result, result === "duplicate" ? "pause already requested" : "the pause request was refused"), signalExit(result) === 2 ? 2 : 1, result);
}

export async function resumeLoop(runner: Runner, docPath: string): Promise<ControlResult> {
	const loop = await liveLoop(runner, docPath);
	if ("failure" in loop) return loop.failure;
	const { id, status } = loop;
	if (status.state !== "paused" || status.resumeKey === undefined) return failure(`not paused: the loop is ${status.state}`);
	const result = await runner.deliver(id, RESUME, status.resumeKey, { by: "cli" });
	if (result === "delivered") return { code: 0, result, text: `${signalLine(result, "resume requested")}\n${startAgain(docPath)}` };
	return failure(signalLine(result, result === "duplicate" ? "resume already requested" : "the resume request was refused"), signalExit(result) === 2 ? 2 : 1, result);
}

/** Read-only: the loop's state, every ticket's status from the doc, and each open decision with its options and the exact answer command. */
export async function statusText(runner: Runner, docPath: string): Promise<ControlResult> {
	const id = await runner.find(docPath);
	if (id === undefined) return failure(`no runner state for ${docPath}; run \`brigadev-runner start ${docPath}\``);
	const status = await runner.status(id);
	const lines: string[] = [];
	switch (status.state) {
		case "sleeping":
			lines.push(`loop: sleeping${status.decisions.length > 0 ? ` (waiting for ${status.decisions.length} decision${status.decisions.length === 1 ? "" : "s"})` : ""}`);
			break;
		case "paused":
			lines.push(`loop: paused: ${status.reason}`);
			break;
		case "stalled":
			lines.push(`loop: stalled (waiting: ${(status.waiting ?? []).join(", ")})`);
			break;
		case "failed":
			lines.push(`loop: failed: ${status.reason}`);
			break;
		default:
			lines.push(`loop: ${status.state}`);
	}
	lines.push("tickets:");
	try {
		for (const ticket of parseTicketList(readFileSync(docPath, "utf8")).tickets) lines.push(`  ${ticket.id} ${ticket.status ?? "pending"}${ticket.title ? `  ${ticket.title}` : ""}`);
	} catch (error) {
		lines.push(`  (cannot read ${docPath}: ${(error as Error).message})`);
	}
	for (const decision of status.decisions) {
		lines.push("", `decision ${decision.ticketId}: ${decision.question}`);
		decision.options.forEach((option, index) => lines.push(`  ${index + 1}. ${option.label}${decision.recommended === index + 1 ? " (recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`));
		if (decision.command !== null) lines.push(`  command to approve: ${decision.command} (an option starting with "Approve", or --approve, lets the rerun run it once)`);
		lines.push(`  answer: brigadev-runner answer ${docPath} ${decision.ticketId} <1..${decision.options.length}|text>`, `  deadline: ${new Date(decision.until).toISOString()}`);
	}
	if (status.state === "paused") lines.push("", `resume: brigadev-runner resume ${docPath}`);
	return { code: 0, text: lines.join("\n") };
}
