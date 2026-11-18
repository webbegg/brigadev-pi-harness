// What the parent reads of a subagent result: a compact form (target <= ~8,000 chars, ~2k tokens) that
// ends with the path of the full result. The full text and the structured payload stay in the run folder
// (lib/run-artifacts.ts) and in the tool details, so nothing is lost; only the parent's carried context shrinks.
// Pure: no I/O, no Pi imports.

/** Target size of one task's compact result. */
export const COMPACT_MAX_CHARS = 8000;

const EVIDENCE_CHARS = 600;
const ADVISORY_SUMMARY_CHARS = 240;
const ADVISORY_REPRO_CHARS = 160;
const ADVISORY_MAX = 5;
const FULL_SEVERITIES = new Set(["BLOCKER", "CRITICAL", "WARNING"]);

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

function verifySections(v: Obj): string[] {
	const out: string[] = [];
	const verdicts = list(v.verdicts).filter(isObj);
	if (verdicts.length) out.push(`Verdicts:\n${verdicts.map((x) => `- ${str(x.spec)}: ${str(x.verdict)} — ${indent(compactText(str(x.evidence), EVIDENCE_CHARS))}`).join("\n")}`);
	const blockers = list(v.blockers).filter(isObj);
	out.push(
		blockers.length
			? `Blockers (${blockers.length}):\n${blockers.map((b) => `- ${b.spec ? `[${str(b.spec)}] ` : ""}${indent(str(b.summary))}\n  Reproduction: ${indent(str(b.reproduction))}`).join("\n")}`
			: "Blockers: none",
	);
	const advisories = list(v.advisories).filter(isObj);
	if (advisories.length) {
		const shown = advisories.slice(0, ADVISORY_MAX).map((a) => `- ${firstLine(str(a.summary), ADVISORY_SUMMARY_CHARS)}${a.reproduction ? ` (repro: ${firstLine(str(a.reproduction), ADVISORY_REPRO_CHARS)})` : ""}`);
		if (advisories.length > ADVISORY_MAX) shown.push(`- … ${advisories.length - ADVISORY_MAX} more advisories in the full result`);
		out.push(`Advisories (${advisories.length}):\n${shown.join("\n")}`);
	}
	const tests = list(v.regressionTests).filter(isObj);
	if (tests.length) out.push(`Regression tests:\n${tests.map((t) => `- ${str(t.path)} (covers ${str(t.covers)})`).join("\n")}`);
	const unverified = list(v.unverified).map(str).filter(Boolean);
	out.push(unverified.length ? `Unverified:\n${unverified.map((u) => `- ${indent(u)}`).join("\n")}` : "Unverified: none");
	const scratch = list(v.scratch).map(str).filter(Boolean);
	if (scratch.length) out.push(`Scratch: ${scratch.join(", ")}`);
	return out;
}

function reviewSections(v: Obj): string[] {
	const findings = list(v.findings).filter(isObj);
	const full = findings.filter((f) => FULL_SEVERITIES.has(str(f.severity)));
	const suggestions = findings.filter((f) => str(f.severity) === "SUGGESTION").length;
	const other = findings.length - full.length - suggestions;
	const out: string[] = [];
	if (findings.length === 0) out.push("No findings.");
	else {
		if (full.length) out.push(`Findings:\n${full.map((f) => `- ${str(f.id)} ${str(f.severity)} ${str(f.location)} (${str(f.cause)}): ${indent(str(f.claim))}\n  Evidence: ${indent(str(f.evidence))}`).join("\n")}`);
		const counts = [suggestions ? `${suggestions} SUGGESTION (not listed; see the full result)` : "", other > 0 ? `${other} other` : ""].filter(Boolean);
		if (counts.length) out.push(`Also: ${counts.join(", ")}`);
		if (!full.length) out.unshift("No BLOCKER, CRITICAL or WARNING findings.");
	}
	if (v.reviewed !== undefined) out.push(`Reviewed: ${str(v.reviewed)}`);
	return out;
}

/** The structured payload of a verify or review agent, reduced to what the parent acts on; any other payload is compact JSON. */
export function compactStructured(value: unknown, max: number = COMPACT_MAX_CHARS): string {
	let text: string;
	if (isObj(value) && Array.isArray(value.verdicts)) text = verifySections(value).join("\n\n");
	else if (isObj(value) && Array.isArray(value.findings)) text = reviewSections(value).join("\n\n");
	else text = JSON.stringify(value);
	return compactText(text, max);
}

export interface CompactInput {
	/** The validated structured payload; when set, `text` is ignored. */
	structured?: unknown;
	/** The final text or error. */
	text?: string;
	/** The run's saved folder; the result ends with the path of its `result.json`. */
	artifactsDir?: string;
}

/** The compact result the parent reads: verdict-level content, then the path of the full result. */
export function compactResult({ structured, text, artifactsDir }: CompactInput): string {
	const body = structured !== undefined ? compactStructured(structured) : compactText(text ?? "");
	return artifactsDir ? `${body}\n\nFull result: ${artifactsDir.replace(/\/+$/, "")}/result.json` : body;
}
