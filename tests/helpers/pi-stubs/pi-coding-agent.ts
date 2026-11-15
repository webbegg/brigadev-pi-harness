// TEST-ONLY stub of `@earendil-works/pi-coding-agent` (a Pi runtime package that is not installed in this repo).
// Only the values extensions/subagents.ts and lib/pi-adapters.ts import.

import { homedir } from "node:os";
import { join } from "node:path";

export const getMarkdownTheme = () => ({});

/** Pi's agent dir; the harness's own `PI_CODING_AGENT_DIR` override applies, so tests can point it at a temp dir. */
export const getAgentDir = (): string => process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");

/**
 * Frontmatter of an agent file: `key: value` lines between `---` fences, with `true`/`false` as booleans and
 * surrounding quotes removed. Enough for assets/agents/*.md; not YAML.
 */
export function parseFrontmatter<T extends Record<string, unknown>>(content: string): { frontmatter: T; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { frontmatter: {} as T, body: content };
	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const raw = line.slice(at + 1).trim();
		frontmatter[line.slice(0, at).trim()] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^(["'])(.*)\1$/, "$2");
	}
	return { frontmatter: frontmatter as T, body: match[2] };
}
