// The runner's board (T7, S6): the existing web UI served from the runner process. The loop's state becomes the `{type, data}` events the page folds (the bus snapshot
// shapes of lib/bus.ts and the core `session` and `run` types), and the page's actions are delivered through the live Runner, in this process, by the same
// functions the CLI uses (src/control.ts), so a decision answered here and one answered with `brigadev-runner answer` do the same thing.
//
// Source of events: `runner.status()` (the loop and its PR loop), the doc's `## Tasks`, and `runner.ticketRuns()` (each ticket's latest worker run, with its recent tool
// calls, from storage reads). It is read again when the task graph advances (debounced: the observer only schedules, it never awaits, as pi-durable requires) and on a
// slow timer as a fallback, and only what changed is published. Everything that leaves goes through `mask` (lib/redact.ts and src/redact.ts, the stricter of the two
// shapes each): reasons, failure output, commands, worker text, and what a refusal says.
//
// An answer acts only on what the page showed (R1-001): each open prompt keeps the identity it was published with (the signal key it names, and for the merge the head commit
// its title shows), and the control it calls checks that identity against the state it reads itself and delivers with that key, so a state that moved on in between is refused.
//
// The board never sees or stores the one-time code or a session secret: those live in lib/web-server.ts. It never writes the store, the doc, or a PR comment.
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import type { Action, AgentState, AgentStep, Phase, PromptState, SessionState, TodoItem } from "../../lib/bus.ts";
import { readCurrentBranch } from "../../lib/commit-branch.ts";
import { redact as redactLib } from "../../lib/redact.ts";
import { parseTicketList, type Ticket } from "../../lib/ticket-list.ts";
import { createWebLog, type WebLog } from "../../lib/web-log.ts";
import { webPage } from "../../lib/web-page.ts";
import { ActionRefused, startWebServer, type WebServer } from "../../lib/web-server.ts";
import { answerDecision, mergeLoop, pauseLoop, resumeLoop, type ControlResult } from "./control.ts";
import { dollars } from "./cost.ts";
import { nodeExec } from "./exec.ts";
import { redact as redactRunner } from "./redact.ts";
import type { LoopResult, LoopStatus, Runner, TicketRun } from "./runner.ts";
import type { OpenDecision } from "./tasks.ts";

// ---------------------------------------------------------------------------------------------------------------------
// The mapping: the loop's state as what the page shows

/**
 * Text that leaves for the page: both redactors. lib/redact.ts knows flags, assignments, and URLs credentials; src/redact.ts also masks standard base64 (with `+` and `/`, an AWS
 * secret key), which it does not.
 */
const redactBoth = (text: string): string => redactRunner(redactLib(text));

/**
 * R4-002: worker-controlled strings (a tool call's command or path, a decision's text) are bounded before the redactors see them. src/redact.ts has a pattern whose cost grows with
 * the square of a long run of `[a-z0-9+.-]`, and the board reads the store on a timer on the one event loop the runner's loop, its lock, and the Harness share.
 * The cut can split a secret, and half of one is below the redactors' thresholds (a 20-character start of a 64-character token is not masked): so the input is cut generously
 * (`limit`), redacted, and the last `TAIL_MARGIN` characters of the result, which the cut can have touched, are dropped. What is left is redacted whole, and nothing of it is
 * within the longest bounded pattern (256) of the cut. A string within the limit is redacted as it was.
 */
const RAW_LIMIT = 8_192;
const TAIL_MARGIN = 512;
function redactBounded(text: string, limit: number): string {
	if (text.length <= limit) return redactBoth(text);
	const out = redactBoth(text.slice(0, limit));
	return `${out.slice(0, Math.max(0, out.length - TAIL_MARGIN))}…`;
}

const redact = (text: string): string => redactBounded(text, RAW_LIMIT);

