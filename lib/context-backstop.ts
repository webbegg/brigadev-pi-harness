/** Context backstop: one notice per crossing of the handoff threshold. */

const TOKEN_CEILING = 150_000;

export interface ContextUsageLike {
	tokens: number | null;
	contextWindow: number;
}

export const BACKSTOP_NOTICE =
	"[brigadev runtime] Context backstop: this session's context is long. Hand the next multi-step unit to a fresh brigadev-worker (context backstop trigger) instead of continuing inline.";

export function backstopThreshold(contextWindow: number): number {
	return Math.min(TOKEN_CEILING, contextWindow * 0.5);
}

export function createContextBackstop() {
	let fired = false;
	return {
		/** Returns the notice the first time measured usage reaches the threshold, then undefined until re-armed. */
		check(usage: ContextUsageLike | undefined): string | undefined {
			if (fired || !usage || usage.tokens === null) return undefined;
			if (usage.tokens < backstopThreshold(usage.contextWindow)) return undefined;
			fired = true;
			return BACKSTOP_NOTICE;
		},
		rearm(): void {
			fired = false;
		},
	};
}
