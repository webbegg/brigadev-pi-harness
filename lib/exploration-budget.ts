/** Exploration budget: per-request count of parent lookups with one delegation notice. */

const LOOKUP_TOOLS = new Set(["read", "grep", "find", "ls"]);
const LOOKUP_LIMIT = 5;

export const EXPLORE_NOTICE =
	"[brigadev runtime] Exploration budget: 5 lookups (file tools or read-only shell commands) this request. If understanding still needs more, delegate one brigadev-explore (evidence budget trigger) instead of continuing to read.";

export const SHELL_READ_NOTICE =
	"[brigadev runtime] Use read, grep, find, or ls for files instead of bash: bash reads are invisible to the guard and reviewers, and cost a turn of output each.";

// Read-only shell commands count too: agents often read files with `cat` or
// `sed -n` instead of the read tool, and those reads cost the same context.
const SHELL_LOOKUPS = new Set(["cat", "head", "tail", "less", "more", "sed", "grep", "egrep", "rg", "ag", "find", "fd", "ls", "tree", "wc", "nl", "file", "stat", "du"]);

export function isLookupTool(name: string): boolean {
	return LOOKUP_TOOLS.has(name);
}

/** True when every command in a shell line only reads (cd segments aside). */
export function isShellLookup(command: string): boolean {
	if (/<</.test(command) || /(^|[^0-9&])>/.test(command)) return false;
	const segments = command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean);
	let reads = 0;
	for (const segment of segments) {
		const words = segment.split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
		const name = words[0]?.split("/").pop() ?? "";
		if (name === "cd") continue;
		if (!SHELL_LOOKUPS.has(name)) return false;
		if (name === "sed" && words.some((w) => w === "-i" || w.startsWith("-i"))) return false;
		if (name === "find" && words.some((w) => w === "-delete" || w === "-exec" || w === "-execdir")) return false;
		reads++;
	}
	return reads > 0;
}

export function createExplorationBudget() {
	let lookups = 0;
	let nudged = false;
	return {
		/** Returns the notice on the call that reaches the limit, otherwise undefined. */
		record(toolName: string, input?: { command?: unknown }): string | undefined {
			const lookup = isLookupTool(toolName) || (toolName === "bash" && typeof input?.command === "string" && isShellLookup(input.command));
			if (!lookup) return undefined;
			lookups += 1;
			return lookups === LOOKUP_LIMIT ? EXPLORE_NOTICE : undefined;
		},
		/** Returns the notice on the first read-only bash lookup of a request, otherwise undefined. */
		nudgeShellRead(toolName: string, input?: { command?: unknown }): string | undefined {
			if (nudged || toolName !== "bash" || typeof input?.command !== "string" || !isShellLookup(input.command)) return undefined;
			nudged = true;
			return SHELL_READ_NOTICE;
		},
		reset(): void {
			lookups = 0;
			nudged = false;
		},
	};
}
