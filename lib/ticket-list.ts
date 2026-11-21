// The feature document's `## Tasks` list as data: parse, validate before an unattended run, pick ready tickets, and write
// results back without overwriting the user's edits. Pi-free, so the extension and a headless runner share it.
//
// Ticket line: `- T3 [S1,S2] <route>: <title> deps: T1, T2 done: `<check>` — <status> <note>`.
// `deps:` and `done:` are optional when parsing (older documents have neither); a run requires `done:` on unfinished tickets.
import { randomBytes } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const TICKET_STATUSES = ["pending", "in_progress", "done", "blocked", "dropped"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

export interface Ticket {
	id: string;
	/** Linked spec IDs, ranges expanded (`S1–S3` → S1, S2, S3); `all` links every spec. */
	specs: string[];
	/** Route and title: the text between the spec list and `deps:`/`done:`. */
	title: string;
	deps: string[];
	/** The check that proves the ticket is finished: a command (backticks removed) or an observable outcome. */
	done?: string;
	/** True when the `done:` value was wrapped in backticks, so a runner that only runs commands can execute it. */
	doneIsCommand: boolean;
	status?: TicketStatus;
	/** Text after the status word: commit, evidence, or why it is blocked. */
	note: string;
	/** The whole line as written; ownership checks compare it. */
	raw: string;
}

export interface TicketList {
	tickets: Ticket[];
}

const TICKET_LINE = /^- (T\d+[A-Za-z0-9.]*) \[([^\]]*)\]\s*(.*)$/;
const STATUS_TAIL = new RegExp(`^(.*) — (${TICKET_STATUSES.join("|")})(?:(?=[\\s;:,.(])(.*))?$`);
const SPEC_LINE = /^- (S\d+[a-z]?):/;

