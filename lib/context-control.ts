// Context control (S16): decides when to compact. Pure; extensions/context-control.ts feeds it Pi's state.
// Evidence: median parent turn re-read 208k tokens, 76% of cost came from turns above 200k, and most cache rebuilds
// followed an idle gap longer than the cache lifetime. Compacting is cheaper there, and no model-facing text is needed.

export interface ContextSettings {
	enabled: boolean;
	/** Compact at a turn boundary when context reaches this many tokens; 0 turns the threshold off. */
	compactAt: number;
	/** A prompt after this many idle minutes may trigger a compaction; 0 turns the idle rule off. */
	idleCompactMinutes: number;
	/** The idle rule applies only from this many context tokens. */
	idleCompactMin: number;
}

export const CONTEXT_DEFAULTS: ContextSettings = { enabled: true, compactAt: 160_000, idleCompactMinutes: 60, idleCompactMin: 100_000 };

const count = (value: unknown, fallback: number): number => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback);

/** `raw` is the `context` object of brigadev.json; anything invalid falls back to the default. */
export function resolveContextSettings(raw: unknown): ContextSettings {
	const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	return {
		enabled: r.enabled !== false,
		compactAt: count(r.compactAt, CONTEXT_DEFAULTS.compactAt),
		idleCompactMinutes: count(r.idleCompactMinutes, CONTEXT_DEFAULTS.idleCompactMinutes),
		idleCompactMin: count(r.idleCompactMin, CONTEXT_DEFAULTS.idleCompactMin),
	};
}

export interface ControlState {
	child: boolean;
	/** "settled": the agent just stopped (turn boundary). "input": a new user prompt is about to start a run. */
	trigger: "settled" | "input";
	/** Context tokens, or null/undefined when Pi cannot tell (for example right after a compaction). */
	tokens: number | null | undefined;
	/** When the previous assistant turn ended (ms since epoch). */
	lastTurnEndMs?: number;
	/** Completed turns since the last compaction (ours or Pi's). */
	turnsSinceCompact: number;
	/** A compaction is already running, or the agent is mid-run. */
	busy?: boolean;
}

export type Reason = "threshold" | "idle" | "disabled" | "child" | "busy" | "no-new-turns" | "no-usage" | "below-threshold";
export interface Decision {
	action: "compact" | "none";
	reason: Reason;
}

export function decide(state: ControlState, settings: ContextSettings, now: number): Decision {
	const none = (reason: Reason): Decision => ({ action: "none", reason });
	if (state.child) return none("child");
	if (!settings.enabled) return none("disabled");
	if (state.busy) return none("busy");
	if (state.turnsSinceCompact < 1) return none("no-new-turns");
	if (typeof state.tokens !== "number") return none("no-usage");
	if (state.trigger === "input" && settings.idleCompactMinutes > 0 && state.lastTurnEndMs !== undefined) {
		const idleMs = now - state.lastTurnEndMs;
		if (idleMs > settings.idleCompactMinutes * 60_000 && state.tokens >= settings.idleCompactMin) return { action: "compact", reason: "idle" };
	}
	if (settings.compactAt > 0 && state.tokens >= settings.compactAt) return { action: "compact", reason: "threshold" };
	return none("below-threshold");
}

/** What the summary must keep so the next turn continues without re-deriving state. */
export const COMPACT_INSTRUCTIONS = [
	"Preserve, in this order and without paraphrasing the first item:",
	"1. The user's open request, verbatim.",
	"2. The current git branch.",
	"3. The feature document path, if there is one.",
	"4. Open todo items (not the finished ones).",
	"5. The last test command and its outcome (pass/fail counts, failing test names).",
	"6. The next step.",
	"Drop file contents, tool output and exploration that no longer affect the next step.",
].join("\n");

export interface LastCompaction {
	atMs: number;
	reason: Reason;
	tokens: number;
}

// Shared with the doctor (same process): the last compaction this extension started.
let last: LastCompaction | undefined;
export const recordCompaction = (entry: LastCompaction): void => void (last = entry);
export const lastCompaction = (): LastCompaction | undefined => last;
export const resetCompactionRecord = (): void => void (last = undefined);

export const formatTokens = (n: number): string => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** One short doctor line. */
export function describeContextControl(settings: ContextSettings, record: LastCompaction | undefined, now: number): string {
	if (!settings.enabled) return "context control: off (brigadev.json context.enabled)";
	const parts = [
		settings.compactAt > 0 ? `compact at ${formatTokens(settings.compactAt)}` : "threshold off",
		settings.idleCompactMinutes > 0 ? `after ${settings.idleCompactMinutes} min idle from ${formatTokens(settings.idleCompactMin)}` : "idle rule off",
	];
	const lastText = record ? `last: ${record.reason} at ${formatTokens(record.tokens)}, ${Math.max(0, Math.round((now - record.atMs) / 60_000))} min ago` : "none this session";
	return `context control: ${parts.join(", ")}; ${lastText}`;
}
