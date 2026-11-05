// Pure helpers for the command palette: entry normalization, search ranking,
// and selection movement. No pi or TUI imports.

export interface PaletteEntry {
	name: string;
	description: string;
}

export const PALETTE_COMMAND = "brigadev:commands";
const PREFIX = "brigadev:";

/**
 * Keep brigadev commands and the package's own prompt templates (`/review`,
 * `/track`), minus the palette itself, deduplicated and sorted by name.
 * `isOwnPrompt` receives a prompt template's source path; without it no
 * prompt template is listed.
 */
export function normalizeEntries(raw: readonly unknown[], isOwnPrompt?: (sourcePath: string) => boolean): PaletteEntry[] {
	const byName = new Map<string, PaletteEntry>();
	for (const item of raw) {
		if (!item || typeof item !== "object") continue;
		const { name, description, source, sourceInfo } = item as { name?: unknown; description?: unknown; source?: unknown; sourceInfo?: { path?: unknown } };
		if (typeof name !== "string") continue;
		const bare = name.replace(/^\//, "");
		const ownPrompt = source === "prompt" && typeof sourceInfo?.path === "string" && !!isOwnPrompt?.(sourceInfo.path);
		if (!(bare.startsWith(PREFIX) || ownPrompt) || bare === PALETTE_COMMAND || byName.has(bare)) continue;
		byName.set(bare, { name: bare, description: typeof description === "string" ? description : "" });
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every whitespace-separated token must appear in name or description; name hits rank first. */
export function filterEntries(entries: readonly PaletteEntry[], query: string): PaletteEntry[] {
	const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
	if (!tokens.length) return [...entries];
	const ranked: { entry: PaletteEntry; rank: number; index: number }[] = [];
	entries.forEach((entry, index) => {
		const name = entry.name.toLowerCase();
		const description = entry.description.toLowerCase();
		let rank = 0;
		for (const token of tokens) {
			const bare = name.startsWith(PREFIX) ? name.slice(PREFIX.length) : name;
			if (bare.startsWith(token)) rank += 0;
			else if (name.includes(token)) rank += 1;
			else if (description.includes(token)) rank += 2;
			else return;
		}
		ranked.push({ entry, rank, index });
	});
	return ranked.sort((a, b) => a.rank - b.rank || a.index - b.index).map((r) => r.entry);
}

export function clampSelection(index: number, length: number): number {
	return Math.max(0, Math.min(length - 1, index));
}

export function moveSelection(index: number, delta: number, length: number): number {
	return clampSelection(index + delta, length);
}

/** The slash command line Enter runs. */
export function commandLine(entry: PaletteEntry): string {
	return `/${entry.name}`;
}
