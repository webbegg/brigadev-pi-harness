// /brigadev:stats: what a session (or many) cost and where it went, measured
// from Pi's own session logs plus the evidence logs. Pure over parsed
// entries; only `sessionFiles` and `readEvidenceDir` touch the disk.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { formatCost, formatTokens } from "./cost.ts";
import type { EvidenceRecord } from "./evidence.ts";
import { OUTCOMES, type Outcome } from "./retro.ts";
import { runStatus } from "./run-status.ts";

/** A turn whose context (input + cacheRead + cacheWrite) is above this is "large". */
export const LARGE_CONTEXT = 200_000;
/** A cache rebuild writes more than this and reads back less than REBUILD_READ_RATIO of the previous turn's context. */
export const REBUILD_WRITE = 30_000;
export const REBUILD_READ_RATIO = 0.7;
/** An idle gap longer than this outlives the prompt cache. */
export const IDLE_GAP_MS = 60 * 60_000;
/** Evidence written right after the last log entry still belongs to the session. */
const EVIDENCE_TAIL_MS = 5 * 60_000;
const TOP_TOOLS = 10;
const TOP_SESSIONS = 10;
const GATE_BLOCK = "Blocked by brigadev evidence gate";

export const PHASES = ["explore", "implement", "verify", "deliver", "delegate", "poll", "coordinate", "text-only", "other"] as const;
export type Phase = (typeof PHASES)[number];

export interface SessionLog {
	id: string;
	entries: unknown[];
}

export interface PhaseTotal {
	turns: number;
	cost: number;
}

export interface Stats {
	sessions: number;
	sessionRows: Array<{ id: string; start: string; turns: number; cost: number }>;
	turns: number;
	userMessages: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cacheHitRate: number | undefined;
	context: { p50: number; p75: number; p90: number; max: number } | undefined;
	turnsOver200k: number;
	costShareOver200k: number;
	rebuilds: { count: number; cost: number; afterGap: number };
	phases: Record<Phase, PhaseTotal>;
	tools: Array<[string, number]>;
	blocks: number;
	/** Undefined when no session was selected. */
	evidence: { pass: number; fail: number; unknown: number; forces: number } | undefined;
	/** The `Outcome:` of every closing message, overall and per workflow the request started from (sorted by name). */
	outcomes: { counts: Record<Outcome, number>; byWorkflow: Array<{ workflow: string; counts: Record<Outcome, number> }> };
	/** Subagent runs that failed or ended without a result, per agent (most first). */
	failedRuns: Array<[string, number]>;
}

export interface StatsOptions {
	/** Workflow request line ("Bug fix request") to the workflow's name (`readWorkflowNames`). */
	workflows?: ReadonlyMap<string, string>;
}

export function parseJsonl(text: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed);
		} catch {
			// A torn line must not hide the rest of the log.
		}
	}
	return entries;
}

/** Nearest-rank percentile of `values`; undefined when empty. */
export function percentile(values: number[], p: number): number | undefined {
	if (values.length === 0) return undefined;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length))) - 1];
}

// --- phases ---

const PHASE_PRIORITY: Phase[] = ["poll", "deliver", "delegate", "implement", "verify", "coordinate", "explore", "other"];
const SEGMENT_SPLIT = /&&|\|\||[;|\n]/;
const READ_WORDS = new Set(["cat", "sed", "head", "tail", "rg", "grep", "find", "ls", "fd", "wc", "sort", "uniq", "cut", "tr", "nl", "cd", "pwd", "true", "echo"]);
const READ_GIT = new Set(["status", "diff", "log", "show"]);
const VERIFY = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|build|lint|typecheck|check)\b|\bnode\b[^|;&]*--test\b|\b(pytest|vitest|jest|tsc|mocha|rspec|phpunit|eslint)\b|\bcargo\s+(test|build|check|clippy)\b|\bgo\s+(test|build|vet)\b|\bmake(\s|$)|\b(mvn|gradle|gradlew)\b|\bdotnet\s+(test|build)\b/;

/** Words of one command segment without leading `VAR=value` assignments. */
function words(segment: string): string[] {
	const all = segment.trim().split(/\s+/).filter(Boolean);
	let i = 0;
	while (i < all.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(all[i])) i++;
	return all.slice(i);
}

/** The git subcommand, skipping `-C <dir>` and other leading options. */
function gitSubcommand(args: string[]): string | undefined {
	for (let i = 1; i < args.length; i++) {
		if (args[i] === "-C" || args[i] === "-c") i++;
		else if (!args[i].startsWith("-")) return args[i];
	}
	return undefined;
}

