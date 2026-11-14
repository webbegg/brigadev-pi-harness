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
//
// A `deliver` that throws (a stale session context) is not final: the item stays held (so the
// registry's prune keeps it) and is tried again on the next idle flush, up to DELIVERY_ATTEMPTS
// attempts in all. After the last one it is released unconsumed, so `subagent_wait` can still
// collect it, and `onDeliveryFailed` tells the user.
//
// What counts as an attempt (R3-101): a failure spends an item's budget at most once per idle signal.
// The public `flush()` is the idle signal (the host calls it on `agent_settled`); each call starts a new
// idle epoch. A flush that a settle triggers also tries earlier-failed items (so one can still get through
// without waiting), but if that item already failed in the current epoch, the failure is not counted again.
// So unrelated settles cannot burn the budget; only distinct idle signals (and the item's first failure) do.

import type { WaitOutcome } from "./subagent-registry.ts";

/** Delivery attempts per result (the first one included) before it is released unconsumed. */
export const DELIVERY_ATTEMPTS = 3;

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
	/** Hands one result to the parent. A throw leaves the launch unconsumed and held for a retry at the next idle flush. */
	deliver: (item: Delivered<R>) => void;
	/** Called once with the last error when DELIVERY_ATTEMPTS attempts all threw: the result stays unconsumed for `subagent_wait`. */
	onDeliveryFailed?: (item: Delivered<R>, error: unknown) => void;
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
	// Attempts that threw, per launch id, and the idle epoch of the last one that was counted.
	let failures = new Map<string, { attempts: number; epoch: number }>();
	// Incremented by each idle signal (public `flush`).
	let epoch = 0;

	const flushPass = () => {
		// A delivery may synchronously start a turn that flushes again; the outer loop keeps going.
		if (flushing || queue.length === 0 || !deps.isIdle()) return;
		flushing = true;
		// Items whose delivery threw: put back (in order, ahead of newer ones) after the pass, so a flush tries each item once.
		const retry: Delivered<R>[] = [];
		try {
			while (queue.length > 0) {
				const item = queue.shift()!;
				if (!enabled || deps.isConsumed(item.id)) {
					failures.delete(item.id);
					continue;
				}
				try {
					deps.deliver(item);
				} catch (error) {
					const previous = failures.get(item.id);
					// Already counted in this idle epoch (a settle-triggered retry): tried, but the budget is not spent again.
					const attempts = previous === undefined ? 1 : previous.epoch === epoch ? previous.attempts : previous.attempts + 1;
					if (attempts < DELIVERY_ATTEMPTS) {
						failures.set(item.id, { attempts, epoch });
						retry.push(item);
					} else {
						// Released unconsumed (so `subagent_wait` still has it) and unheld (so the registry may prune it).
						failures.delete(item.id);
						try {
							deps.onDeliveryFailed?.(item, error);
						} catch {
							// The notice is best effort; the next item still goes out.
						}
					}
					continue;
				}
				failures.delete(item.id);
				deps.markConsumed(item.id);
			}
		} finally {
			flushing = false;
			// A reset or stop during the pass must not bring items back.
			if (enabled && retry.length > 0) queue = [...retry, ...queue];
		}
	};

	return {
		settled({ launch, result }) {
			if (!enabled || launch.consumed || deps.isConsumed(launch.id) || queue.some((q) => q.id === launch.id)) return;
			queue.push({ id: launch.id, launch, ...(launch.error === undefined ? { result } : {}) });
			flushPass();
		},
		flush() {
			// A flush re-entered from a delivery is the same idle signal, not a new one.
			if (!flushing) epoch++;
			flushPass();
		},
		held: () => queue.map((q) => q.id),
		isHeld: (id) => queue.some((q) => q.id === id),
		reset() {
			queue = [];
			failures = new Map();
			enabled = true;
		},
		stop() {
			queue = [];
			failures = new Map();
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

/**
 * What `subagent_wait` answers for a launch whose result the idle delivery already put in the session: the launch id,
 * that it was delivered, and each task's saved folder (run-artifacts.ts), so the full text can still be read. Not the result.
 */
export function alreadyDeliveredText(id: string, tasks: ReadonlyArray<{ agent: string; artifactsDir?: string }>): string {
	const lines = [`Launch ${id} was already delivered to this session: its result is in the conversation above, so it is not repeated here.`];
	if (tasks.length > 0) {
		lines.push("Saved folders (the full text is in result.json):");
		lines.push(...tasks.map((t) => `- ${t.agent}: ${t.artifactsDir ?? "(no saved folder)"}`));
	}
	return lines.join("\n");
}

/**
 * The short note for a launch whose result the idle delivery already put in the session, or `undefined` when the outcome
 * should be collected normally. One decision for `subagent_wait` and `subagent_cancel`, so neither repeats a delivered result.
 */
export function deliveredNote<R extends { details: { results: ReadonlyArray<{ agent: string; artifactsDir?: string }> } }>(id: string, outcome: WaitOutcome<R>): string | undefined {
	if (outcome.status !== "settled" || outcome.launch.consumedBy !== "delivered") return undefined;
	return alreadyDeliveredText(
		id,
		(outcome.result?.details.results ?? []).map((r) => ({ agent: r.agent, artifactsDir: r.artifactsDir })),
	);
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
