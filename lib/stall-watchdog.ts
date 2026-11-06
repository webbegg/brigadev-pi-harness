/**
 * Stall watchdog for child agent processes: pure timer logic with an injected
 * scheduler. A child that emits no event within the idle budget is stalled; while
 * a tool call is in flight (call seen, no result yet) the longer tool budget applies.
 */

export const DEFAULT_STALL_TIMEOUT_MS = 4 * 60_000;
export const DEFAULT_TOOL_STALL_TIMEOUT_MS = 30 * 60_000;

export interface StallTimeouts {
	stallTimeoutMs: number;
	toolStallTimeoutMs: number;
}

export interface StallInfo {
	minutes: number;
	lastStep: string;
}

export interface StallWatchdogOptions extends StallTimeouts {
	setTimer: (fn: () => void, ms: number) => unknown;
	clearTimer: (handle: unknown) => void;
	onStall: (info: StallInfo) => void;
}

export interface StallWatchdog {
	/** Arm the idle timer (call once when the child starts). */
	start(): void;
	/** Any event from the child: restart the budget and remember the step. */
	activity(step: string): void;
	/** A tool call was seen: the tool budget applies until it has a result. */
	toolStarted(id: string, step: string): void;
	/** The tool result arrived. Unknown ids are ignored. */
	toolFinished(id: string, step: string): void;
	/** Cancel the timer for good (child exited). */
	stop(): void;
}

const positiveMs = (raw: string | undefined, fallback: number): number => {
	const value = Number(raw);
	return raw?.trim() && Number.isFinite(value) && value > 0 ? value : fallback;
};

export function resolveStallTimeouts(env: Record<string, string | undefined>): StallTimeouts {
	return {
		stallTimeoutMs: positiveMs(env.BRIGADEV_STALL_TIMEOUT_MS, DEFAULT_STALL_TIMEOUT_MS),
		toolStallTimeoutMs: positiveMs(env.BRIGADEV_TOOL_STALL_TIMEOUT_MS, DEFAULT_TOOL_STALL_TIMEOUT_MS),
	};
}

export const stallMessage = (info: StallInfo): string => `stalled for ${info.minutes} min after: ${info.lastStep}`;

export function createStallWatchdog(options: StallWatchdogOptions): StallWatchdog {
	const inFlight = new Set<string>();
	let handle: unknown;
	let armed = false;
	let done = false;
	let lastStep = "start";

	const budget = () => (inFlight.size > 0 ? options.toolStallTimeoutMs : options.stallTimeoutMs);

	const arm = () => {
		if (done) return;
		if (armed) options.clearTimer(handle);
		const ms = budget();
		armed = true;
		handle = options.setTimer(() => {
			armed = false;
			done = true;
			options.onStall({ minutes: Number((ms / 60_000).toFixed(1)), lastStep });
		}, ms);
	};

	return {
		start: arm,
		activity(step) {
			lastStep = step;
			arm();
		},
		toolStarted(id, step) {
			inFlight.add(id);
			lastStep = step;
			arm();
		},
		toolFinished(id, step) {
			inFlight.delete(id);
			lastStep = step;
			arm();
		},
		stop() {
			done = true;
			if (armed) options.clearTimer(handle);
			armed = false;
		},
	};
}
