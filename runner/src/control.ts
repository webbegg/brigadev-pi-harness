// What `brigadev-runner status|answer|pause|resume` do with a loop, as functions of a Runner: they read the loop's state, hand a signal over
// (`runner.deliver`, which never schedules), and say what happened. Exit codes (S4): delivered 0; `duplicate` and `closed` are final answers
// (1, printed as such); `invalid` is a usage error (2) with the reason; `not_found` 1. The CLI prints `text` to stdout for 0, stderr otherwise.
import { readFileSync } from "node:fs";
import type { SignalResult } from "@earendil-works/pi-durable";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { dollars, reached } from "./cost.ts";
import type { Runner } from "./runner.ts";
import { ANSWER, MERGE, mergeCommand, PAUSE, pauseKey, RESUME, signalExit, signalLine } from "./signals.ts";

export interface ControlResult {
	code: 0 | 1 | 2;
	text: string;
	/** The signal's result, when one was delivered. */
	result?: SignalResult;
}

const failure = (text: string, code: 1 | 2 = 1, result?: SignalResult): ControlResult => ({ code, text, ...(result ? { result } : {}) });

/**
 * What a caller that showed a person a prompt says that prompt was (R1-001): the key it named, and for the merge the head commit it showed. The control acts only when the state it
 * reads itself, in the same call that delivers, still is that: a prompt that moved on (a new decision round, a new push, a new pause) is refused and nothing is delivered. The
 * CLI passes none and acts on what is open now.
 */
export interface Expect {
	key: string;
	/** The commit the merge approval was shown for (the PR loop's pushed head). */
	sha?: string;
}

const stale = (what: string): ControlResult => failure(`no longer current: ${what}; nothing was delivered`);
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

export async function answerDecision(runner: Runner, docPath: string, ticketId: string, choice: string, options: { approve?: boolean; expect?: Expect } = {}): Promise<ControlResult> {
	const loop = await liveLoop(runner, docPath);
	if ("failure" in loop) return loop.failure;
	const { id, status } = loop;
	// A fix ticket's question (FIX-n) belongs to the PR loop task, which holds the signal wait; a ticket's, to the loop.
	const loopOpen = status.decisions.find((decision) => decision.ticketId === ticketId);
	const prOpen = status.pr?.decisions.find((decision) => decision.ticketId === ticketId);
	const prKey = status.pr?.lastKeys[ticketId];
	const inPr = prOpen !== undefined || (loopOpen === undefined && status.lastKeys[ticketId] === undefined && prKey !== undefined);
	const target = inPr && status.pr ? status.pr.taskId : id;
	const open = prOpen ?? loopOpen;
	if (options.expect && open?.key !== options.expect.key) {
		return stale(open ? `${ticketId} moved on to ${open.key} (the answer was for ${options.expect.key})` : `${ticketId}'s decision ${options.expect.key} is not open any more`);
	}
	// An answered or expired decision is no longer open, but its key is still the one to answer: the signal says `duplicate` or `closed`.
	const key = open?.key ?? (inPr ? prKey : status.lastKeys[ticketId]);
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

	const result = await runner.deliver(target, ANSWER, key, value);
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
	if (status.pr) return failure(`the PR loop is running (${status.pr.phase}): a pause is read at a ticket pick, and no ticket is left. It parks by itself when it needs you.`);
	const result = await runner.deliver(id, PAUSE, pauseKey(status.epoch), { by: "cli" });
	if (result === "delivered") return { code: 0, result, text: signalLine(result, "pause requested: the loop pauses at its next pick (a running ticket finishes first)") };
	return failure(signalLine(result, result === "duplicate" ? "pause already requested" : "the pause request was refused"), signalExit(result) === 2 ? 2 : 1, result);
}

/**
 * `resume`. A stop at the loop's cost cap is lifted only with a higher cap (`options.cap`, dollars): it must be above the spend, else nothing is delivered (exit 2); a plain resume
 * there is refused with the hint, and `--cap` anywhere else is refused. The new cap is written in the commit that delivers the resume.
 */
export async function resumeLoop(runner: Runner, docPath: string, expect?: Expect, options: { cap?: number } = {}): Promise<ControlResult> {
	const loop = await liveLoop(runner, docPath);
	if ("failure" in loop) return loop.failure;
	const { id, status } = loop;
	// The PR loop's own stop (needs-you) is lifted through its task; the ticket loop's pause through the loop's.
	const parked = status.state !== "paused" && status.pr?.resumeKey !== undefined ? status.pr : undefined;
	if (!parked && (status.state !== "paused" || status.resumeKey === undefined)) {
		return failure(`not paused: the loop is ${status.state}${status.pr ? ` (PR loop: ${status.pr.phase})` : ""}`);
	}
	const key = parked ? parked.resumeKey! : status.resumeKey!;
	if (expect && key !== expect.key) return stale(`the resume prompt ${expect.key} was replaced by ${key}`);
	const atCap = parked ? parked.costCap === true : status.kind === "cost";
	const spent = status.cost?.spent ?? 0;
	if (options.cap !== undefined && !atCap) return failure(`not a cost-cap park: --cap applies only when the loop stopped at its cost cap (${parked ? parked.reason : status.reason}); nothing was delivered`, 2);
	const storedCap = status.cost?.cap ?? 0;
	if (atCap) {
		// A cap already above the spend (raised by `start --cap`) lets a plain resume through: it would not stop again at once.
		if (options.cap === undefined && reached(spent, storedCap)) {
			return failure(
				`${parked ? parked.reason : status.reason}. A plain resume would stop again at once: raise the cap with \`brigadev-runner resume ${docPath} --cap <dollars>\` (the cap is ${dollars(storedCap)}); nothing was delivered`,
				2,
			);
		}
		if (options.cap !== undefined && reached(spent, options.cap)) return failure(`the new cap ${dollars(options.cap)} must be above the spend ${dollars(spent)}; nothing was delivered`, 2);
	}
	const result = await runner.deliver(parked ? parked.taskId : id, RESUME, key, { by: "cli" }, atCap && options.cap !== undefined ? { cap: { loop: id, dollars: options.cap } } : undefined);
	if (result === "delivered") return { code: 0, result, text: `${signalLine(result, atCap ? `resume requested with cost cap ${dollars(options.cap ?? storedCap)} (spent ${dollars(spent)})` : "resume requested")}\n${startAgain(docPath)}` };
	return failure(signalLine(result, result === "duplicate" ? "resume already requested" : "the resume request was refused"), signalExit(result) === 2 ? 2 : 1, result);
}