/** What answering a prompt does: the control it maps to, with the identity (`key`, and the merge's head `sha`) the prompt was shown with. */
type Target =
	| { kind: "decision"; ticketId: string; labels: string[]; key: string }
	| { kind: "merge"; key: string; sha?: string }
	/** `cost`: a stop at the cost cap, answered with a new cap: the option labels, and the spend and increments (dollars) they stand for. */
	| { kind: "resume"; scope: "loop" | "pr"; key: string; cost?: { labels: string[]; spent: number; increments: number[] } };

/** The raises the board offers at the cost cap, besides an amount typed in. */
const CAP_RAISES = [5, 10];
/** A typed-in new cap: dollars, with an optional `$`. */
const capAmount = (text: string): number | undefined => {
	const match = /^\$?\s*(\d+\.?\d*|\.\d+)$/.exec(text.trim());
	return match && Number(match[1]) > 0 ? Number(match[1]) : undefined;
};

/** The prompt of a stop at the cost cap: raise the cap by $5 or $10 over the spend, or type the new cap. */
function capPrompt(id: string, scope: "loop" | "pr", reason: string, spent: number): BoardView["prompts"][number] {
	const labels = CAP_RAISES.map((raise) => `+$${raise} (cap ${dollars(spent + raise)})`);
	return {
		state: { id, kind: "choice", source: "runner", title: `Raise the cost cap and resume the ${scope === "pr" ? "PR loop" : "loop"}?`, body: reason, options: labels.map((label) => ({ label })), allowOther: true, status: "open", at: 0 },
		target: { kind: "resume", scope, key: id, cost: { labels: labels.map(redact), spent, increments: CAP_RAISES } },
	};
}

export interface BoardView {
	session: SessionState;
	todo: { scope: "todo"; todos: TodoItem[] };
	phase: { phase: Phase; detail?: string };
	/** The loop is working (a ticket or the PR loop runs, or a CI poll is pending), not parked on a person or ended. */
	running: boolean;
	agents: AgentState[];
	prompts: Array<{ state: PromptState; target: Target }>;
}

export interface ViewInput {
	project: string;
	branch: string | null;
	/** The feature document's file name. */
	doc: string;
	/** Undefined until the loop exists. */
	status?: LoopStatus;
	tickets: Ticket[];
	runs: TicketRun[];
}

const MAX_OUTPUT = 4_000;
const MAX_SUMMARY = 200;
/** A summary shows 200 characters, so a tool argument is bounded far below `RAW_LIMIT` before it is redacted (the cost of the bound itself stays small). */
const SUMMARY_RAW_LIMIT = 2_048;
const cap = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim();
const short = (sha: string): string => sha.slice(0, 7);

/** Tool argument fields worth a one-line summary, in order (as the Pi extension does): bodies (content, oldText, ...) are never forwarded. */
const SUMMARY_FIELDS = ["path", "file_path", "command", "pattern", "agent", "question"] as const;
export function summarize(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const fields = args as Record<string, unknown>;
	for (const field of SUMMARY_FIELDS) {
		const value = fields[field];
		if (typeof value === "string" && value) return cap(oneLine(redactBounded(value, SUMMARY_RAW_LIMIT)), MAX_SUMMARY);
	}
	return "";
}

type CardStatus = "running" | "done" | "failed" | "blocked" | "needs-you";

