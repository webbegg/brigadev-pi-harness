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
// One message per flush (D1): a flush hands every ready launch (held, not consumed), in settle
// order, to ONE `deliver` call, which the host turns into ONE message that starts ONE parent turn.
// (Live, with Pi 1.5.2: one message per launch started a turn each, because Pi takes a second
// steer only after the run the first one started has settled; and the first turn's model saw only
// one result.) A settle while idle with exactly one ready launch is a batch of one. A launch that
// settles while a batch is being delivered is not part of it and not lost: it waits for the next flush.
//
// A `deliver` that throws (a stale session context) is not final: the whole batch stays held, in
// order (so the registry's prune keeps it), and is tried again on the next idle flush, together with
// whatever settled since, up to DELIVERY_ATTEMPTS attempts in all. After the last one every item is
// released unconsumed, so `subagent_wait` can still collect it, and `onDeliveryFailed` tells the
// user, once per item. Items are marked consumed only after `deliver` returned, all of the batch.
//
// What counts as an attempt (R3-101): a failure spends the batch's budget at most once per idle signal.
// The public `flush()` is the idle signal (the host calls it on `agent_settled`); each call starts a new
// idle epoch. A flush that a settle triggers also retries the earlier-failed batch (so it can still get
// through without waiting), but if its items already failed in the current epoch, the failure is not
// counted again. So unrelated settles cannot burn the budget; only distinct idle signals (and the first
// failure) do. The budget of a batch is its most-attempted item's.

import { PER_TASK_OUTPUT_CAP } from "./subagent-launch.ts";
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
	/** Hands the ready results to the parent as one message (settle order). A throw leaves them all unconsumed and held for a retry at the next idle flush. */
	deliver: (batch: Delivered<R>[]) => void;
	/** Called once per item, with the last error, when DELIVERY_ATTEMPTS attempts all threw: the results stay unconsumed for `subagent_wait`. */
	onDeliveryFailed?: (item: Delivered<R>, error: unknown) => void;
}

export interface ResultDelivery<R> {
	/** A launch settled (registry `settle` event): deliver now when idle, else hold it. */
	settled(event: { launch: Delivered<R>["launch"]; result?: R }): void;
	/** The parent became idle: deliver everything held as one batch, in settle order, skipping what was collected meanwhile. */
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
	// Incremented by reset and stop: a delivery that was running across one must not put its batch back.
	let generation = 0;