/**
 * `merge`: the user's approval to merge the PR, delivered to the PR loop while it waits for it. The runner then re-reads the PR and merges only when it is
 * open, not a draft, still at the pushed commit, and green. `duplicate` and `closed` (a second approval; the 24 h deadline, or the loop ended) are final
 * answers, like an answer's.
 */
export async function mergeLoop(runner: Runner, docPath: string, expect?: Expect): Promise<ControlResult> {
	const loop = await liveLoop(runner, docPath);
	if ("failure" in loop) return loop.failure;
	const { status } = loop;
	const pr = status.pr;
	if (!pr || pr.mergeKey === undefined) {
		return failure(`not waiting for a merge approval: ${pr ? `the PR loop is at ${pr.phase}` : "the loop has not reached the PR loop"}. \`brigadev-runner status ${docPath}\` says where it is.`);
	}
	if (expect && (pr.mergeKey !== expect.key || (expect.sha !== undefined && pr.sha !== expect.sha))) {
		return stale(pr.mergeKey !== expect.key ? `the merge approval ${expect.key} was replaced by ${pr.mergeKey}` : `the PR head moved (the approval was for ${expect.sha?.slice(0, 7)}, it is ${pr.sha?.slice(0, 7) ?? "unknown"} now)`);
	}
	const result = await runner.deliver(pr.taskId, MERGE, pr.mergeKey, { by: "cli" });
	switch (result) {
		case "delivered":
			return { code: 0, result, text: `${signalLine(result, `merge approved for ${pr.url ?? "the PR"}`)}\n${startAgain(docPath)} The runner re-reads the PR first: it merges only when the PR is open, not a draft, at the pushed commit, and green.` };
		case "duplicate":
			return failure(signalLine(result, "the merge was already approved"), 1, result);
		case "closed":
			return failure(signalLine(result, "the merge approval is closed: its 24 h deadline passed, or the loop ended"), 1, result);
		case "invalid":
			return failure(signalLine(result, "the approval was refused"), 2, result);
		default:
			return failure(signalLine(result, `no merge approval is awaited by ${docPath}`), 1, result);
	}
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
			lines.push(`loop: ${status.state}${status.merged ? ` (merged ${status.merged.url})` : ""}`);
	}
	if (status.cost) lines.push(`spend ${dollars(status.cost.spent)} of ${dollars(status.cost.cap)}`);
	if (status.pr) {
		lines.push(`pr: ${status.pr.phase}${status.pr.url ? `  ${status.pr.url}` : ""}`);
		if (status.pr.reason) lines.push(`  needs you: ${status.pr.reason}`);
		if (status.pr.warning) lines.push(`  warning: ${status.pr.warning}`);
	}
	lines.push("tickets:");
	try {
		for (const ticket of parseTicketList(readFileSync(docPath, "utf8")).tickets) lines.push(`  ${ticket.id} ${ticket.status ?? "pending"}${ticket.title ? `  ${ticket.title}` : ""}`);
	} catch (error) {
		lines.push(`  (cannot read ${docPath}: ${(error as Error).message})`);
	}
	for (const decision of [...status.decisions, ...(status.pr?.decisions ?? [])]) {
		lines.push("", `decision ${decision.ticketId}: ${decision.question}`);
		decision.options.forEach((option, index) => lines.push(`  ${index + 1}. ${option.label}${decision.recommended === index + 1 ? " (recommended)" : ""}${option.description ? ` — ${option.description}` : ""}`));
		if (decision.command !== null) lines.push(`  command to approve: ${decision.command} (an option starting with "Approve", or --approve, lets the rerun run it once)`);
		lines.push(`  answer: brigadev-runner answer ${docPath} ${decision.ticketId} <1..${decision.options.length}|text>`, `  deadline: ${new Date(decision.until).toISOString()}`);
	}
	if (status.state === "paused" || status.pr?.resumeKey !== undefined) lines.push("", `resume: brigadev-runner resume ${docPath}${status.kind === "cost" || status.pr?.costCap === true ? " --cap <dollars>" : ""}`);
	if (status.pr?.mergeKey !== undefined) lines.push("", `merge: ${mergeCommand(docPath)}`);
	return { code: 0, text: lines.join("\n") };
}