function ticketCard(id: string, ticket: Ticket | undefined, run: TicketRun | undefined, asked: OpenDecision | undefined, loopLive: boolean): AgentState | undefined {
	const note = ticket?.note ?? "";
	let status: CardStatus | undefined;
	if (asked) status = "needs-you";
	else if (ticket?.status === "done") status = "done";
	else if (ticket?.status === "in_progress") status = /^needs you\b/.test(note) ? "needs-you" : loopLive ? "running" : "blocked";
	else if (ticket?.status === "blocked") status = run?.end === "failed" || run?.end === "aborted" ? "failed" : /^needs you: decision/.test(note) ? "needs-you" : "blocked";
	else if (!ticket && run) status = run.live ? "running" : run.end === "commit" ? "done" : run.end === "decision" || run.end === "integrity" ? "needs-you" : "failed";
	if (!status) return undefined; // pending, dropped, or unknown: it has not run

	const title = ticket ? oneLine(ticket.title) || id : `${id} (PR loop fix)`;
	const attempts = run ? `attempts: ${run.attempts}` : undefined;
	let output: string | undefined;
	switch (status) {
		case "done": {
			const commit = run?.commit ? short(run.commit) : /^([0-9a-f]{7,40})\b/.exec(note)?.[1]?.slice(0, 7);
			output = ["DONE", "", commit ? `commit: ${commit}` : undefined, ticket?.done ? `done check: ${oneLine(ticket.done)}` : undefined, attempts].filter((line) => line !== undefined).join("\n");
			break;
		}
		case "failed": {
			output = ["FAILED", "", run?.failure ?? note, attempts].filter((line) => line !== undefined).join("\n");
			if (run?.outputTail) output += `\n\n\`\`\`\n${run.outputTail}\n\`\`\``;
			break;
		}
		case "blocked":
			output = `BLOCKED\n\n${note || "blocked"}`;
			break;
		case "needs-you":
			output = asked
				? `Needs you: ${oneLine(asked.question)}\n\n${asked.options.map((option, index) => `${index + 1}. ${option.label}${asked.recommended === index + 1 ? " (recommended)" : ""}`).join("\n")}`
				: `Needs you: ${note.replace(/^needs you:?\s*/, "") || "see the ticket"}`;
			break;
		case "running":
			break;
	}
	const steps: AgentStep[] = (run?.steps ?? []).map((step) => ({ tool: cap(step.tool, 80), summary: summarize(step.args) }));
	const taskText = [`${id}: ${title}`, "", ticket?.done ? `done: ${ticket.done}` : undefined, ticket && ticket.specs.length > 0 ? `specs: ${ticket.specs.join(", ")}` : undefined, ticket && ticket.deps.length > 0 ? `deps: ${ticket.deps.join(", ")}` : undefined]
		.filter((line) => line !== undefined)
		.join("\n");
	const reason = status === "running" ? (run ? `attempt ${run.attempts} of ${run.maxAttempts}` : undefined) : status === "done" ? undefined : cap(oneLine(note || run?.failure || ""), 300) || undefined;
	return {
		id: `ticket:${id}`,
		launchId: `ticket:${id}`,
		index: 0,
		agent: "brigadev-worker",
		task: cap(title, 200),
		taskText: cap(taskText, MAX_OUTPUT),
		...(reason ? { reason } : {}),
		...(steps.length > 0 ? { steps } : {}),
		...(output ? { output: cap(output, MAX_OUTPUT) } : {}),
		status: status as AgentState["status"],
		tokens: 0,
		cost: run?.cost ?? 0,
		...(run?.startedAt === undefined ? {} : { startedAt: run.startedAt }),
		...(run?.endedAt === undefined ? {} : { endedAt: run.endedAt }),
		cancellable: false,
	};
}

/** What the runner knows of CI, from where the PR loop is (it keeps no check results in its state). */
function ciOf(phase: string): string {
	if (phase === "wait-ci") return "waiting for the checks";
	if (phase.startsWith("fix")) return `failed, ${phase} in progress`;
	if (phase === "wait-merge") return "passed (the runner re-reads it before merging)";
	return "not started";
}

