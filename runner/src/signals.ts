// The runner's human gates as pi-durable signals (S4). Three kinds, each a typed JSON value delivered to the loop task under a key:
//   brigadev.answer  key `decision-<T#>-<round>`  the user's answer to a parked ticket decision
//   brigadev.pause   key `pause-<n>`              a request to pause at the next pick
//   brigadev.resume  key `resume-<n>`             lifts the pause the loop entered at epoch n
// A key serves one wait and is never reused (pi-durable rejects a second sleep on it), so each key carries a counter the loop
// keeps in its checkpoint. T6's merge approval reuses `deliver` and `signalLine` with a kind of its own.
import { defineSignal } from "@earendil-works/pi-durable";
import type { Harness, SignalResult, SignalToken, TaskId } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { bool, int, obj, opt, str } from "@earendil-works/pi-schema";

export const HOUR = 60 * 60 * 1000;
/** How long a question waits for its answer (S4 assumption). */
export const DECISION_DEADLINE_MS = 24 * HOUR;

/** The user's answer: the text (the chosen option's label, or free text), the 1-based option number when one was chosen, and an explicit approval. */
export const ANSWER = defineSignal({ name: "brigadev.answer", version: 1, schema: obj({ choice: str({ minLength: 1 }), option: opt(int({ minimum: 1 })), approve: opt(bool()) }) });
export const PAUSE = defineSignal({ name: "brigadev.pause", version: 1, schema: obj({ by: opt(str()) }) });
export const RESUME = defineSignal({ name: "brigadev.resume", version: 1, schema: obj({ by: opt(str()) }) });

export type Answer = { choice: string; option?: number; approve?: boolean };

export const decisionKey = (ticketId: string, round: number): string => `decision-${ticketId}-${round}`;
export const pauseKey = (epoch: number): string => `pause-${epoch}`;
export const resumeKey = (epoch: number): string => `resume-${epoch}`;

/**
 * Deliver a signal to a task in one commit. Unlike `Harness.signal()` this does not start the scheduler, so a process that only
 * hands an answer over (`brigadev-runner answer`) runs no task. Results: see `SignalResult`.
 */
export function deliver<T>(harness: Harness, taskId: TaskId, token: SignalToken<T>, key: string, value: T, context: Context): Promise<SignalResult> {
	return harness.commit((tx) => tx.signal(taskId, token, key, value), context);
}

/** Exit code of a delivery: delivered 0; duplicate, closed, and not_found are final answers (1); invalid is a usage error (2). */
export function signalExit(result: SignalResult): 0 | 1 | 2 {
	return result === "delivered" ? 0 : result === "invalid" ? 2 : 1;
}

/** `<result>: <what>`, the one line the CLI prints for a delivery. */
export const signalLine = (result: SignalResult, what: string): string => `${result}: ${what}`;
