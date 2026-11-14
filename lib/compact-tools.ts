// Compact tool rows: the one-line collapsed view of Pi's built-in tools, and the
// renderer resolver that swaps it in. Pure: no Pi imports. The extension adapts
// Pi's Theme and Component types through CompactDeps.
//
// Presentation only. Nothing here changes what a tool returns to the model.

import type { Tone } from "./shell-bar.ts";

export const COMPACT_TOOLS = ["read", "grep", "find", "ls", "bash", "edit", "write"] as const;
const COMPACT_SET: ReadonlySet<string> = new Set(COMPACT_TOOLS);

export interface RowLine {
	text: string;
	tone: Tone;
}

export type RowPhase = "running" | "done" | "error";

export interface RowInput {
	tool: string;
	args: unknown;
	phase: RowPhase;
	/** Running: time since start. Settled: the tool's duration. Undefined when unknown. */
	elapsedMs?: number;
	/** Text content of the result (the error message when phase is "error"). */
	text?: string;
	details?: unknown;
	cwd?: string;
}

const MAX_COMMAND = 70;
const MAX_PATH = 60;
const MAX_PATTERN = 40;
const MAX_ERROR_LINE = 100;
const MAX_ERROR_LINES = 3;

const MINUS = "−";

export function formatDuration(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	if (s < 10) return `${s.toFixed(1)}s`;
	if (s < 60) return `${Math.floor(s)}s`;
	const total = Math.floor(s);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m ${total % 60}s`;
}

/** Added and removed line counts of a Pi display diff (`+12 text`, `-3 text`, ` 4 context`). */
export function diffStat(diff: string | undefined): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of (diff ?? "").split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed };
}

function clip(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

const asString = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);

function pathOf(args: Record<string, unknown>, cwd: string | undefined): string | undefined {
	const raw = asString(args.file_path) ?? asString(args.path);
	if (raw === undefined) return undefined;
	const base = cwd?.replace(/\/+$/, "");
	const rel = base && raw.startsWith(`${base}/`) ? raw.slice(base.length + 1) : raw;
	return clip(rel, MAX_PATH);
}

/** Result text without Pi's trailing `[notice]` block (limits, truncation). */
function body(text: string | undefined): string {
	const trimmed = (text ?? "").replace(/\s+$/, "");
	const at = trimmed.lastIndexOf("\n\n[");
	if (at !== -1 && trimmed.endsWith("]")) return trimmed.slice(0, at);
	return /^\[[^\n]*\]$/.test(trimmed) ? "" : trimmed;
}

const lineList = (text: string) => text.split("\n").filter((l) => l.trim() !== "");

function lineRange(args: Record<string, unknown>): string {
	const offset = typeof args.offset === "number" ? args.offset : undefined;
	const limit = typeof args.limit === "number" ? args.limit : undefined;
	if (offset === undefined && limit === undefined) return "";
	const start = offset ?? 1;
	return limit === undefined ? `:${start}-` : `:${start}-${start + limit - 1}`;
}

const VERB_RUNNING: Record<string, string> = {
	read: "Reading",
	grep: "Searching",
	find: "Finding",
	ls: "Listing",
	bash: "Running",
	edit: "Editing",
	write: "Writing",
};

const quoted = (value: string | undefined) => (value === undefined ? "" : `"${clip(oneLine(value), MAX_PATTERN)}"`);
const join = (...parts: Array<string | undefined>) => parts.filter((p) => p !== undefined && p !== "").join(" ");

/** What the call is about: the command, the path, or the pattern plus where. */
function target(tool: string, args: Record<string, unknown>, cwd: string | undefined): string {
	switch (tool) {
		case "bash":
			return clip(oneLine(asString(args.command) ?? ""), MAX_COMMAND);
		case "grep":
			return join(quoted(asString(args.pattern)), pathOf(args, cwd));
		case "find":
			return join(quoted(asString(args.pattern)), pathOf(args, cwd));
		case "ls":
			return pathOf(args, cwd) ?? ".";
		case "read":
			return `${pathOf(args, cwd) ?? ""}${lineRange(args)}`;
		default:
			return pathOf(args, cwd) ?? "";
	}
}

function bashMarker(text: string): { reason?: string; rest: string } {
	const lines = text.replace(/\s+$/, "").split("\n");
	const last = lines[lines.length - 1] ?? "";
	const exit = /^Command exited with code (\d+)$/.exec(last);
	const timeout = /^Command timed out after (.+)$/.exec(last);
	const reason = exit ? `exit ${exit[1]}` : timeout ? `timed out after ${timeout[1]}` : last === "Command aborted" ? "aborted" : undefined;
	return reason ? { reason, rest: lines.slice(0, -1).join("\n") } : { rest: lines.join("\n") };
}

function errorRow(input: RowInput, args: Record<string, unknown>): RowLine[] {
	const tool = input.tool;
	let text = input.text ?? "";
	let reason: string | undefined;
	if (tool === "bash") ({ reason, rest: text } = bashMarker(text));
	const lines = lineList(text);
	// Build and test output ends with the failure; other tools state it first.
	const picked = (tool === "bash" ? lines.slice(-MAX_ERROR_LINES) : lines.slice(0, MAX_ERROR_LINES)).map((l) => `  ${clip(l.trim(), MAX_ERROR_LINE)}`);
	const header = `✗ ${join(tool, target(tool, args, input.cwd))}${reason ? ` · ${reason}` : ""}`;
	return [{ text: header, tone: "error" }, ...picked.map((text): RowLine => ({ text, tone: "error" }))];
}

function runningRow(input: RowInput, args: Record<string, unknown>): RowLine[] {
	const verb = VERB_RUNNING[input.tool] ?? input.tool;
	const time = input.elapsedMs === undefined ? "" : ` ${formatDuration(input.elapsedMs)}`;
	return [{ text: `◐ ${verb} ${target(input.tool, args, input.cwd)}…${time}`, tone: "accent" }];
}

function doneRow(input: RowInput, args: Record<string, unknown>): RowLine {
	const { tool, cwd } = input;
	const where = target(tool, args, cwd);
	const out = body(input.text);
	const dur = input.elapsedMs === undefined ? "" : ` · ${formatDuration(input.elapsedMs)}`;
	let text: string;
	switch (tool) {
		case "grep": {
			const matches = out === "No matches found" ? 0 : lineList(out).filter((l) => /^.+:\d+: /.test(l)).length;
			text = `grep ${where} → ${plural(matches, "match", "matches")}${dur}`;
			break;
		}
		case "find": {
			const files = /^No files found/.test(out) ? 0 : lineList(out).length;
			text = `find ${where} → ${plural(files, "file", "files")}${dur}`;
			break;
		}
		case "ls": {
			const entries = out === "(empty directory)" ? 0 : lineList(out).length;
			text = `ls ${where} → ${plural(entries, "entry", "entries")}`;
			break;
		}
		case "bash":
			text = `Ran ${where}${dur}`;
			break;
		case "edit": {
			const { added, removed } = diffStat(asString(record(input.details).diff));
			text = `Edited ${where}${added + removed > 0 ? ` +${added} ${MINUS}${removed}` : ""}`;
			break;
		}
		case "write": {
			const content = asString(args.content);
			const n = content === undefined ? undefined : content.replace(/\n$/, "").split("\n").length;
			text = `Wrote ${where}${n === undefined ? "" : ` (${plural(n, "line", "lines")})`}`;
			break;
		}
		case "read": {
			const truncation = record(record(input.details).truncation);
			const shown = lineList(out).length;
			const lines =
				truncation.truncated === true && typeof truncation.outputLines === "number" && typeof truncation.totalLines === "number"
					? `${truncation.outputLines} of ${truncation.totalLines} lines`
					: shown > 0
						? plural(shown, "line", "lines")
						: "";
			text = `read ${where}${lines ? ` (${lines})` : ""}`;
			break;
		}
		default:
			text = join(tool, where);
	}
	return { text: `✓ ${text}`, tone: "success" };
}

/** The collapsed row: one line, or the header plus 1-3 error lines. */
export function compactRow(input: RowInput): RowLine[] {
	const args = record(input.args);
	if (input.phase === "running") return runningRow(input, args);
	if (input.phase === "error") return errorRow(input, args);
	return [doneRow(input, args)];
}

// --- resolver ---------------------------------------------------------------

/** Pi's ToolRenderContext, as far as the resolver reads it. */
export interface CompactContext {
	args?: unknown;
	state?: unknown;
	cwd?: string;
	expanded: boolean;
	isPartial: boolean;
	isError: boolean;
	executionStarted: boolean;
	durationMs?: number;
	lastComponent?: unknown;
	invalidate?: () => void;
}

export interface CompactResult {
	content?: Array<{ type: string; text?: string }>;
	details?: unknown;
}

export interface CompactRenderers<C, T> {
	renderShell?: "default" | "self";
	renderCall?: (args: any, theme: T, context: any) => C;
	renderResult?: (result: any, options: { expanded: boolean; isPartial: boolean }, theme: T, context: any) => C;
}

export interface CompactDeps<C, T> {
	/** A component that renders `get()` lazily, one terminal line per row, painted with the theme. */
	row(get: () => RowLine[], theme: T): C;
	/** A component that renders no lines. */
	empty(): C;
	now?: () => number;
	/** Calls `fn` every `ms` until the returned function is called. */
	every?: (fn: () => void, ms: number) => () => void;
}

const STATE_KEY = "__brigadevCompact";

interface RowState {
	args?: unknown;
	cwd?: string;
	invalidate?: () => void;
	result?: { text: string; details: unknown };
	isError: boolean;
	settled: boolean;
	startedAt?: number;
	endedAt?: number;
	durationMs?: number;
	stop?: () => void;
	ownCall?: unknown;
	ownResult?: unknown;
}

const defaultEvery = (fn: () => void, ms: number) => {
	const id = setInterval(fn, ms);
	(id as { unref?: () => void }).unref?.();
	return () => clearInterval(id);
};

const resultText = (result: CompactResult | undefined) =>
	(result?.content ?? []).filter((c) => c.type === "text").map((c) => c.text ?? "").join("\n");

/**
 * Resolver for pi.registerToolRenderer. Built-in tools collapse to one row;
 * expanded delegates to whatever next() returned. Everything else passes
 * through next() untouched.
 */
export function compactToolResolver<C, T, R extends CompactRenderers<C, T> = CompactRenderers<C, T>>(deps: CompactDeps<C, T>) {
	const now = deps.now ?? Date.now;
	const every = deps.every ?? defaultEvery;

	function stateOf(context: CompactContext): RowState {
		const holder = (context.state ?? {}) as Record<string, RowState | undefined>;
		return (holder[STATE_KEY] ??= { isError: false, settled: false });
	}

	/** Record what the context shows and keep the one timer in step with it. */
	function observe(s: RowState, context: CompactContext, result?: CompactResult) {
		s.args = context.args ?? s.args;
		s.cwd = context.cwd;
		s.invalidate = context.invalidate;
		s.isError = context.isError;
		s.durationMs = context.durationMs;
		if (result) s.result = { text: resultText(result), details: result.details };
		if (context.executionStarted && s.startedAt === undefined) s.startedAt = now();
		const running = context.isPartial && !context.isError;
		if (running) {
			s.settled = false;
			if (s.startedAt !== undefined && !s.stop) s.stop = every(() => s.invalidate?.(), 1000);
			return;
		}
		if (!s.settled) {
			s.settled = true;
			s.endedAt = now();
		}
		s.stop?.();
		s.stop = undefined;
	}

	function rowOf(s: RowState, tool: string): RowLine[] {
		const elapsedMs = s.settled
			? (s.durationMs ?? (s.startedAt !== undefined && s.endedAt !== undefined ? s.endedAt - s.startedAt : undefined))
			: s.startedAt !== undefined
				? now() - s.startedAt
				: undefined;
		return compactRow({
			tool,
			args: s.args,
			phase: !s.settled ? "running" : s.isError ? "error" : "done",
			elapsedMs,
			text: s.result?.text,
			details: s.result?.details,
			cwd: s.cwd,
		});
	}

	/** Base renderers reuse lastComponent; ours are not theirs. */
	const scrub = <X extends CompactContext>(s: RowState, context: X): X =>
		context.lastComponent !== undefined && (context.lastComponent === s.ownCall || context.lastComponent === s.ownResult) ? { ...context, lastComponent: undefined } : context;

	return (toolName: string, next: () => R | undefined): R | CompactRenderers<C, T> | undefined => {
		if (!COMPACT_SET.has(toolName)) return next();
		const base = next();
		const renderers: CompactRenderers<C, T> = {
			renderCall(args, theme, context: CompactContext) {
				const s = stateOf(context);
				observe(s, context);
				if (context.expanded && base?.renderCall) return base.renderCall(args, theme, scrub(s, context));
				const component = context.expanded ? deps.empty() : deps.row(() => rowOf(s, toolName), theme);
				s.ownCall = component;
				return component;
			},
			renderResult(result, options, theme, context: CompactContext) {
				const s = stateOf(context);
				observe(s, context, result);
				if (context.expanded && base?.renderResult) return base.renderResult(result, options, theme, scrub(s, context));
				const component = deps.empty();
				s.ownResult = component;
				return component;
			},
		};
		if (base?.renderShell !== undefined) renderers.renderShell = base.renderShell;
		return renderers;
	};
}