	const flushPass = () => {
		// A delivery may synchronously start a turn that flushes again: that is the same idle signal and does nothing.
		if (flushing || queue.length === 0 || !deps.isIdle()) return;
		flushing = true;
		const startedIn = generation;
		// What is ready now. Whatever settles during the delivery lands in `queue` and waits for the next flush.
		const batch: Delivered<R>[] = [];
		for (const item of queue) {
			if (!enabled || deps.isConsumed(item.id)) failures.delete(item.id);
			else batch.push(item);
		}
		queue = [];
		try {
			if (batch.length === 0) return;
			try {
				deps.deliver(batch);
			} catch (error) {
				if (generation !== startedIn) return; // reset or stop ran meanwhile: nothing comes back
				// An item already counted in this idle epoch (a settle-triggered retry) does not spend its budget again.
				const attempts = Math.max(
					...batch.map((item) => {
						const previous = failures.get(item.id);
						return previous === undefined ? 1 : previous.epoch === epoch ? previous.attempts : previous.attempts + 1;
					}),
				);
				if (attempts < DELIVERY_ATTEMPTS) {
					for (const item of batch) failures.set(item.id, { attempts, epoch });
					// Back in order, ahead of what settled meanwhile.
					queue = [...batch, ...queue];
				} else {
					// Released unconsumed (so `subagent_wait` still has them) and unheld (so the registry may prune them).
					for (const item of batch) {
						failures.delete(item.id);
						try {
							deps.onDeliveryFailed?.(item, error);
						} catch {
							// The notice is best effort; the next item still gets its own.
						}
					}
				}
				return;
			}
			for (const item of batch) {
				failures.delete(item.id);
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
			generation++;
		},
		stop() {
			queue = [];
			failures = new Map();
			enabled = false;
			generation++;
		},
	};
}

/** Custom message type of a delivered async result (the extension registers its renderer under it). */
export const RESULT_MESSAGE_TYPE = "brigadev-subagent-result";
export const CARD_BODY_LINES = 3;
/** Lines of each launch the collapsed card of a batch shows (a batch holds several launches). */
export const BATCH_CARD_LINES = 2;
/** The text of one delivered message stays within four per-task output caps: past it, later launches get a pointer to their saved folders. */
export const BATCH_TEXT_CAP = 4 * PER_TASK_OUTPUT_CAP;

export interface ResultMessageDetails {
	launchId: string;
	failed: boolean;
	/** Present when the message carries several launches (a batch), in message order. */
	launches?: { id: string; failed: boolean }[];
}

/**
 * The custom message injected into the parent: the launch id and the same text `subagent_wait` returns,
 * under a one-line header that also tells the model not to wait for it again.
 */
export function resultMessage(id: string, text: string, failed: boolean) {
	const header = `Async subagent launch ${id} ${failed ? "finished with errors" : "finished"}. Delivered automatically: it is already collected, so do not call subagent_wait for it.`;
	return { customType: RESULT_MESSAGE_TYPE, content: `${header}\n\n${text}`, display: true, details: { launchId: id, failed } satisfies ResultMessageDetails };
}

export interface BatchEntry {
	id: string;
	/** What `subagent_wait` would return for the launch. */
	text: string;
	failed: boolean;
	/** Stands in for `text` when the size cap is reached (see `omittedResultText`). */
	pointer: string;
}

const batchHeading = (id: string, failed: boolean) => `## Launch ${id}: ${failed ? "finished with errors" : "finished"}`;

/**
 * One message for every launch a flush delivers: how many results it holds, then each launch (settle order) under its
 * own heading with the text `subagent_wait` would return. A batch of one is exactly `resultMessage`. The texts are kept
 * whole in order until `cap` bytes; the first is never cut, and from the first one that does not fit, each launch gets its
 * `pointer` instead, so a message cannot explode.
 */
export function resultBatchMessage(entries: readonly BatchEntry[], cap: number = BATCH_TEXT_CAP) {
	if (entries.length === 0) throw new Error("resultBatchMessage needs at least one launch");
	if (entries.length === 1) return resultMessage(entries[0].id, entries[0].text, entries[0].failed);
	let used = 0;
	let overflowed = false;
	const sections = entries.map((entry, i) => {
		const size = Buffer.byteLength(entry.text, "utf8");
		if (i > 0 && (overflowed || used + size > cap)) {
			overflowed = true;
			return `${batchHeading(entry.id, entry.failed)}\n\n${entry.pointer}`;
		}
		used += size;
		return `${batchHeading(entry.id, entry.failed)}\n\n${entry.text}`;
	});
	const header = `${entries.length} async subagent results delivered automatically (${entries.map((e) => e.id).join(", ")}). They are already collected, so do not call subagent_wait for them.`;
	const details: ResultMessageDetails = { launchId: entries[0].id, failed: entries.some((e) => e.failed), launches: entries.map((e) => ({ id: e.id, failed: e.failed })) };
	return { customType: RESULT_MESSAGE_TYPE, content: `${header}\n\n${sections.join("\n\n")}`, display: true, details };
}

const savedFolderLines = (tasks: ReadonlyArray<{ agent: string; artifactsDir?: string }>): string[] =>
	tasks.length === 0 ? [] : ["Saved folders (the full text is in result.json):", ...tasks.map((t) => `- ${t.agent}: ${t.artifactsDir ?? "(no saved folder)"}`)];

/**
 * What stands in a batch message for a launch whose text did not fit under the size cap: the launch id, that the text
 * was left out, and each task's saved folder (run-artifacts.ts), so the full text can still be read.
 */
export function omittedResultText(id: string, tasks: ReadonlyArray<{ agent: string; artifactsDir?: string }>): string {
	return [`Launch ${id}: its full result was left out of this message to keep it short.`, ...savedFolderLines(tasks)].join("\n");
}

/**
 * What `subagent_wait` answers for a launch whose result the idle delivery already put in the session: the launch id,
 * that it was delivered, and each task's saved folder (run-artifacts.ts), so the full text can still be read. Not the result.
 */
export function alreadyDeliveredText(id: string, tasks: ReadonlyArray<{ agent: string; artifactsDir?: string }>): string {
	return [`Launch ${id} was already delivered to this session: its result is in the conversation above, so it is not repeated here.`, ...savedFolderLines(tasks)].join("\n");
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

const moreLines = (hidden: number, indent: string): CardLine => ({ text: `${indent}… ${hidden} more line${hidden === 1 ? "" : "s"}`, tone: "muted" });

/** The text of each launch of a batch message, found by the headings `resultBatchMessage` wrote; undefined when they are not all there. */
function batchTexts(body: string, launches: readonly { id: string; failed: boolean }[]): string[] | undefined {
	const headings = launches.map((l) => batchHeading(l.id, l.failed));
	const starts: number[] = [];
	let from = 0;
	for (const heading of headings) {
		const at = body.indexOf(heading, from);
		if (at < 0) return undefined;
		starts.push(at);
		from = at + heading.length;
	}
	return headings.map((heading, i) => body.slice(starts[i] + heading.length, starts[i + 1] ?? body.length).trim());
}

/**
 * Compact card for a delivered result: a header, then (collapsed) the first lines of the text and how many
 * more there are, or (expanded) only the header, because the renderer appends the whole text as markdown.
 * A batch gets a header with the count and, collapsed, a line per launch followed by its first lines.
 */
export function resultCard(content: string, details: ResultMessageDetails | undefined, expanded: boolean): { lines: CardLine[]; hidden: number; body: string } {
	const at = content.indexOf("\n\n");
	const body = (at >= 0 ? content.slice(at + 2) : content).trim();
	const launches = details?.launches;
	if (launches && launches.length > 1) {
		const failedCount = launches.filter((l) => l.failed).length;
		const header: CardLine = {
			text: failedCount > 0 ? `✗ ${launches.length} subagent results, ${failedCount} with errors (delivered)` : `✓ ${launches.length} subagent results (delivered)`,
			tone: failedCount > 0 ? "error" : "success",
		};
		const texts = batchTexts(body, launches);
		if (expanded || !texts) return { lines: [header], hidden: 0, body };
		const lines: CardLine[] = [header];
		let hidden = 0;
		launches.forEach((launch, i) => {
			lines.push({ text: `  ${launch.failed ? "✗" : "✓"} ${launch.id} ${launch.failed ? "finished with errors" : "finished"}`, tone: launch.failed ? "error" : "success" });
			const textLines = texts[i].split("\n");
			lines.push(...textLines.slice(0, BATCH_CARD_LINES).map((text): CardLine => ({ text: `    ${text}`, tone: "dim" })));
			const more = Math.max(0, textLines.length - BATCH_CARD_LINES);
			if (more > 0) lines.push(moreLines(more, "    "));
			hidden += more;
		});
		return { lines, hidden, body };
	}
	const failed = details?.failed ?? false;
	const lines: CardLine[] = [{ text: `${failed ? "✗" : "✓"} subagent ${details?.launchId ?? "launch"} ${failed ? "finished with errors" : "finished"} (delivered)`, tone: failed ? "error" : "success" }];
	const bodyLines = body.split("\n");
	if (expanded) return { lines, hidden: 0, body };
	lines.push(...bodyLines.slice(0, CARD_BODY_LINES).map((text): CardLine => ({ text: `  ${text}`, tone: "dim" })));
	const hidden = Math.max(0, bodyLines.length - CARD_BODY_LINES);
	if (hidden > 0) lines.push(moreLines(hidden, "  "));
	return { lines, hidden, body };
}
