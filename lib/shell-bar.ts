// One-line status bar layout: segments with priorities that drop out, lowest
// priority first, until the line fits. Pure: width measuring and colors are
// supplied by the caller.

export type Tone = "accent" | "muted" | "dim" | "success" | "warning" | "error" | "text" | "borderMuted";

export interface Segment {
	id: string;
	text: string;
	tone?: Tone;
	/** Higher stays longer on narrow terminals. */
	priority: number;
}

export const SEPARATOR = " │ ";

/** Keeps the highest-priority segments that fit, in their original order. */
export function layoutSegments(segments: readonly Segment[], width: number, measure: (s: string) => number = (s) => s.length): Segment[] {
	const kept = segments.filter((s) => s.text);
	const total = (list: readonly Segment[]) => list.reduce((sum, s, i) => sum + measure(s.text) + (i > 0 ? measure(SEPARATOR) : 0), 0);
	while (kept.length > 1 && total(kept) > width) {
		let lowest = 0;
		for (let i = 1; i < kept.length; i++) if (kept[i].priority < kept[lowest].priority) lowest = i;
		kept.splice(lowest, 1);
	}
	return kept;
}

/** Context gauge such as "▰▰▰▱▱▱▱▱ 45%", or "?%" when unknown (right after compaction). */
export function contextGauge(percent: number | null | undefined, cells = 8): { text: string; tone: Tone } {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return { text: `ctx ${"▱".repeat(cells)} ?%`, tone: "dim" };
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	const tone: Tone = clamped >= 95 ? "error" : clamped >= 80 ? "warning" : "muted";
	return { text: `ctx ${"▰".repeat(filled)}${"▱".repeat(cells - filled)} ${Math.round(clamped)}%`, tone };
}

/** Known brigadev statuses get compact bar segments; everything else passes through. */
export function statusSegment(key: string, text: string): Segment | undefined {
	switch (key) {
		case "brigadev-mode":
			// Normal mode is the default and stays out of the way.
			return /yolo/i.test(text) ? { id: key, text: "🚀 yolo", tone: "warning", priority: 90 } : undefined;
		case "brigadev-cost":
			return { id: key, text, tone: "muted", priority: 60 };
		case "brigadev-profile":
			return { id: key, text: text.replace(/^profile:\s*/, "profile "), tone: "dim", priority: 40 };
		case "brigadev-agents":
			return { id: key, text, tone: "accent", priority: 85 };
		case "brigadev-usage": {
			// Percentages in the text decide the tone, like the context gauge.
			const top = Math.max(0, ...[...text.matchAll(/(\d+)%/g)].map((m) => Number(m[1])));
			const tone: Tone = /limit reached/.test(text) || top >= 95 ? "error" : top >= 80 ? "warning" : "dim";
			return { id: key, text: `◷ ${text}`, tone, priority: 65 };
		}
		case "brigadev-harness":
			return { id: key, text, tone: "warning", priority: 95 };
		default:
			return { id: key, text, tone: "dim", priority: 10 };
	}
}

/** Statuses the bar renders as its own segments, in this order, before third-party ones. */
export const KNOWN_STATUS_ORDER = ["brigadev-harness", "brigadev-mode", "brigadev-agents", "brigadev-cost", "brigadev-usage", "brigadev-profile"];
