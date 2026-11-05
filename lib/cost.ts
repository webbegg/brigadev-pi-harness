// API-equivalent cost accounting.
//
// pi-claude-bridge serves Claude Code on a Claude subscription and records
// every turn at $0. Pricing those turns at the Anthropic list price of the
// same model shows what the tokens would cost on the API. It is not what the
// subscription bills, but it is the honest number to compare workflows by.

export const CLAUDE_BRIDGE_PROVIDER = "claude-bridge";
export const LIST_PRICE_PROVIDER = "anthropic";

export interface UsageLike {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens?: number;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

export interface PricedMessageLike {
	role?: unknown;
	provider?: unknown;
	model?: unknown;
	usage?: UsageLike;
}

/** Prices `usage` in place for a catalog model; returns the new cost. */
export type CostCalculator = (provider: string, modelId: string, usage: UsageLike) => UsageLike["cost"] | undefined;

/**
 * Returns a copy of a zero-cost claude-bridge assistant message priced at the
 * list price, or undefined when it is not one (or the catalog has no price).
 * A bridge that reports its own non-zero cost wins.
 */
export function priceBridgeMessage<T extends PricedMessageLike>(message: T, calculate: CostCalculator): T | undefined {
	if (message.role !== "assistant" || message.provider !== CLAUDE_BRIDGE_PROVIDER || typeof message.model !== "string") return undefined;
	const usage = message.usage;
	if (!usage?.cost || usage.cost.total !== 0) return undefined;
	if (usage.input + usage.output + usage.cacheRead + usage.cacheWrite === 0) return undefined;
	const priced: UsageLike = { ...usage, cost: { ...usage.cost } };
	const cost = calculate(LIST_PRICE_PROVIDER, message.model, priced);
	if (!cost || !(cost.total > 0)) return undefined;
	priced.cost = { ...cost };
	return { ...message, usage: priced };
}

export interface Tally {
	turns: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export const emptyTally = (): Tally => ({ turns: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });

export function addUsage(tally: Tally, usage: Partial<UsageLike> | undefined, turns = 1): void {
	tally.turns += turns;
	tally.input += usage?.input ?? 0;
	tally.output += usage?.output ?? 0;
	tally.cacheRead += usage?.cacheRead ?? 0;
	tally.cacheWrite += usage?.cacheWrite ?? 0;
	tally.cost += usage?.cost?.total ?? 0;
}

/** Share of prompt tokens served from cache. */
export function cacheHitRate(t: Tally): number | undefined {
	const prompt = t.input + t.cacheRead + t.cacheWrite;
	return prompt > 0 ? t.cacheRead / prompt : undefined;
}

export function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
	return usd >= 1 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(usd >= 0.01 ? 3 : 4)}`;
}
