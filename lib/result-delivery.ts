// Idle-time delivery of async subagent results. Pure: no Pi imports; whether the
// parent is idle, how a result is handed to it, and what counts as already
// collected are injected, so tests drive it with fakes.
//
// A settled launch the model has not collected (`subagent_wait` / `subagent_cancel`
// consume it) is delivered to the parent exactly once: at once if the parent is
// idle, otherwise held until the next idle signal (`flush`). A result collected
// while it was held is skipped at flush. Sync launches never reach this buffer:
// they are not in the registry, so no settle event exists for them.
//
// One `deliver` call per launch, in settle order. Delivering means injecting a
// message that starts a parent turn; the host sends them all from one idle
// signal, and the later ones join the turn the first one starts (Pi: messages
// sent while a run is starting go into that run), so several results still cost
// one parent turn. For that reason idleness is checked once per flush, not per item.

export interface Delivered<R> {
	id: string;
	launch: { id: string; consumed: boolean; error: string | undefined };
	result?: R;
}

export interface ResultDeliveryDeps<R> {
	/** True when the parent agent is not in a run (a delivery would start a turn now). */
	isIdle: () => boolean;
	/** True when the model already has this launch's result (collected by wait/cancel), or the launch is gone. */
	isConsumed: (id: string) => boolean;
	/** Records that the result was delivered, so a later `wait` or idle signal cannot repeat it. */
	markConsumed: (id: string) => void;
	/** Hands one result to the parent. A throw leaves the launch unconsumed, so `wait` can still collect it. */
	deliver: (item: Delivered<R>) => void;
}

export interface ResultDelivery<R> {
	/** A launch settled (registry `settle` event): deliver now when idle, else hold it. */
	settled(event: { launch: Delivered<R>["launch"]; result?: R }): void;
	/** The parent became idle: deliver everything held, in settle order, skipping what was collected meanwhile. */
	flush(): void;
	/** Ids held and not yet delivered, in settle order. */
	held(): string[];
	isHeld(id: string): boolean;
	/** Forgets held results and starts accepting settles (session start). */
	reset(): void;
	/** Forgets held results and ignores later settles (session shutdown aborts children, which then settle). */
	stop(): void;
}

export function createResultDelivery<R>(deps: ResultDeliveryDeps<R>): ResultDelivery<R> {
	let queue: Delivered<R>[] = [];
	let enabled = true;
	let flushing = false;

	const flush = () => {
		// A delivery may synchronously start a turn that flushes again; the outer loop keeps going.
		if (flushing || queue.length === 0 || !deps.isIdle()) return;
		flushing = true;
		try {
			while (queue.length > 0) {
				const item = queue.shift()!;
				if (!enabled || deps.isConsumed(item.id)) continue;
				try {
					deps.deliver(item);
				} catch {
					// Not delivered (for example a stale session): it stays unconsumed, so `subagent_wait` still has it.
					continue;
				}
				deps.markConsumed(item.id);
			}
		} finally {
			flushing = false;
		}
	};

	return {
		settled({ launch, result }) {
			if (!enabled || launch.consumed || deps.isConsumed(launch.id) || queue.some((q) => q.id === launch.id)) return;
			queue.push({ id: launch.id, launch, ...(launch.error === undefined ? { result } : {}) });
			flush();
		},
		flush,
		held: () => queue.map((q) => q.id),
		isHeld: (id) => queue.some((q) => q.id === id),
		reset() {
			queue = [];
			enabled = true;
		},
		stop() {
			queue = [];
			enabled = false;
		},
	};
}

/** Custom message type of a delivered async result (the extension registers its renderer under it). */
export const RESULT_MESSAGE_TYPE = "brigadev-subagent-result";
export const CARD_BODY_LINES = 3;

export interface ResultMessageDetails {
	launchId: string;
	failed: boolean;
}

/**
 * The custom message injected into the parent: the launch id and the same text `subagent_wait` returns,
 * under a one-line header that also tells the model not to wait for it again.
 */
export function resultMessage(id: string, text: string, failed: boolean) {
	const header = `Async subagent launch ${id} ${failed ? "finished with errors" : "finished"}. Delivered automatically: it is already collected, so do not call subagent_wait for it.`;
	return { customType: RESULT_MESSAGE_TYPE, content: `${header}\n\n${text}`, display: true, details: { launchId: id, failed } satisfies ResultMessageDetails };
}

export interface CardLine {
	text: string;
	tone: "success" | "error" | "dim" | "muted";
}

/**
 * Compact card for a delivered result: a header, then (collapsed) the first lines of the text and how many
 * more there are, or (expanded) only the header, because the renderer appends the whole text as markdown.
 */
export function resultCard(content: string, details: ResultMessageDetails | undefined, expanded: boolean): { lines: CardLine[]; hidden: number; body: string } {
	const at = content.indexOf("\n\n");
	const body = (at >= 0 ? content.slice(at + 2) : content).trim();
	const failed = details?.failed ?? false;
	const lines: CardLine[] = [{ text: `${failed ? "✗" : "✓"} subagent ${details?.launchId ?? "launch"} ${failed ? "finished with errors" : "finished"} (delivered)`, tone: failed ? "error" : "success" }];
	const bodyLines = body.split("\n");
	if (expanded) return { lines, hidden: 0, body };
	lines.push(...bodyLines.slice(0, CARD_BODY_LINES).map((text): CardLine => ({ text: `  ${text}`, tone: "dim" })));
	const hidden = Math.max(0, bodyLines.length - CARD_BODY_LINES);
	if (hidden > 0) lines.push({ text: `  … ${hidden} more line${hidden === 1 ? "" : "s"}`, tone: "muted" });
	return { lines, hidden, body };
}
