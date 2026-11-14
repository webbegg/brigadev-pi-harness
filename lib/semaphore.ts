// Counting semaphore shared by every subagent launch (sync and async), so the
// concurrency cap holds across concurrent launches. FIFO; a queued acquire
// honors an AbortSignal so a task cancelled before it starts never takes a slot.

export interface Semaphore {
	/** Resolves with an idempotent `release` once a slot is free; rejects with an AbortError if `signal` aborts first. */
	acquire(signal?: AbortSignal): Promise<() => void>;
	/** Slots in use. */
	readonly active: number;
	/** Acquires still waiting for a slot. */
	readonly waiting: number;
}

const abortError = (): Error => {
	const error = new Error("Aborted while waiting for a subagent slot");
	error.name = "AbortError";
	return error;
};

export function createSemaphore(limit: number): Semaphore {
	const max = Math.max(1, Math.floor(limit));
	let active = 0;
	const queue: Array<() => void> = [];

	const grant = (): (() => void) => {
		active++;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			active--;
			queue.shift()?.();
		};
	};

	return {
		acquire(signal) {
			if (signal?.aborted) return Promise.reject(abortError());
			if (active < max) return Promise.resolve(grant());
			return new Promise((resolve, reject) => {
				const waiter = () => {
					signal?.removeEventListener("abort", onAbort);
					resolve(grant());
				};
				const onAbort = () => {
					const at = queue.indexOf(waiter);
					if (at >= 0) queue.splice(at, 1);
					reject(abortError());
				};
				queue.push(waiter);
				signal?.addEventListener("abort", onAbort, { once: true });
			});
		},
		get active() {
			return active;
		},
		get waiting() {
			return queue.length;
		},
	};
}
