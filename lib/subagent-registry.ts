// Registry of async subagent launches. Pure: no Pi imports, and the clock,
// timers and id source are injected. Each launch runs under its own
// AbortController (not the tool call's signal, which ends with the call) and
// settles once. `wait` and `cancel` collect a result and mark it `consumed`, so
// a later delivery (idle notification) can skip what the model already has.
// `subscribe` emits start/progress/settle for delivery and the footer count.

export const MAX_SETTLED_LAUNCHES = 64;

export interface LaunchSummary {
	id: string;
	status: "running" | "settled";
	total: number;
	/** Tasks finished so far (the `N/M done` of a progress line). */
	done: number;
	startedAt: number;
	settledAt: number | undefined;
	/** Set once `wait` or `cancel` handed the result to the model. */
	consumed: boolean;
	/** Set when the launch body itself threw (not when a child failed: that is in the result). */
	error: string | undefined;
}

export type RegistryEvent<R = unknown> =
	| { type: "start"; launch: LaunchSummary }
	| { type: "progress"; launch: LaunchSummary }
	| { type: "settle"; launch: LaunchSummary; result?: R };

export type WaitOutcome<R> =
	| { status: "unknown" }
	| { status: "running"; launch: LaunchSummary }
	| { status: "settled"; launch: LaunchSummary; result?: R; error?: string };

export interface LaunchControl {
	progress: (done: number, total: number) => void;
}

export interface RegistryDeps {
	now?: () => number;
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	newId: () => string;
	maxSettled?: number;
}

export interface SubagentRegistry<R> {
	/** Starts the launch in the background and returns its id at once. */
	start(options: { total: number; run: (signal: AbortSignal, control: LaunchControl) => Promise<R> }): string;
	get(id: string): LaunchSummary | undefined;
	list(): LaunchSummary[];
	counts(): { running: number; settled: number };
	progress(id: string, done: number, total?: number): void;
	/** Blocks until the launch settles (and consumes it), the timeout elapses, or `signal` aborts (both leave it unconsumed). */
	wait(id: string, timeoutMs: number, signal?: AbortSignal): Promise<WaitOutcome<R>>;
	/** Aborts the launch, waits for its partial result, and consumes it. */
	cancel(id: string): Promise<WaitOutcome<R>>;
	/** Aborts every running launch (session shutdown). */
	abortAll(): void;
	/** Aborts every running launch and forgets all of them (session start). */
	clear(): void;
	subscribe(listener: (event: RegistryEvent<R>) => void): () => void;
}

interface Entry<R> {
	summary: LaunchSummary;
	controller: AbortController;
	settled: Promise<void>;
	result?: R;
	/** Order of settling, for pruning the oldest settled first. */
	seq: number;
}

export function createSubagentRegistry<R>(deps: RegistryDeps): SubagentRegistry<R> {
	const now = deps.now ?? Date.now;
	const maxSettled = deps.maxSettled ?? MAX_SETTLED_LAUNCHES;
	const entries = new Map<string, Entry<R>>();
	const listeners = new Set<(event: RegistryEvent<R>) => void>();
	let settleSeq = 0;

	const snapshot = (entry: Entry<R>): LaunchSummary => ({ ...entry.summary });
	const emit = (event: RegistryEvent<R>) => {
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// A listener bug must not break the launch it observes.
			}
		}
	};

	const prune = () => {
		const settled = [...entries.values()].filter((e) => e.summary.status === "settled").sort((a, b) => a.seq - b.seq);
		for (const entry of settled.slice(0, Math.max(0, settled.length - maxSettled))) entries.delete(entry.summary.id);
	};

	const outcome = (entry: Entry<R>): WaitOutcome<R> =>
		entry.summary.status === "settled"
			? { status: "settled", launch: snapshot(entry), ...(entry.summary.error === undefined ? { result: entry.result } : { error: entry.summary.error }) }
			: { status: "running", launch: snapshot(entry) };

	const consume = (entry: Entry<R>) => {
		entry.summary.consumed = true;
	};

	const registry: SubagentRegistry<R> = {
		start({ total, run }) {
			const id = deps.newId();
			const controller = new AbortController();
			const entry: Entry<R> = {
				summary: { id, status: "running", total, done: 0, startedAt: now(), settledAt: undefined, consumed: false, error: undefined },
				controller,
				settled: Promise.resolve(),
				seq: 0,
			};
			entries.set(id, entry);
			const finish = (result: R | undefined, error: string | undefined) => {
				// A cleared launch is forgotten: its late result goes nowhere.
				if (entries.get(id) !== entry) return;
				entry.result = result;
				entry.summary.status = "settled";
				entry.summary.settledAt = now();
				entry.summary.error = error;
				entry.seq = ++settleSeq;
				emit({ type: "settle", launch: snapshot(entry), ...(error === undefined ? { result } : {}) });
				prune();
			};
			// `start` goes out before the body runs, so a body that reports progress (or settles) synchronously
			// is still observed in order. The body itself is invoked synchronously, right here: writer admission relies on it.
			emit({ type: "start", launch: snapshot(entry) });
			entry.settled = new Promise<void>((resolve) => {
				const body = new Promise<R>((res) => res(run(controller.signal, { progress: (done, t) => registry.progress(id, done, t) })));
				body.then(
					(result) => (finish(result, undefined), resolve()),
					(error) => (finish(undefined, error instanceof Error ? error.message : String(error)), resolve()),
				);
			});
			return id;
		},

		get: (id) => {
			const entry = entries.get(id);
			return entry ? snapshot(entry) : undefined;
		},
		list: () => [...entries.values()].map(snapshot),
		counts() {
			const all = [...entries.values()];
			const running = all.filter((e) => e.summary.status === "running").length;
			return { running, settled: all.length - running };
		},

		progress(id, done, total) {
			const entry = entries.get(id);
			if (!entry || entry.summary.status !== "running") return;
			entry.summary.done = done;
			if (total !== undefined) entry.summary.total = total;
			emit({ type: "progress", launch: snapshot(entry) });
		},

		async wait(id, timeoutMs, signal) {
			const entry = entries.get(id);
			if (!entry) return { status: "unknown" };
			if (entry.summary.status === "running") {
				await new Promise<void>((resolve) => {
					let timer: unknown;
					const stop = () => {
						deps.clearTimer(timer);
						signal?.removeEventListener("abort", stop);
						resolve();
					};
					timer = deps.setTimer(stop, timeoutMs);
					signal?.addEventListener("abort", stop, { once: true });
					if (signal?.aborted) stop();
					else void entry.settled.then(stop);
				});
			}
			if (entry.summary.status === "settled") consume(entry);
			return outcome(entry);
		},

		async cancel(id) {
			const entry = entries.get(id);
			if (!entry) return { status: "unknown" };
			entry.controller.abort();
			await entry.settled;
			consume(entry);
			return outcome(entry);
		},

		abortAll() {
			for (const entry of entries.values()) if (entry.summary.status === "running") entry.controller.abort();
		},

		clear() {
			registry.abortAll();
			entries.clear();
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
	return registry;
}