function sectionRange(lines: string[], heading: string): { start: number; end: number } | undefined {
	const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
	if (start === -1) return undefined;
	let end = start + 1;
	while (end < lines.length && !/^#{1,2} /.test(lines[end])) end += 1;
	return { start: start + 1, end };
}

function expandSpecs(field: string): string[] {
	const specs: string[] = [];
	for (const token of field.split(/[,\s]+/).filter(Boolean)) {
		const range = /^S(\d+)[–-]S?(\d+)$/.exec(token);
		if (range) for (let n = Number(range[1]); n <= Number(range[2]); n += 1) specs.push(`S${n}`);
		else specs.push(token);
	}
	return specs;
}

function unquote(value: string): string {
	const trimmed = value.trim();
	return trimmed.length > 1 && trimmed.startsWith("`") && trimmed.endsWith("`") ? trimmed.slice(1, -1) : trimmed;
}

function splitStatus(rest: string): { body: string; status?: TicketStatus; note: string } {
	// A leading space lets a title-less line (`- T10 [S12] — done x`) match the ` — ` separator too.
	const match = STATUS_TAIL.exec(` ${rest}`);
	if (!match) return { body: rest.trim(), note: "" };
	return { body: match[1].trim(), status: match[2] as TicketStatus, note: (match[3] ?? "").replace(/^[;:,.]?\s*/, "").trim() };
}

function parseLine(raw: string): Ticket | undefined {
	const match = TICKET_LINE.exec(raw);
	if (!match) return undefined;
	const { body, status, note } = splitStatus(match[3]);
	let head = ` ${body}`;
	let done: string | undefined;
	let doneIsCommand = false;
	const doneAt = head.lastIndexOf(" done: ");
	if (doneAt !== -1) {
		const value = head.slice(doneAt + " done: ".length);
		done = unquote(value);
		doneIsCommand = done !== "" && done !== value.trim();
		head = head.slice(0, doneAt);
	}
	let deps: string[] = [];
	const depsAt = head.lastIndexOf(" deps: ");
	if (depsAt !== -1) {
		const field = head.slice(depsAt + " deps: ".length).trim();
		deps = field === "none" ? [] : field.split(/[,\s]+/).filter(Boolean);
		head = head.slice(0, depsAt);
	}
	return { id: match[1], specs: expandSpecs(match[2]), title: head.trim(), deps, done, doneIsCommand, status, note, raw };
}

export function parseTicketList(markdown: string): TicketList {
	const lines = markdown.split("\n");
	const range = sectionRange(lines, "Tasks");
	if (!range) return { tickets: [] };
	const tickets: Ticket[] = [];
	for (let i = range.start; i < range.end; i += 1) {
		const ticket = parseLine(lines[i]);
		if (ticket) tickets.push(ticket);
	}
	return { tickets };
}

const FINISHED: ReadonlySet<TicketStatus | undefined> = new Set<TicketStatus | undefined>(["done", "dropped"]);

/** Reasons the list cannot run unattended; empty when it can. */
export function validateForRun(list: TicketList): string[] {
	if (list.tickets.length === 0) return ["no tickets under ## Tasks"];
	const errors: string[] = [];
	const byId = new Map<string, Ticket>();
	for (const ticket of list.tickets) {
		if (byId.has(ticket.id)) {
			if (!errors.includes(`${ticket.id} appears twice`)) errors.push(`${ticket.id} appears twice`);
		} else byId.set(ticket.id, ticket);
	}
	for (const ticket of list.tickets) {
		if (ticket.status === undefined) errors.push(`${ticket.id} has no status`);
		if (!FINISHED.has(ticket.status) && !ticket.done) errors.push(`${ticket.id} has no done: check`);
		for (const dep of ticket.deps) if (!byId.has(dep)) errors.push(`${ticket.id} depends on unknown ${dep}`);
	}
	errors.push(...dependencyCycles(byId));
	return errors;
}

function dependencyCycles(byId: Map<string, Ticket>): string[] {
	const cycles: string[] = [];
	const seen = new Set<string>();
	const state = new Map<string, "visiting" | "done">();
	const visit = (id: string, path: string[]) => {
		if (state.get(id) === "done") return;
		if (state.get(id) === "visiting") {
			const cycle = [...path.slice(path.indexOf(id)), id];
			const key = [...new Set(cycle)].sort().join(",");
			if (!seen.has(key)) {
				seen.add(key);
				cycles.push(`dependency cycle: ${cycle.join(" → ")}`);
			}
			return;
		}
		state.set(id, "visiting");
		for (const dep of byId.get(id)?.deps ?? []) if (byId.has(dep)) visit(dep, [...path, id]);
		state.set(id, "done");
	};
	for (const id of byId.keys()) visit(id, []);
	return cycles;
}

/** Pending tickets whose dependencies are all done, in document order. Blocked or dropped dependencies do not count. */
export function readyTickets(list: TicketList): Ticket[] {
	const status = new Map<string, TicketStatus | undefined>();
	for (const ticket of list.tickets) if (!status.has(ticket.id)) status.set(ticket.id, ticket.status);
	return list.tickets.filter((ticket) => ticket.status === "pending" && ticket.deps.every((dep) => status.get(dep) === "done"));
}

export function ticketsLinkedTo(list: TicketList, specIds: readonly string[]): Ticket[] {
	if (specIds.length === 0) return [];
	return list.tickets.filter((ticket) => ticket.specs.includes("all") || ticket.specs.some((spec) => specIds.includes(spec)));
}

/** Replace one ticket's status and note, leaving every other byte of the document as it was. */
export function setTicketStatus(markdown: string, id: string, status: TicketStatus, note: string): string {
	const lines = markdown.split("\n");
	const range = sectionRange(lines, "Tasks");
	const index = range ? lines.findIndex((line, i) => i >= range.start && i < range.end && parseLine(line)?.id === id) : -1;
	if (index === -1) throw new Error(`ticket ${id} is not in ## Tasks`);
	const match = TICKET_LINE.exec(lines[index])!;
	const { body } = splitStatus(match[3]);
	const prefix = `- ${match[1]} [${match[2]}]${body ? ` ${body}` : ""}`;
	lines[index] = `${prefix} — ${status}${note ? ` ${note}` : ""}`;
	return lines.join("\n");
}

/** Append `- L<n> (<date>): <text>` after the last entry of `## Log`, numbering after the highest existing L. */
export function appendLogLine(markdown: string, date: string, text: string): string {
	const lines = markdown.split("\n");
	const range = sectionRange(lines, "Log");
	if (!range) throw new Error("the document has no ## Log section");
	let last = range.start - 1;
	let highest = 0;
	for (let i = range.start; i < range.end; i += 1) {
		if (lines[i].trim() !== "") last = i;
		const number = /^- L(\d+)\b/.exec(lines[i]);
		if (number) highest = Math.max(highest, Number(number[1]));
	}
	lines.splice(last + 1, 0, `- L${highest + 1} (${date}): ${text}`);
	return lines.join("\n");
}

/** Runner-owned tickets whose line no longer reads as the runner last saw it (edited or removed). */
export function ownedLineConflicts(markdown: string, owned: Readonly<Record<string, string>>): string[] {
	const current = new Map<string, string>();
	for (const ticket of parseTicketList(markdown).tickets) if (!current.has(ticket.id)) current.set(ticket.id, ticket.raw);
	return Object.keys(owned).filter((id) => current.get(id) !== owned[id]);
}

function specLines(markdown: string): Map<string, string> {
	const lines = markdown.split("\n");
	const specs = new Map<string, string>();
	const range = sectionRange(lines, "Specs");
	if (!range) return specs;
	for (let i = range.start; i < range.end; i += 1) {
		const id = SPEC_LINE.exec(lines[i])?.[1];
		if (id) specs.set(id, lines[i]);
	}
	return specs;
}

/** Spec IDs edited, added, or removed between two versions of the document, in numeric order. */
export function changedSpecs(before: string, after: string): string[] {
	const a = specLines(before);
	const b = specLines(after);
	const ids = new Set([...a.keys(), ...b.keys()]);
	return [...ids].filter((id) => a.get(id) !== b.get(id)).sort((x, y) => Number.parseInt(x.slice(1), 10) - Number.parseInt(y.slice(1), 10) || x.localeCompare(y));
}

export interface AtomicWriteIo {
	write?: (path: string, text: string) => void;
	rename?: (from: string, to: string) => void;
}

/** Write through a temp file in the same directory and rename it over the target, so a crash leaves the old file whole. */
export function writeFileAtomic(path: string, text: string, io: AtomicWriteIo = {}): void {
	const write = io.write ?? ((file: string, content: string) => writeFileSync(file, content, "utf8"));
	const rename = io.rename ?? renameSync;
	const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
	try {
		write(temp, text);
		rename(temp, path);
	} catch (error) {
		rmSync(temp, { force: true });
		throw error;
	}
}