function prCard(status: LoopStatus): AgentState | undefined {
	const { pr, merged } = status;
	if (!pr && !merged) return undefined;
	const number = pr?.number ?? merged?.number;
	const url = pr?.url ?? merged?.url;
	const phase = pr?.phase ?? "done";
	const waiting = pr !== undefined && (pr.mergeKey !== undefined || pr.phase === "needs-you");
	const agentStatus: AgentState["status"] = (merged ? "done" : waiting ? "needs-you" : "running") as AgentState["status"];
	let output: string;
	if (merged) output = `DONE\n\nMerged: ${url}`;
	else if (pr?.phase === "needs-you") output = `Needs you: ${pr.reason ?? "the PR loop stopped"}${url ? `\n\nPR: ${url}` : ""}`;
	else if (pr?.mergeKey !== undefined) output = `Waiting for your approval to merge.\n\nPR: ${url}\nCI: ${ciOf(phase)}`;
	else output = `Phase: ${phase}\n\n${url ? `PR: ${url}\n` : ""}CI: ${ciOf(phase)}`;
	if (pr?.warning) output += `\n\nwarning: ${pr.warning}`;
	return {
		id: "pr",
		launchId: "pr",
		index: 0,
		agent: "brigadev-pr",
		task: `Pull request${number === undefined ? "" : ` #${number}`}: ${phase}`,
		taskText: [`Pull request${number === undefined ? "" : ` #${number}`}`, url ? `url: ${url}` : undefined, `phase: ${phase}`, `CI: ${ciOf(phase)}`].filter((line) => line !== undefined).join("\n"),
		reason: `phase: ${phase}`,
		output: cap(output, MAX_OUTPUT),
		status: agentStatus,
		tokens: 0,
		cost: 0,
		cancellable: false,
	};
}

/** The loop phase of the page's column strip: implement while a ticket runs, check in final-check, verify, CI and fix, commit for push, open and the merge wait, close when done. */
function phaseOf(status: LoopStatus | undefined, runningTickets: string[]): { phase: Phase; detail?: string } {
	if (!status) return { phase: "idle" };
	switch (status.state) {
		case "done":
			return { phase: "close", detail: status.merged ? `merged ${status.merged.url}` : "every ticket is done" };
		case "failed":
			return { phase: "idle", detail: `failed: ${status.reason ?? ""}` };
		case "aborted":
			return { phase: "idle", detail: "aborted" };
		case "stalled":
			return { phase: "idle", detail: `stalled: ${(status.waiting ?? []).join(", ")}` };
		case "paused":
			return { phase: "idle", detail: `paused: ${status.reason ?? ""}` };
	}
	const pr = status.pr;
	if (pr) {
		if (pr.phase === "needs-you") return { phase: "idle", detail: `PR loop: needs you` };
		if (pr.phase === "push" || pr.phase === "open" || pr.phase === "wait-merge") return { phase: "commit", detail: `PR loop: ${pr.phase}` };
		return { phase: "check", detail: `PR loop: ${pr.phase}` };
	}
	if (runningTickets.length > 0) return { phase: "implement", detail: runningTickets.join(", ") };
	if (status.decisions.length > 0) return { phase: "decide", detail: `waiting for ${status.decisions.map((decision) => decision.ticketId).join(", ")}` };
	return { phase: "implement" };
}

/** The loop's spend and cap, as the last words of the phase's detail. */
function withSpend(phase: { phase: Phase; detail?: string }, status: LoopStatus | undefined): { phase: Phase; detail?: string } {
	if (!status?.cost) return phase;
	const spend = `spend ${dollars(status.cost.spent)} of ${dollars(status.cost.cap)}`;
	return { ...phase, detail: phase.detail ? `${phase.detail} — ${spend}` : spend };
}

/** The whole board for one moment: plain data from plain inputs, so the mapping is testable without a Harness. */
export function viewOf(input: ViewInput): BoardView {
	const { status, tickets, runs } = input;
	const decisions = status ? [...status.decisions, ...(status.pr?.decisions ?? [])] : [];
	const asked = new Map(decisions.map((decision) => [decision.ticketId, decision]));
	const loopLive = status !== undefined && (status.state === "running" || status.state === "sleeping");
	const runOf = new Map(runs.map((run) => [run.ticketId, run]));

	const agents: AgentState[] = [];
	const seen = new Set<string>();
	for (const ticket of tickets) {
		if (seen.has(ticket.id)) continue;
		seen.add(ticket.id);
		const card = ticketCard(ticket.id, ticket, runOf.get(ticket.id), asked.get(ticket.id), loopLive);
		if (card) agents.push(card);
	}
	for (const run of runs) {
		if (seen.has(run.ticketId)) continue;
		seen.add(run.ticketId);
		const card = ticketCard(run.ticketId, undefined, run, asked.get(run.ticketId), loopLive);
		if (card) agents.push(card);
	}
	const pr = status ? prCard(status) : undefined;
	if (pr) agents.push(pr);

	const prompts: BoardView["prompts"] = [];
	for (const decision of decisions) {
		prompts.push({
			state: {
				id: decision.key,
				kind: "choice",
				source: "ask",
				title: cap(`${decision.ticketId}: ${oneLine(decision.question)}`, 500),
				...(decision.command !== null ? { body: `command to approve: ${decision.command}` } : {}),
				options: decision.options.map((option) => ({ label: option.label, ...(option.description ? { description: option.description } : {}) })),
				...(decision.recommended !== null ? { recommended: decision.recommended } : {}),
				allowOther: true,
				status: "open",
				at: 0,
			},
			target: { kind: "decision", ticketId: decision.ticketId, labels: decision.options.map((option) => redact(option.label)), key: decision.key },
		});
	}
	const prStatus = status?.pr;
	if (prStatus?.mergeKey !== undefined) {
		prompts.push({
			state: {
				id: prStatus.mergeKey,
				kind: "confirm",
				source: "merge",
				title: `Merge PR #${prStatus.number ?? "?"} at ${prStatus.sha ? short(prStatus.sha) : "the pushed commit"}?`,
				body: [prStatus.url, `CI: ${ciOf(prStatus.phase)}`].filter(Boolean).join("\n"),
				status: "open",
				at: 0,
			},
			target: { kind: "merge", key: prStatus.mergeKey, ...(prStatus.sha ? { sha: prStatus.sha } : {}) },
		});
	}
	if (status?.state === "paused" && status.resumeKey !== undefined) {
		if (status.kind === "cost") prompts.push(capPrompt(status.resumeKey, "loop", status.reason ?? "", status.cost?.spent ?? 0));
		else prompts.push({ state: { id: status.resumeKey, kind: "confirm", source: "runner", title: "Resume the loop?", body: status.reason ?? "", status: "open", at: 0 }, target: { kind: "resume", scope: "loop", key: status.resumeKey } });
	} else if (prStatus?.resumeKey !== undefined) {
		if (prStatus.costCap) prompts.push(capPrompt(prStatus.resumeKey, "pr", prStatus.reason ?? "", status?.cost?.spent ?? 0));
		else prompts.push({ state: { id: prStatus.resumeKey, kind: "confirm", source: "runner", title: "Resume the PR loop?", body: prStatus.reason ?? "", status: "open", at: 0 }, target: { kind: "resume", scope: "pr", key: prStatus.resumeKey } });
	}

	// Parked on a person: the loop sleeps on decisions or a pause, the PR loop waits for a merge approval, a stop, or a fix ticket's question.
	const waitingOnYou = prStatus !== undefined && (prStatus.mergeKey !== undefined || prStatus.phase === "needs-you" || prStatus.decisions.length > 0);
	const running = status?.state === "running" && !waitingOnYou;
	const runningTickets = agents.filter((card) => card.id.startsWith("ticket:") && card.status === ("running" as AgentState["status"])).map((card) => card.id.slice("ticket:".length));
	return {
		session: { id: "session", project: input.project, branch: input.branch, kind: "runner", doc: input.doc },
		todo: { scope: "todo", todos: tickets.map((ticket) => ({ id: ticket.id, text: oneLine(ticket.title) || ticket.id, status: ticket.status ?? "pending", ...(ticket.note ? { note: cap(oneLine(ticket.note), 300) } : {}) })) },
		phase: withSpend(phaseOf(status, runningTickets), status),
		running,
		agents,
		prompts,
	};
}

/** `value` with every string redacted: the one gate between the runner's state and the page. */
export function clean<T>(value: T): T {
	if (typeof value === "string") return redact(value) as T;
	if (Array.isArray(value)) return value.map(clean) as T;
	if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clean(item)])) as T;
	return value;
}

