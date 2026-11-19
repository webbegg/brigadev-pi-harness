// What the parent reads of a subagent result: a compact form (target <= ~8,000 chars, ~2k tokens) that
// ends with the path of the full result. The full text and the structured payload stay in the run folder
// (lib/run-artifacts.ts) and in the tool details, so nothing is lost; only the parent's carried context shrinks.
//
// A verify or review result is never cut by position: it starts with a status line, then everything that blocks
// (blockers, unmet and unverified verdicts, BLOCKER/CRITICAL findings) in an order that keeps it first, and only the
// tail sections (advisories, regression tests, unverified checks, scratch) give way to the size target.
// Pure: no I/O, no Pi imports.

/** Target size of one task's compact result. */
export const COMPACT_MAX_CHARS = 8000;

/** Per-item caps: the normal ones, and the tighter ones used when the blocking part alone is over the target. */
const CAPS = [
	{ evidence: 600, repro: 800, finding: 600 },
	{ evidence: 240, repro: 300, finding: 240 },
] as const;
type Caps = (typeof CAPS)[number];
const ADVISORY_SUMMARY_CHARS = 240;
const ADVISORY_REPRO_CHARS = 160;
const UNVERIFIED_ITEM_CHARS = 300;
const WARNING_CLAIM_CHARS = 400;
const WARNING_EVIDENCE_CHARS = 240;
const WARNING_MAX = 10;
const REVIEWED_CHARS = 600;
/** Room kept for the omission marker. */
const MARKER_CHARS = 260;
const BLOCKING_VERDICTS = new Set(["unmet", "not implemented"]);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string => (typeof v === "string" ? v : v === undefined || v === null ? "" : JSON.stringify(v));

/** First non-empty line, cut to `max` chars. */
function firstLine(text: string, max: number): string {
	const line = text.split("\n").find((l) => l.trim()) ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line.trim();
}

/** Text over `max` chars becomes its head and its tail around an omitted marker (about `max` chars in all). */
export function compactText(text: string, max: number = COMPACT_MAX_CHARS): string {
	if (text.length <= max) return text;
	const head = Math.ceil(max * 0.6);
	const tail = Math.floor(max * 0.4) - 40;
	const omitted = text.length - head - tail;
	return `${text.slice(0, head)}\n\n[... ${omitted.toLocaleString("en-US")} chars omitted ...]\n\n${text.slice(text.length - tail)}`;
}

const indent = (text: string) => text.replace(/\n/g, "\n  ");

/** The lines of the first status part that applies, e.g. `Status: BLOCKERS (2) | UNMET (1)`, or `Status: CLEAN` when none does. */
function statusLine(parts: Array<[string, number]>): string {
	const shown = parts.filter(([, count]) => count > 0).map(([label, count]) => `${label} (${count})`);
	return `Status: ${shown.length ? shown.join(" | ") : "CLEAN"}`;
}

/** A section of the tail: the items that fit the budget are kept in order; the rest are only counted. */
interface TailSection {
	title: string;
	items: string[];
	/** `Title:` heads a list (`Scratch: a, b` is one line when joined). */
	joined?: boolean;
}

/** The sections that fit `budget` chars, and a marker naming what was left out. */
function fitTail(sections: TailSection[], budget: number, fullResult: string): string[] {
	const out: string[] = [];
	const omitted: Array<[string, number]> = [];
	let left = Math.max(0, budget - MARKER_CHARS);
	for (const section of sections) {
		if (section.items.length === 0) continue;
		const heading = section.joined ? `${section.title}: ` : `${section.title} (${section.items.length}):\n`;
		const kept: string[] = [];
		let cost = heading.length + 2;
		for (const item of section.items) {
			const next = item.length + (section.joined ? 2 : 1);
			if (cost + next > left) break;
			kept.push(item);
			cost += next;
		}
		if (kept.length > 0) {
			out.push(`${heading}${kept.join(section.joined ? ", " : "\n")}`);
			left -= cost;
		}
		if (kept.length < section.items.length) omitted.push([section.title.toLowerCase(), section.items.length - kept.length]);
	}
	if (omitted.length > 0) {
		const count = omitted.reduce((total, [, n]) => total + n, 0);
		out.push(`[… ${count} item${count === 1 ? "" : "s"} omitted (${omitted.map(([title, n]) => `${title} ${n}`).join(", ")}); full result: ${fullResult}]`);
	}
	return out;
}

