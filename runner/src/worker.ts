// The worker conversation's instructions: `assets/agents/brigadev-worker.md` (via lib/agents.ts) plus the ticket.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseAgent, type FrontmatterParser } from "../../lib/agents.ts";

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
	/** The previous attempt's failure, with the tail of the check output. */
	failure?: string;
}

/** System instructions: the worker prompt, what differs when the runner drives it, and the ticket. */
export function workerInstructions(worker: Worker, brief: TicketBrief): string {
	const lines = [
		worker.systemPrompt,
		"",
		"## Runner mode",
		"You are driven by the unattended brigadev runner, one ticket per conversation, with no one to answer questions.",
		"Differences from the interactive workflow above: you MUST commit your finished work with `git commit` on the current branch (the runner proves the ticket by running the done command and checking that HEAD moved); there are no skills or sub-agents to load.",
		"",
		"## Ticket",
		`- id: ${brief.ticketId}`,
		`- title: ${brief.title || "(none)"}`,
		`- linked specs: ${brief.specs.length > 0 ? brief.specs.join(", ") : "none"}`,
		`- done command: \`${brief.done}\``,
		`- feature document: ${brief.docPath}`,
		`- attempt: ${brief.attempt} of ${brief.maxAttempts}`,
	];
	if (brief.failure) lines.push("", "## Previous attempt failed", brief.failure);
	return lines.join("\n");
}

/** The input that starts the worker's run. */
export function workerInput(brief: TicketBrief): string {
	return `Implement ticket ${brief.ticketId}${brief.title ? `: ${brief.title}` : ""}. It is finished when \`${brief.done}\` exits 0 and your work is committed.`;
}