// ---------------------------------------------------------------------------------------------------------------------
// The board: refresh, publish what changed, act

export interface BoardOptions {
	runner: Runner;
	docPath: string;
	log: WebLog;
	/** Wait after the task graph advances before reading the state again (default 300 ms). */
	debounceMs?: number;
	/** The fallback refresh interval (default 5 s). */
	pollMs?: number;
	/** Watch the task graph (default true); false leaves the timer as the only trigger. */
	observe?: boolean;
	/** The checked-out branch (default: `git symbolic-ref` in the runner's worktree, read at most every 10 s). */
	readBranch?: () => Promise<string | null>;
	now?: () => number;
}

export interface Board {
	/** Read the state and publish what changed. Concurrent calls are coalesced: the result reflects the state after this call. Never rejects. */
	refresh(): Promise<void>;
	/** The page's actions (`lib/web-server.ts` `onAction`). Throws `ActionRefused` for a valid action that does not apply. */
	onAction(action: Action): Promise<void>;
	stop(): Promise<void>;
}

const BRANCH_TTL_MS = 10_000;
const EMPTY_PROMPT = "this prompt is no longer open: it was answered elsewhere or the loop moved on";

export async function createBoard(options: BoardOptions): Promise<Board> {
	const { runner, docPath, log } = options;
	const now = options.now ?? Date.now;
	const debounceMs = options.debounceMs ?? 300;
	const pollMs = options.pollMs ?? 5_000;
	const readBranch = options.readBranch ?? (() => readCurrentBranch(nodeExec, runner.cwd));

	const published = new Map<string, string>();
	/** Prompts last published open, by id, with the target they were published for (what an answer to them acts on); a prompt that leaves the view is closed from here. */
	const open = new Map<string, { state: PromptState; sig: string; target: Target }>();
	/** Prompts answered through this board, by identity (id and target): they close at once, before the loop has moved on. */
	const answered = new Map<string, { value: boolean | string; at: number }>();
	const firstSeen = new Map<string, number>();
	let loopId: TaskId<LoopResult> | undefined;
	let tickets: Ticket[] = [];
	let branch: { value: string | null; at: number } | undefined;
	let phase: { phase: Phase; since: number; visited: Phase[] } | undefined;
	let runningAt: { running: boolean; at: number } | undefined;
	let stopped = false;

	const sigOf = (id: string, target: Target): string => `${id}|${target.kind === "resume" ? `resume-${target.scope}` : target.kind}`;
	const currentBranch = async (): Promise<string | null> => {
		if (!branch || now() - branch.at > BRANCH_TTL_MS) branch = { value: await readBranch().catch(() => null), at: now() };
		return branch.value;
	};

	async function compute(): Promise<BoardView> {
		// The doc first, then the loop: the loop writes a ticket's line (`needs you: decision`) a moment before it commits the decision, so a status read after the doc
		// shows the decision whenever the doc shows the line (the other order can show a card that needs you beside a loop that does not yet).
		try {
			tickets = parseTicketList(readFileSync(docPath, "utf8")).tickets;
		} catch {
			// The doc is mid-write or gone: keep the last list.
		}
		loopId ??= await runner.find(docPath);
		const status = loopId === undefined ? undefined : await runner.status(loopId);
		const runs = loopId === undefined ? [] : await runner.ticketRuns(loopId);
		return viewOf({ project: basename(runner.cwd), branch: await currentBranch(), doc: basename(docPath), status, tickets, runs });
	}

	function publish(type: string, key: string, data: unknown): void {
		const cleaned = clean(data);
		const text = JSON.stringify(cleaned);
		if (published.get(`${type}:${key}`) === text) return;
		published.set(`${type}:${key}`, text);
		log.append({ type, data: cleaned });
	}

	async function refreshNow(): Promise<void> {
		const view = await compute();
		if (stopped) return;
		const at = now();
		if (!phase || phase.phase !== view.phase.phase) {
			const visited = phase ? phase.visited : [];
			phase = { phase: view.phase.phase, since: at, visited: view.phase.phase === "idle" || visited.includes(view.phase.phase) ? visited : [...visited, view.phase.phase] };
		}
		if (!runningAt || runningAt.running !== view.running) runningAt = { running: view.running, at };

		publish("session", "session", view.session);
		publish("brigadev_phase", "loop", {
			scope: "loop",
			phase: phase.phase,
			since: phase.since,
			visited: phase.visited,
			running: view.running,
			source: "inferred",
			...(view.phase.detail ? { detail: view.phase.detail } : {}),
		});
		publish("run", "run", { id: "run", running: view.running, at: runningAt.at });
		publish("brigadev_todo", "todo", view.todo);
		for (const agent of view.agents) publish("brigadev_agent", agent.id, agent);

		const current = new Set<string>();
		for (const { state, target } of view.prompts) {
			const sig = sigOf(state.id, target);
			current.add(sig);
			const web = answered.get(sig);
			if (web) {
				publish("brigadev_prompt", state.id, { ...state, status: "answered", answer: web.value, by: "web", at: web.at });
				open.delete(state.id);
				continue;
			}
			const seenAt = firstSeen.get(sig) ?? at;
			firstSeen.set(sig, seenAt);
			const shown = { ...state, at: seenAt };
			open.set(state.id, { state: shown, sig, target });
			publish("brigadev_prompt", state.id, shown);
		}
		// What was open and is not now: the state moved on (a new decision round, a new PR head, the loop stopped). An answer through this board is known; anything else
		// closes as no longer current (with the board up, `start` holds the store, so the CLI cannot answer).
		for (const [id, entry] of [...open]) {
			if (current.has(entry.sig)) continue;
			open.delete(id);
			const web = answered.get(entry.sig);
			publish("brigadev_prompt", id, web ? { ...entry.state, status: "answered", answer: web.value, by: "web", at: web.at } : { ...entry.state, status: "dismissed", reason: "no longer current", at });
		}
	}

	// R4-002: `running` is cleared by the same synchronous step that finds `again` unset, so a refresh() requested at any point either sets `again` before that check (the loop
	// runs once more) or finds nothing running and starts its own: there is no moment in between at which a request is taken and forgotten.
	let running: Promise<void> | undefined;
	let again = false;
	function refresh(): Promise<void> {
		if (running) {
			again = true;
			return running;
		}
		if (stopped) return Promise.resolve();
		const run = (async () => {
			try {
				do {
					again = false;
					try {
						await refreshNow();
					} catch {
						// A UI is an observer: a failed read (the Harness is closing, the doc is mid-write) shows the last state until the next trigger.
					}
				} while (again && !stopped);
			} finally {
				running = undefined;
			}
		})();
		running = run;
		return run;
	}

	let timer: NodeJS.Timeout | undefined;
	/** Called by the task-graph observer: it only records that a refresh is due. */
	const schedule = () => {
		if (stopped || timer) return;
		timer = setTimeout(() => {
			timer = undefined;
			void refresh();
		}, debounceMs);
		timer.unref();
	};
	const observation = options.observe === false ? undefined : await runner.harness.observeTaskGraph({ advance: schedule, end: () => {} }, BACKGROUND_CONTEXT);
	const poll = setInterval(() => void refresh(), pollMs);
	poll.unref();
	await refresh();

	/** What the control said, for the page (masked), after a refresh so that the page shows what is current now. */
	const refused = async (result: ControlResult): Promise<never> => {
		await refresh();
		throw new ActionRefused(redact(result.text));
	};

	async function onAction(action: Action): Promise<void> {
		switch (action.action) {
			case "prompt":
				throw new ActionRefused("the runner has no conversation: it takes no messages. Answer the cards that need you, or Pause the loop.");
			case "cancel-agent":
				throw new ActionRefused("the runner does not cancel a ticket. Pause the loop instead: it pauses at its next pick, after the running ticket finishes.");
			case "abort": {
				const result = await pauseLoop(runner, docPath);
				if (result.code !== 0) await refused(result);
				await refresh();
				return;
			}
			case "answer": {
				// The prompt must be open now, not as the page last saw it.
				const view = await compute();
				const prompt = view.prompts.find(({ state, target }) => state.id === action.id && !answered.has(sigOf(state.id, target)));
				if (!prompt) throw new ActionRefused(EMPTY_PROMPT);
				// What the page showed for this id (the key, and the merge's head), not what it is now: the control checks it against its own read and delivers with that key.
				const target = open.get(action.id)?.target ?? prompt.target;
				let result: ControlResult | undefined;
				if (target.kind === "decision") {
					if (typeof action.value !== "string") throw new ActionRefused("choose one of the options, or write an answer");
					// A label the page shows is the option's number (as the CLI takes it); anything else is free text, which the CLI also takes.
					const index = target.labels.indexOf(action.value);
					result = await answerDecision(runner, docPath, target.ticketId, index >= 0 ? String(index + 1) : action.value.trim(), { expect: { key: target.key } });
				} else if (target.kind === "resume" && target.cost) {
					if (typeof action.value !== "string") throw new ActionRefused("choose one of the options, or write the new cap in dollars");
					// A label the page shows is a raise over the spend; anything else is the new cap itself, in dollars.
					const index = target.cost.labels.indexOf(action.value);
					const amount = index >= 0 ? Math.round((target.cost.spent + target.cost.increments[index]) * 100) / 100 : capAmount(action.value);
					if (amount === undefined) throw new ActionRefused("write the new cap as an amount in dollars, for example 20");
					result = await resumeLoop(runner, docPath, { key: target.key }, { cap: amount });
				} else {
					if (typeof action.value !== "boolean") throw new ActionRefused("this asks yes or no: approve or deny");
					// Deny is no answer: the runner keeps waiting, and the prompt stays open.
					if (!action.value) return;
					result = target.kind === "merge" ? await mergeLoop(runner, docPath, { key: target.key, ...(target.sha ? { sha: target.sha } : {}) }) : await resumeLoop(runner, docPath, { key: target.key });
				}
				if (result.code !== 0) await refused(result);
				answered.set(sigOf(prompt.state.id, target), { value: action.value, at: now() });
				// Scheduling is on in a `start`; this only makes sure a signal delivered to a sleeping loop is picked up now.
				runner.harness.resume();
				await refresh();
				return;
			}
		}
	}

	return {
		refresh,
		onAction,
		async stop() {
			stopped = true;
			if (timer) clearTimeout(timer);
			clearInterval(poll);
			observation?.detach();
			await running;
		},
	};
}

