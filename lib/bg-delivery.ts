// Idle-time delivery of the exit notice of a background process. No Pi imports: whether the parent is idle, how a
// message is handed to it, and what the model has already seen are injected, so tests drive it with fakes.
//
// The rule: an exit the model has not seen (`bg_status` of the settled process, a `bg_kill` it waited for) is
// delivered exactly once, at once when the parent is idle, otherwise held until the idle signal (`flush`, on
// `agent_settled`); everything held goes out as ONE message (one parent turn); a send that throws (a stale session
// context) is retried at the following idle signals, up to DELIVERY_ATTEMPTS, then given up with a notice.

import { outputSection, stateLabel } from "./bg-view.ts";
import type { BgSnapshot } from "./bg-processes.ts";

/** Custom message type of a delivered exit notice. */
export const BG_EXIT_MESSAGE_TYPE = "brigadev-bg-exit";
/** Send attempts per exit (the first one included) before it is given up, left unseen so `bg_status` can still report it. */
export const DELIVERY_ATTEMPTS = 3;
/** A notice carries the tail of each process's output, not all of it: the model can ask `bg_status` for more. */
const NOTICE_TAIL = { maxLines: 40, maxBytes: 8 * 1024 };

export interface BgExitDetails {
	processes: Array<{ id: string; name: string; state: BgSnapshot["state"]; exitCode: number | undefined; signal: string | undefined }>;
	/** Some process ended failed (killed on purpose is not a failure). */
	failed: boolean;
}

const finishedLine = (snap: BgSnapshot) => `${snap.id} "${snap.name}": ${stateLabel(snap, snap.endedAt ?? snap.startedAt)}`;

/**
 * The custom message injected into the parent: what ended and how, that it is already collected, and the output tail.
 * One process reads as a sentence; several share one header and get a section each, in the order given.
 */
export function bgExitMessage(snaps: readonly BgSnapshot[]) {
	if (snaps.length === 0) throw new Error("bgExitMessage needs at least one process");
	const details: BgExitDetails = {
		processes: snaps.map((s) => ({ id: s.id, name: s.name, state: s.state, exitCode: s.exitCode, signal: s.signal })),
		failed: snaps.some((s) => s.state === "failed"),
	};
	if (snaps.length === 1) {
		const [snap] = snaps;
		const header = `Background process ${snap.id} "${snap.name}" finished: ${stateLabel(snap, snap.endedAt ?? snap.startedAt)}. Delivered automatically: it is already collected, so do not call bg_status or bg_kill for it.`;
		return { customType: BG_EXIT_MESSAGE_TYPE, content: [header, "", ...outputSection(snap, NOTICE_TAIL)].join("\n"), display: true, details };
	}
	const header = `${snaps.length} background processes finished (${snaps.map((s) => s.id).join(", ")}). Delivered automatically: they are already collected, so do not call bg_status or bg_kill for them.`;
	const sections = snaps.map((snap) => [`## ${finishedLine(snap)}`, "", ...outputSection(snap, NOTICE_TAIL)].join("\n"));
	return { customType: BG_EXIT_MESSAGE_TYPE, content: [header, ...sections].join("\n\n"), display: true, details };
}

export interface BgDeliveryDeps {
	/** True when the parent agent is not in a run (a delivery would start a turn now). */
	isIdle: () => boolean;
	/** True when the model already saw this process's exit. */
	isConsumed: (id: string) => boolean;
	/** Records that the exit was delivered, so nothing repeats it. */
	markConsumed: (id: string) => void;
	/** Hands the message to the parent. A throw leaves the batch held for a retry at the next idle flush. */
	send: (message: ReturnType<typeof bgExitMessage>) => void;
	/** Called once per process when every attempt threw: its exit stays collectable with `bg_status`. */
	onDeliveryFailed?: (id: string, error: unknown) => void;
}

export interface BgDelivery {
	/** A process settled: deliver now when idle, else hold it. */
	settled(snapshot: BgSnapshot): void;
	/** The parent became idle: deliver everything held as one message, skipping what the model saw meanwhile. */
	flush(): void;
	/** Ids held and not yet delivered, in settle order. */
	held(): string[];
	isHeld(id: string): boolean;
	/** Forgets what is held and accepts exits again (session start). */
	reset(): void;
	/** Forgets what is held and ignores later exits (session shutdown stops the processes, which then settle). */
	stop(): void;
}

export function createBgDelivery(deps: BgDeliveryDeps): BgDelivery {
	let queue: BgSnapshot[] = [];
	let enabled = true;
	let flushing = false;
	// Failed sends per id.
	let failures = new Map<string, number>();

	const pass = () => {
		// A send may synchronously start a turn that flushes again: that is the same idle signal and does nothing.
		if (flushing || queue.length === 0 || !deps.isIdle()) return;
		flushing = true;
		// Whatever settles during the send lands in `queue` and waits for the next flush.
		const batch = queue.filter((snap) => enabled && !deps.isConsumed(snap.id));
		queue = [];
		try {
			if (batch.length === 0) return;
			try {
				deps.send(bgExitMessage(batch));
			} catch (error) {
				// Back in order, ahead of what settled meanwhile, until an exit has spent its attempts.
				const retry: BgSnapshot[] = [];
				for (const snap of batch) {
					const attempts = (failures.get(snap.id) ?? 0) + 1;
					if (attempts < DELIVERY_ATTEMPTS) {
						failures.set(snap.id, attempts);
						retry.push(snap);
					} else {
						failures.delete(snap.id);
						try {
							deps.onDeliveryFailed?.(snap.id, error);
						} catch {
							// The notice is best effort; the next exit still gets its own.
						}
					}
				}
				queue = [...retry, ...queue];
				return;
			}
			for (const snap of batch) {
				failures.delete(snap.id);
				deps.markConsumed(snap.id);
			}
		} finally {
			flushing = false;
		}
	};

	return {
		settled(snapshot) {
			if (!enabled || deps.isConsumed(snapshot.id) || queue.some((q) => q.id === snapshot.id)) return;
			queue.push(snapshot);
			pass();
		},
		flush: pass,
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
