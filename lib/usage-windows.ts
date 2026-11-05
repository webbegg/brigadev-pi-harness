// Claude subscription usage windows, from the anthropic-ratelimit-unified-*
// headers that Anthropic sends and claude-bridge rebuilds from Claude Code's
// usage events. Utilization is a fraction (0..1); resets are Unix seconds.

const PREFIX = "anthropic-ratelimit-unified-";

export interface UsageWindow {
	name: string;
	utilization: number;
	resetsAt?: number;
}

export interface UsageSnapshot {
	status?: string;
	/** The window that currently binds, e.g. "seven_day". */
	claim?: string;
	overageStatus?: string;
	resetsAt?: number;
	windows: UsageWindow[];
	observedAt: number;
}

const WINDOW_LABEL: Record<string, string> = { "5h": "5h", "7d": "week", "7d_oi": "week+", "7d_opus": "opus wk", "7d_sonnet": "sonnet wk" };

export function parseUsageHeaders(headers: Record<string, string | undefined> | undefined, now: number): UsageSnapshot | undefined {
	if (!headers) return undefined;
	const get = (name: string) => headers[`${PREFIX}${name}`];
	const keys = Object.keys(headers).filter((k) => k.startsWith(PREFIX));
	if (keys.length === 0) return undefined;
	const num = (v: string | undefined) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : undefined);
	const windows: UsageWindow[] = [];
	for (const key of keys) {
		const match = /^anthropic-ratelimit-unified-(.+)-utilization$/.exec(key);
		if (!match) continue;
		const utilization = num(headers[key]);
		if (utilization === undefined) continue;
		windows.push({ name: match[1], utilization, resetsAt: num(get(`${match[1]}-reset`)) });
	}
	windows.sort((a, b) => a.name.localeCompare(b.name));
	return { status: get("status"), claim: get("representative-claim"), overageStatus: get("overage-status"), resetsAt: num(get("reset")), windows, observedAt: now };
}

export function windowLabel(name: string): string {
	return WINDOW_LABEL[name] ?? name;
}

/** Compact bar text such as "week 55%" or "5h 92% · week 55%". */
export function formatUsage(snapshot: UsageSnapshot): string {
	if (snapshot.status === "rejected") return `limit reached${snapshot.claim ? ` (${snapshot.claim})` : ""}`;
	return snapshot.windows.map((w) => `${windowLabel(w.name)} ${Math.round(w.utilization * 100)}%`).join(" · ");
}

export function usageTone(snapshot: UsageSnapshot): "muted" | "warning" | "error" {
	const top = Math.max(0, ...snapshot.windows.map((w) => w.utilization));
	if (snapshot.status === "rejected" || top >= 0.95) return "error";
	return top >= 0.8 ? "warning" : "muted";
}

/**
 * When the whole provider is out of quota: the unified status is rejected and
 * no Extra Usage is serving requests. Returns the reset time (ms), or
 * undefined while requests still go through. A reset already in the past is
 * stale and never blocks.
 */
export function spentUntil(snapshot: UsageSnapshot | undefined, now: number): number | undefined {
	if (!snapshot || snapshot.status !== "rejected" || snapshot.overageStatus === "allowed") return undefined;
	const resetMs = snapshot.resetsAt ? snapshot.resetsAt * 1000 : undefined;
	if (resetMs !== undefined && resetMs <= now) return undefined;
	return resetMs ?? now + 30 * 60_000;
}