// ---------------------------------------------------------------------------------------------------------------------
// The board over HTTP

export interface ServeOptions extends Partial<Omit<BoardOptions, "runner" | "docPath" | "log">> {
	/** 0 (default) = ephemeral. */
	port?: number;
}

export interface ServedBoard {
	server: WebServer;
	board: Board;
	log: WebLog;
	close(): Promise<void>;
}

/**
 * The board on 127.0.0.1, with the web UI's own server and page (lib/web-server.ts, lib/web-page.ts: one-time code, session secret, Host and Origin checks), in runner
 * mode. Starts nothing in the loop: call it before `runner.start` so the link exists before anything runs.
 */
export async function serveBoard(runner: Runner, docPath: string, options: ServeOptions = {}): Promise<ServedBoard> {
	const { port, ...boardOptions } = options;
	const log = createWebLog();
	const board = await createBoard({ ...boardOptions, runner, docPath, log });
	let server: WebServer;
	try {
		server = await startWebServer({ host: "127.0.0.1", port: port ?? 0, html: webPage(undefined, { variant: "runner" }), log, onAction: board.onAction });
	} catch (error) {
		await board.stop();
		throw error;
	}
	return {
		server,
		board,
		log,
		async close() {
			await board.stop();
			await server.close();
		},
	};
}
