/** Exploration budget: per-request count of parent lookups with one delegation notice. */

const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls"]);
const LOOKUP_LIMIT = 5;

export const EXPLORE_NOTICE =
	"[brigadev runtime] Exploration budget: 5 lookups this request. If understanding still needs more, delegate one brigadev-explore (trigger 2) instead of continuing to read.";

export function isLookupTool(name: string): boolean {
	return LOOKUP_TOOLS.has(name);
}

export function createExplorationBudget() {
	let lookups = 0;
	return {
		/** Returns the notice on the call that reaches the limit, otherwise undefined. */
		record(toolName: string): string | undefined {
			if (!isLookupTool(toolName)) return undefined;
			lookups += 1;
			return lookups === LOOKUP_LIMIT ? EXPLORE_NOTICE : undefined;
		},
		reset(): void {
			lookups = 0;
		},
	};
}
