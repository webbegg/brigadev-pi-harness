// The worker conversation's instructions: `assets/agents/brigadev-worker.md` (via lib/agents.ts) plus the ticket.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAgent, type FrontmatterParser } from "../../lib/agents.ts";
import type { AnsweredDecision } from "./decision.ts";

export const WORKER_AGENT_PATH = fileURLToPath(new URL("../../assets/agents/brigadev-worker.md", import.meta.url));

/** Minimal `---` frontmatter reader: `key: value` lines, surrounding quotes removed. */
export const parseFrontmatter: FrontmatterParser = (content) => {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const pair = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
		if (!pair) continue;
		const value = pair[2].trim();
		if (value === "true" || value === "false") frontmatter[pair[1]] = value === "true";
		else frontmatter[pair[1]] = /^(["']).*\1$/.test(value) ? value.slice(1, -1) : value;
	}
	return { frontmatter, body: match[2] };
};

export interface Worker {
	systemPrompt: string;
	tools: string[];
}

export function loadWorker(path = WORKER_AGENT_PATH): Worker {
	const agent = parseAgent(readFileSync(path, "utf8"), path, "package", parseFrontmatter);
	if (!agent) throw new Error(`${path} is not a valid agent definition`);
	return { systemPrompt: agent.systemPrompt.trim(), tools: agent.tools ?? [] };
}

export interface TicketBrief {
	ticketId: string;
	title: string;
	specs: string[];
	done: string;
	docPath: string;
	attempt: number;
	maxAttempts: number;
	/** What to do, when the ticket has no line in the doc (a PR loop fix ticket): the failure to fix, or the verifier's blockers. */
	spec?: string;
	/** The previous attempt's failure, with the tail of the check output. */
	failure?: string;
	/** A decision this ticket parked on, with the user's answer: the rerun's brief. */
	decision?: AnsweredDecision;
}

/** The `## Decision` section of a rerun: the question, the numbered options, the user's answer, and an approved command. */
export function decisionSection(decision: AnsweredDecision): string[] {
	const lines = ["## Decision from the user", "A previous run of this ticket asked a question and parked; the user answered. Follow the answer; do not ask it again.", `- question: ${decision.question}`, "- options:"];
	decision.options.forEach((option, index) => lines.push(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}${decision.recommended === index + 1 ? " (recommended)" : ""}`));
	lines.push(`- answer: ${decision.answer}`);
	if (decision.command !== null && decision.approved) {
		lines.push(`- approved command: \`${decision.command}\` — the user approved running exactly this command, once, in this run. Any other command, or a second run of this one, is still denied.`);
	}
	return lines;
}

/** System instructions: the worker prompt, what differs when the runner drives it, and the ticket. */
export function workerInstructions(worker: Worker, brief: TicketBrief): string {
	const lines = [
		worker.systemPrompt,
		"",
		"## Runner mode",
		"You are driven by the unattended brigadev runner, one ticket per conversation, with no one to answer questions during a run.",
		"You never pick a product or design option yourself, not even a reversible one: call `ask_user_choice` (a focused question, 2-6 options, your recommendation). That ends your attempt without a failure; the ticket parks until the user answers and then runs again with the answer in this brief.",
		"Differences from the interactive workflow above: you MUST commit your finished work with `git commit` on the current branch (the runner proves the ticket by running the done command and checking that HEAD moved); there are no skills or sub-agents to load.",
		"Run the project's tests with the `check` tool, not with bash: `check` records the run as evidence. Run `check` before you commit so the commit holds tested work; the runner runs the full suite again before it pushes.",
		"The runner delivers: `git push`, merges, publishing, and `gh pr`/`gh release` commands are always blocked. A command blocked with `needs you:` is one only a person may approve (a destructive command, a dependency change, a commit off a feature branch): do not retry it; continue without it. If the ticket cannot be done without that command, call `ask_user_choice` with `command` set to the exact command string and an option whose label starts with `Approve`.",
		"Your file tools reach only this worktree; the feature document and the evidence log are the runner's and read-only to you.",
		"",
		"## Ticket",
		`- id: ${brief.ticketId}`,
		`- title: ${brief.title || "(none)"}`,
		`- linked specs: ${brief.specs.length > 0 ? brief.specs.join(", ") : "none"}`,
		`- done command: \`${brief.done}\``,
		`- feature document: ${brief.docPath}`,
		`- attempt: ${brief.attempt} of ${brief.maxAttempts}`,
	];
	if (brief.spec) lines.push("", "## Spec", brief.spec);
	if (brief.decision) lines.push("", ...decisionSection(brief.decision));
	if (brief.failure) lines.push("", "## Previous attempt failed", brief.failure);
	return lines.join("\n");
}

/** The input that starts the worker's run. */
export function workerInput(brief: TicketBrief): string {
	return `Implement ticket ${brief.ticketId}${brief.title ? `: ${brief.title}` : ""}. It is finished when \`${brief.done}\` exits 0 and your work is committed.`;
}