function verifyBody(v: Obj, caps: Caps): { head: string[]; tail: TailSection[] } {
	const verdicts = list(v.verdicts).filter(isObj);
	const blockers = list(v.blockers).filter(isObj);
	const unverifiedChecks = list(v.unverified).map(str).filter(Boolean);
	const unmet = verdicts.filter((x) => BLOCKING_VERDICTS.has(str(x.verdict)));
	const unverified = verdicts.filter((x) => str(x.verdict) === "unverified");
	const met = verdicts.filter((x) => str(x.verdict) === "met");
	const scoped = verdicts.filter((x) => !BLOCKING_VERDICTS.has(str(x.verdict)) && str(x.verdict) !== "unverified" && str(x.verdict) !== "met");
	const status = statusLine([["BLOCKERS", blockers.length], ["UNMET", unmet.length], ["UNVERIFIED", unverified.length + unverifiedChecks.length]]);

	const head = [status];
	if (blockers.length) {
		head.push(`Blockers (${blockers.length}):\n${blockers.map((b, i) => `- B${i + 1}${b.spec ? ` [${str(b.spec)}]` : ""} ${indent(str(b.summary))}\n  Reproduction: ${indent(compactText(str(b.reproduction), caps.repro))}`).join("\n")}`);
	}
	const open = verdicts.filter((x) => BLOCKING_VERDICTS.has(str(x.verdict)) || str(x.verdict) === "unverified");
	if (open.length) head.push(`Unmet or unverified verdicts:\n${open.map((x) => `- ${str(x.spec)}: ${str(x.verdict)} — ${indent(compactText(str(x.evidence), caps.evidence))}`).join("\n")}`);
	if (met.length) head.push(`Met (${met.length}): ${met.map((x) => str(x.spec)).join(", ")}`);
	if (scoped.length) head.push(`Out of scope or other (${scoped.length}): ${scoped.map((x) => `${str(x.spec)} ${str(x.verdict)}`).join(", ")}`);

	const advisories = list(v.advisories).filter(isObj);
	const tests = list(v.regressionTests).filter(isObj);
	const scratch = list(v.scratch).map(str).filter(Boolean);
	const tail: TailSection[] = [
		{ title: "Advisories", items: advisories.map((a) => `- ${firstLine(str(a.summary), ADVISORY_SUMMARY_CHARS)}${a.reproduction ? ` (repro: ${firstLine(str(a.reproduction), ADVISORY_REPRO_CHARS)})` : ""}`) },
		{ title: "Regression tests", items: tests.map((t) => `- ${str(t.path)} (covers ${str(t.covers)})`) },
		{ title: "Unverified", items: unverifiedChecks.map((u) => `- ${indent(compactText(u, UNVERIFIED_ITEM_CHARS))}`) },
		{ title: "Scratch", items: scratch, joined: true },
	];
	return { head, tail };
}

const findingLine = (f: Obj, claimChars: number, evidenceChars: number) =>
	`- ${str(f.id)} ${str(f.severity)} ${str(f.location)} (${str(f.cause)}): ${indent(claimChars > 0 ? compactText(str(f.claim), claimChars) : str(f.claim))}\n  Evidence: ${indent(compactText(str(f.evidence), evidenceChars))}`;

function reviewBody(v: Obj, caps: Caps): { head: string[]; tail: TailSection[] } {
	// Every part of a review is either blocking or capped per item: there is no tail to give way.
	const findings = list(v.findings).filter(isObj);
	const bySeverity = (severity: string) => findings.filter((f) => str(f.severity) === severity);
	const blockers = bySeverity("BLOCKER");
	const critical = bySeverity("CRITICAL");
	const warnings = bySeverity("WARNING");
	const suggestions = bySeverity("SUGGESTION").length;
	const other = findings.length - blockers.length - critical.length - warnings.length - suggestions;
	const head = [statusLine([["BLOCKERS", blockers.length], ["CRITICAL", critical.length], ["WARNING", warnings.length]])];
	const mustFix = [...blockers, ...critical];
	if (mustFix.length) head.push(`Findings:\n${mustFix.map((f) => findingLine(f, 0, caps.finding)).join("\n")}`);
	if (warnings.length) {
		const shown = warnings.slice(0, WARNING_MAX).map((f) => findingLine(f, WARNING_CLAIM_CHARS, WARNING_EVIDENCE_CHARS));
		if (warnings.length > WARNING_MAX) shown.push(`- … ${warnings.length - WARNING_MAX} more WARNING findings in the full result`);
		head.push(`Warnings:\n${shown.join("\n")}`);
	}
	if (findings.length === 0) head.push("No findings.");
	const counts = [suggestions ? `${suggestions} SUGGESTION (not listed; see the full result)` : "", other > 0 ? `${other} other` : ""].filter(Boolean);
	if (counts.length) head.push(`Also: ${counts.join(", ")}`);
	if (v.reviewed !== undefined) head.push(`Reviewed: ${compactText(str(v.reviewed), REVIEWED_CHARS)}`);
	return { head, tail: [] };
}

/**
 * The structured payload of a verify or review agent, reduced to what the parent acts on; any other payload is compact JSON.
 * `fullResult` names where the whole result is, for the marker that says what the tail left out.
 */
export function compactStructured(value: unknown, max: number = COMPACT_MAX_CHARS, fullResult = "the full result"): string {
	const isVerify = isObj(value) && Array.isArray(value.verdicts);
	const isReview = isObj(value) && Array.isArray(value.findings);
	if (!isVerify && !isReview) return compactText(JSON.stringify(value), max);
	const build = (caps: Caps) => (isVerify ? verifyBody(value as Obj, caps) : reviewBody(value as Obj, caps));
	// The part that blocks is never cut: when it alone is over the target, its per-item caps tighten instead.
	let body = build(CAPS[0]);
	if (body.head.join("\n\n").length > max) body = build(CAPS[1]);
	const head = body.head.join("\n\n");
	return [head, ...fitTail(body.tail, max - head.length, fullResult)].join("\n\n");
}

export interface CompactInput {
	/** The validated structured payload; when set, `text` is ignored. */
	structured?: unknown;
	/** The final text or error. */
	text?: string;
	/** The run's saved folder; the result ends with the path of its `result.json`. */
	artifactsDir?: string;
	/** The run should have been saved but the write failed: the parent is told the full result is not on disk. */
	notSaved?: boolean;
}

/** The compact result the parent reads: verdict-level content, then the path of the full result (or that there is none). */
export function compactResult({ structured, text, artifactsDir, notSaved }: CompactInput): string {
	const fullPath = artifactsDir ? `${artifactsDir.replace(/\/+$/, "")}/result.json` : undefined;
	const body = structured !== undefined ? compactStructured(structured, COMPACT_MAX_CHARS, fullPath) : compactText(text ?? "");
	if (fullPath) return `${body}\n\nFull result: ${fullPath}`;
	return notSaved ? `${body}\n\n(full result not saved)` : body;
}