function segmentPhase(segment: string): Phase {
	const args = words(segment);
	const first = args[0];
	if (!first) return "explore";
	const sub = first === "git" ? gitSubcommand(args) : undefined;
	if (sub === "commit" || sub === "push" || first === "gh" || /(^|\/)release(\.\w+)?$/.test(first)) return "deliver";
	if (/^(npm|pnpm|yarn)$/.test(first) && /^(run\s+)?(release|publish)\b/.test(args.slice(1).join(" "))) return "deliver";
	if (VERIFY.test(segment)) return "verify";
	if (first === "sed" && args.some((a) => /^-[a-z]*i/.test(a))) return "other";
	if (/(^|[^>0-9&])>(?!&)/.test(segment)) return "other";
	if (READ_WORDS.has(first) || (first === "git" && sub !== undefined && READ_GIT.has(sub))) return "explore";
	return "other";
}

/** A segment that waits: `sleep` or `gh run watch` as the command word (text that merely mentions sleep does not). */
function isPollSegment(segment: string): boolean {
	const args = words(segment);
	const first = (args[0] ?? "").replace(/^.*\//, "");
	return first === "sleep" || (first === "gh" && args[1] === "run" && args[2] === "watch");
}

/** Phase of one bash command: poll if a segment sleeps or watches a run, else deliver, verify, explore (every segment read-like), other. */
export function classifyBash(command: string): Phase {
	const segments = command.split(SEGMENT_SPLIT).filter((s) => s.trim());
	if (segments.some(isPollSegment)) return "poll";
	const phases = segments.map(segmentPhase);
	if (phases.length === 0) return "other";
	for (const phase of ["deliver", "verify"] as const) if (phases.includes(phase)) return phase;
	return phases.every((p) => p === "explore") ? "explore" : "other";
}

function toolPhase(call: ToolCall): Phase {
	switch (call.name) {
		case "read":
		case "grep":
		case "find":
		case "ls":
		case "fd":
		case "rg":
			return "explore";
		case "edit":
		case "write":
			return "implement";
		case "check":
			return "verify";
		case "subagent":
			return "delegate";
		case "todo":
		case "ask_user_choice":
			return "coordinate";
		case "bash": {
			const command = call.arguments?.command;
			return typeof command === "string" ? classifyBash(command) : "other";
		}
		default:
			return "other";
	}
}

export interface ToolCall {
	name: string;
	arguments?: Record<string, unknown>;
}

/** Phase of an assistant turn from its tool calls; no tool call is text-only. */
export function classifyTurn(calls: ToolCall[]): Phase {
	if (calls.length === 0) return "text-only";
	const phases = new Set(calls.map(toolPhase));
	return PHASE_PRIORITY.find((p) => phases.has(p)) ?? "other";
}

// --- outcomes ---

/** The close line `Outcome: <word>`, plain or in markdown (`**Outcome:** blocked`); the vocabulary in parentheses does not match. */
const OUTCOME_LINE = /\boutcome:[*_`\s]*(success|flawed|blocked|manual)\b/gi;
/** The first line of a request composed by the workflow menu (lib/workflow-run.ts, the workflow body's first line). */
const WORKFLOW_REQUEST = /^(.+? request), started from the workflow menu\./;

/** The last outcome a message states, or undefined. */
export function lastOutcome(text: string): Outcome | undefined {
	let last: Outcome | undefined;
	for (const match of text.matchAll(OUTCOME_LINE)) last = match[1].toLowerCase() as Outcome;
	return last;
}

/** Request line ("Bug fix request") to workflow name ("Bug fix") from workflow files' contents; a later file wins. */
export function workflowNames(contents: readonly string[]): Map<string, string> {
	const names = new Map<string, string>();
	for (const content of contents) {
		const parts = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
		const name = parts && /^name:\s*(.+?)\s*$/m.exec(parts[1])?.[1].replace(/^(["'])(.*)\1$/, "$2");
		const marker = parts && WORKFLOW_REQUEST.exec(parts[2].trimStart())?.[1];
		if (name && marker) names.set(marker, name);
	}
	return names;
}

/** `workflowNames` of every `*.md` in the folders, in order (package, user, repo: overrides last). */
export function readWorkflowNames(dirs: readonly string[]): Map<string, string> {
	const contents: string[] = [];
	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		for (const name of readdirSync(dir).sort()) {
			if (!name.endsWith(".md")) continue;
			try {
				contents.push(readFileSync(join(dir, name), "utf8"));
			} catch {
				// One unreadable file does not hide the rest.
			}
		}
	}
	return workflowNames(contents);
}

/** The workflow a user message was started from, by name when its file is known, else from its request line. */
function requestWorkflow(text: string, names: ReadonlyMap<string, string>): string | undefined {
	const marker = WORKFLOW_REQUEST.exec(text.trimStart())?.[1];
	return marker && (names.get(marker) ?? marker.replace(/ request$/, ""));
}

const emptyOutcomes = (): Record<Outcome, number> => Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<Outcome, number>;

/** Agents of the subagent runs in one `subagent` tool result that failed, or finished with neither a structured result nor final text. */
function failedRunAgents(details: unknown): string[] {
	const results = record(details)?.results;
	if (!Array.isArray(results)) return [];
	return results.flatMap((item) => {
		const r = record(item);
		if (!r || typeof r.agent !== "string" || typeof r.exitCode !== "number") return [];
		const status = runStatus(r as Parameters<typeof runStatus>[0]);
		if (status === "failed") return [r.agent];
		// Without the messages there is no telling whether it answered.
		if (status !== "done" || r.structured !== undefined || !Array.isArray(r.messages)) return [];
		const answered = r.messages.some((m) => record(m)?.role === "assistant" && textOf(record(m)?.content).trim() !== "");
		return answered ? [] : [r.agent];
	});
}

// --- stats ---

interface Turn {
	time: number | undefined;
	context: number;
	cost: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	calls: ToolCall[];
}

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const record = (value: unknown): Record<string, unknown> | undefined => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined);

function entryTime(entry: Record<string, unknown>): number | undefined {
	const parsed = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content.map((block) => (typeof record(block)?.text === "string" ? (record(block)?.text as string) : "")).join("\n");
}

function toTurn(entry: Record<string, unknown>, message: Record<string, unknown>): Turn | undefined {
	const usage = record(message.usage);
	if (!usage) return undefined;
	const input = num(usage.input);
	const cacheRead = num(usage.cacheRead);
	const cacheWrite = num(usage.cacheWrite);
	const context = input + cacheRead + cacheWrite;
	const output = num(usage.output);
	if (context + output === 0) return undefined; // an aborted or failed request that never reached the model
	const calls: ToolCall[] = [];
	if (Array.isArray(message.content)) {
		for (const block of message.content) {
			const b = record(block);
			if (b?.type === "toolCall" && typeof b.name === "string") calls.push({ name: b.name, arguments: record(b.arguments) });
		}
	}
	return { time: entryTime(entry), context, cost: num(record(usage.cost)?.total), input, output, cacheRead, cacheWrite, calls };
}

const emptyPhases = (): Record<Phase, PhaseTotal> => Object.fromEntries(PHASES.map((p) => [p, { turns: 0, cost: 0 }])) as Record<Phase, PhaseTotal>;

export function computeStats(sessions: SessionLog[], evidence: EvidenceRecord[], options: StatsOptions = {}): Stats {
	const stats: Stats = {
		sessions: sessions.length,
		sessionRows: [],
		turns: 0,
		userMessages: 0,
		cost: 0,
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cacheHitRate: undefined,
		context: undefined,
		turnsOver200k: 0,
		costShareOver200k: 0,
		rebuilds: { count: 0, cost: 0, afterGap: 0 },
		phases: emptyPhases(),
		tools: [],
		blocks: 0,
		evidence: undefined,
		outcomes: { counts: emptyOutcomes(), byWorkflow: [] },
		failedRuns: [],
	};
	const workflowNamesMap = options.workflows ?? new Map<string, string>();
	const byWorkflow = new Map<string, Record<Outcome, number>>();
	const failedRuns = new Map<string, number>();
	const contexts: number[] = [];
	const toolCounts = new Map<string, number>();
	let largeCost = 0;
	let first = Number.POSITIVE_INFINITY;
	let last = Number.NEGATIVE_INFINITY;

	for (const session of sessions) {
		let previous: Turn | undefined;
		// The workflow of the latest request started from the menu; outcomes after it count for it.
		let workflow: string | undefined;
		const row = { id: session.id, start: "", turns: 0, cost: 0 };
		for (const raw of session.entries) {
			const entry = record(raw);
			if (!entry) continue;
			if (entry.type === "session" && typeof entry.id === "string") row.id = entry.id;
			const time = entryTime(entry);
			if (time !== undefined) {
				first = Math.min(first, time);
				last = Math.max(last, time);
				if (!row.start || new Date(time).toISOString() < row.start) row.start = new Date(time).toISOString();
			}
			const message = entry.type === "message" ? record(entry.message) : undefined;
			if (!message) continue;
			if (message.role === "user") {
				stats.userMessages++;
				workflow = requestWorkflow(textOf(message.content), workflowNamesMap) ?? workflow;
			} else if (message.role === "toolResult") {
				if (textOf(message.content).includes(GATE_BLOCK)) stats.blocks++;
				if (message.toolName === "subagent") for (const agent of failedRunAgents(message.details)) failedRuns.set(agent, (failedRuns.get(agent) ?? 0) + 1);
			} else if (message.role === "assistant") {
				const turn = toTurn(entry, message);
				if (!turn) continue;
				stats.turns++;
				row.turns++;
				row.cost += turn.cost;
				stats.cost += turn.cost;
				stats.input += turn.input;
				stats.output += turn.output;
				stats.cacheRead += turn.cacheRead;
				stats.cacheWrite += turn.cacheWrite;
				contexts.push(turn.context);
				if (turn.context > LARGE_CONTEXT) {
					stats.turnsOver200k++;
					largeCost += turn.cost;
				}
				if (previous && turn.cacheWrite > REBUILD_WRITE && turn.cacheRead < REBUILD_READ_RATIO * previous.context) {
					stats.rebuilds.count++;
					stats.rebuilds.cost += turn.cost;
					if (turn.time !== undefined && previous.time !== undefined && turn.time - previous.time > IDLE_GAP_MS) stats.rebuilds.afterGap++;
				}
				const phase = classifyTurn(turn.calls);
				stats.phases[phase].turns++;
				stats.phases[phase].cost += turn.cost;
				for (const call of turn.calls) toolCounts.set(call.name, (toolCounts.get(call.name) ?? 0) + 1);
				// A message without tool calls closes the turn: the parent's final text, where the close line sits.
				const outcome = turn.calls.length === 0 ? lastOutcome(textOf(message.content)) : undefined;
				if (outcome) {
					stats.outcomes.counts[outcome]++;
					if (workflow !== undefined) {
						const counts = byWorkflow.get(workflow) ?? emptyOutcomes();
						counts[outcome]++;
						byWorkflow.set(workflow, counts);
					}
				}
				previous = turn;
			}
		}
		stats.sessionRows.push(row);
	}

	const prompt = stats.input + stats.cacheRead + stats.cacheWrite;
	stats.cacheHitRate = prompt > 0 ? stats.cacheRead / prompt : undefined;
	if (contexts.length > 0) {
		stats.context = { p50: percentile(contexts, 50)!, p75: percentile(contexts, 75)!, p90: percentile(contexts, 90)!, max: Math.max(...contexts) };
	}
	stats.costShareOver200k = stats.cost > 0 ? largeCost / stats.cost : 0;
	stats.tools = [...toolCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, TOP_TOOLS);
	stats.outcomes.byWorkflow = [...byWorkflow].sort((a, b) => a[0].localeCompare(b[0])).map(([name, counts]) => ({ workflow: name, counts }));
	stats.failedRuns = [...failedRuns].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	if (sessions.length > 0) stats.evidence = summarizeEvidence(evidence, first, last + EVIDENCE_TAIL_MS);
	return stats;
}

function summarizeEvidence(records: EvidenceRecord[], from: number, to: number): NonNullable<Stats["evidence"]> {
	const out = { pass: 0, fail: 0, unknown: 0, forces: 0 };
	// Sessions without a single timestamp have no window to match records against: count none, not all.
	if (!Number.isFinite(from) || !Number.isFinite(to)) return out;
	for (const r of records) {
		const at = Date.parse(r.ts);
		if (Number.isFinite(at) && (at < from || at > to)) continue;
		if (r.type === "force") out.forces++;
		else if (r.outcome === "pass" || r.outcome === "fail" || r.outcome === "unknown") out[r.outcome]++;
	}
	return out;
}

// --- rendering ---

const pct = (ratio: number) => `${Math.round(ratio * 100)}%`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The report as plain lines. `scope` says which sessions were measured. */
export function renderStats(stats: Stats, scope: string): string[] {
	const lines = [`Stats: ${scope}`];
	if (stats.sessions === 0) return [...lines, "No sessions found."];
	lines.push(`${plural(stats.sessions, "session")} · ${plural(stats.turns, "assistant turn")} · ${plural(stats.userMessages, "user message")} · ${formatCost(stats.cost)}`);
	lines.push(`tokens  input ${formatTokens(stats.input)} · cacheRead ${formatTokens(stats.cacheRead)} · cacheWrite ${formatTokens(stats.cacheWrite)} · output ${formatTokens(stats.output)}${stats.cacheHitRate === undefined ? "" : ` · cache hit ${pct(stats.cacheHitRate)}`}`);
	if (stats.context) {
		const c = stats.context;
		lines.push(`context/turn  p50 ${formatTokens(c.p50)}  p75 ${formatTokens(c.p75)}  p90 ${formatTokens(c.p90)}  max ${formatTokens(c.max)}`);
		lines.push(`  turns >200k: ${stats.turnsOver200k} (${pct(stats.costShareOver200k)} of cost)`);
	}
	lines.push(`cache rebuilds (cacheWrite >30k and cacheRead <70% of the previous context)`);
	lines.push(`  rebuilds: ${plural(stats.rebuilds.count, "turn")} · ${formatCost(stats.rebuilds.cost)} · ${stats.rebuilds.afterGap} after a gap >60 min`);
	lines.push("cost by phase");
	for (const phase of PHASES) {
		const total = stats.phases[phase];
		if (total.turns === 0 && phase === "other") continue;
		lines.push(`  ${phase.padEnd(11)} ${String(total.turns).padStart(4)} turns · ${formatCost(total.cost)} · ${pct(stats.cost > 0 ? total.cost / stats.cost : 0)}`);
	}
	if (stats.tools.length > 0) {
		lines.push("top tools");
		lines.push(`  ${stats.tools.map(([name, count]) => `${name} ×${count}`).join(" · ")}`);
	}
	if (stats.evidence) {
		const e = stats.evidence;
		lines.push("evidence");
		lines.push(`  runs: ${e.pass} pass · ${e.fail} fail · ${e.unknown} unknown · forces ${e.forces} · blocks ${stats.blocks}`);
	}
	const closed = OUTCOMES.reduce((sum, o) => sum + stats.outcomes.counts[o], 0);
	if (closed > 0) {
		lines.push("outcomes");
		lines.push(`  ${closed} closed · ${OUTCOMES.map((o) => `${o} ${stats.outcomes.counts[o]} (${pct(stats.outcomes.counts[o] / closed)})`).join(" · ")}`);
		for (const { workflow, counts } of stats.outcomes.byWorkflow) {
			lines.push(`  ${workflow}: ${OUTCOMES.filter((o) => counts[o] > 0).map((o) => `${o} ${counts[o]}`).join(" · ")}`);
		}
	}
	if (stats.failedRuns.length > 0) {
		lines.push("subagent runs failed or without a result");
		lines.push(`  ${stats.failedRuns.map(([agent, count]) => `${agent} ×${count}`).join(" · ")}`);
	}
	if (stats.sessionRows.length > 1) {
		lines.push(`sessions (top ${Math.min(TOP_SESSIONS, stats.sessionRows.length)} by cost)`);
		for (const row of [...stats.sessionRows].sort((a, b) => b.cost - a.cost).slice(0, TOP_SESSIONS)) {
			lines.push(`  ${row.id.slice(0, 8)} ${row.start.slice(0, 10)} ${String(row.turns).padStart(4)} turns · ${formatCost(row.cost)}`);
		}
	}
	return lines;
}

// --- disk ---

/** Session log files in `dir`, newest activity irrelevant; with `days`, only those modified in the last N days. */
export function sessionFiles(dir: string, days?: number, now: number = Date.now()): string[] {
	if (!existsSync(dir)) return [];
	const cutoff = days === undefined ? Number.NEGATIVE_INFINITY : now - days * 86_400_000;
	const files: string[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		const file = join(dir, name);
		try {
			const info = statSync(file);
			if (info.isFile() && info.mtimeMs >= cutoff) files.push(file);
		} catch {
			// Removed between listing and stat.
		}
	}
	return files.sort();
}

export function readSessionFile(file: string): SessionLog | undefined {
	try {
		return { id: file, entries: parseJsonl(readFileSync(file, "utf8")) };
	} catch {
		return undefined;
	}
}

/** Every record of every `evidence/*.jsonl` log under a repository docs folder. */
export function readEvidenceDir(docsDir: string): EvidenceRecord[] {
	const dir = join(docsDir, "evidence");
	if (!existsSync(dir)) return [];
	const records: EvidenceRecord[] = [];
	for (const name of readdirSync(dir)) {
		if (!name.endsWith(".jsonl")) continue;
		let text: string;
		try {
			text = readFileSync(join(dir, name), "utf8");
		} catch {
			continue; // One unreadable log does not hide the rest.
		}
		for (const parsed of parseJsonl(text)) {
			const r = parsed as { v?: unknown; type?: unknown };
			if (r.v === 1 && (r.type === "run" || r.type === "force")) records.push(parsed as EvidenceRecord);
		}
	}
	return records;
}
