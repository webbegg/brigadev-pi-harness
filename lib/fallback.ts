// Model fallback chains: when a run fails for a reason another model can get
// past (quota, auth, rate limit, provider trouble, timeout, network), move to
// the next model the profile lists. Failures another model would hit the
// same way (context length, invalid request, abort) never fall back.

export type FailureCategory = "quota" | "auth" | "rate_limit" | "provider_unavailable" | "timeout" | "network";

const NO_FALLBACK = [/context (length|window)|too many tokens|prompt is too long|maximum context/i, /invalid_request|invalid request/i];
const CATEGORIES: Array<[FailureCategory, RegExp]> = [
	["quota", /quota exceeded|usage limit|exceeded your (current )?quota|credit balance|insufficient_quota|billing|subscription rate limit|rate limit \((five_hour|seven_day)/i],
	["auth", /\b401\b|\b403\b|unauthori[sz]ed|authentication|invalid (api )?key|oauth|not logged in|please (log|sign) in/i],
	["rate_limit", /\b429\b|rate.?limit|too many requests/i],
	["provider_unavailable", /\b5\d\d\b|overloaded|unavailable|internal server error|bad gateway/i],
	["timeout", /timed? ?out|timeout|deadline exceeded/i],
	["network", /econnreset|econnrefused|enotfound|eai_again|socket hang up|fetch failed|network/i],
];

export function classifyFailure(stopReason: string | undefined, errorMessage: string | undefined): FailureCategory | undefined {
	if (stopReason === "aborted" || stopReason !== "error") return undefined;
	const text = errorMessage ?? "";
	if (NO_FALLBACK.some((p) => p.test(text))) return undefined;
	return CATEGORIES.find(([, p]) => p.test(text))?.[0];
}

/** How long a failed model is skipped by every agent of the session. */
export function cooldownMs(category: FailureCategory): number {
	return category === "quota" || category === "auth" ? 30 * 60_000 : 2 * 60_000;
}

export class Cooldowns {
	private until = new Map<string, number>();

	cool(model: string, untilMs: number): void {
		this.until.set(model, Math.max(untilMs, this.until.get(model) ?? 0));
	}

	isCooling(model: string, now: number): boolean {
		return (this.until.get(model) ?? 0) > now;
	}

	coolingUntil(model: string): number | undefined {
		return this.until.get(model);
	}
}

export interface ChainStep {
	model: string;
	thinking?: string;
}

/**
 * Orders the chain for a launch: the primary, then fallbacks, deduplicated.
 * Steps whose model (or whole provider) is cooling move behind the usable
 * ones, so a launch starts on the first usable model instead of failing
 * first. If everything is cooling, the original order stays.
 */
export function launchOrder(primary: ChainStep, fallbacks: readonly ChainStep[], isCooling: (model: string) => boolean): ChainStep[] {
	const seen = new Set<string>();
	const chain = [primary, ...fallbacks].filter((s) => s.model && !seen.has(s.model) && (seen.add(s.model), true));
	const usable = chain.filter((s) => !isCooling(s.model));
	return usable.length === 0 ? chain : [...usable, ...chain.filter((s) => isCooling(s.model))];
}

export function providerOf(model: string): string | undefined {
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

/** "(2.0x the price)" when the next model costs noticeably more; blended over input and output. */
export function priceNote(from: { input: number; output: number } | undefined, to: { input: number; output: number } | undefined): string {
	if (!from || !to) return "";
	const blended = (c: { input: number; output: number }) => c.input + c.output;
	if (!(blended(from) > 0)) return "";
	const ratio = blended(to) / blended(from);
	return ratio >= 1.05 ? ` (${(Math.round(ratio * 10) / 10).toFixed(1)}x the price)` : "";
}
