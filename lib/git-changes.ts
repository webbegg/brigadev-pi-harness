// Working tree against HEAD: parse git's machine formats into change entries
// and color diff lines. Pure; the extension runs git.

import type { Tone } from "./shell-bar.ts";

export type ChangeStatus = "M" | "A" | "D" | "R" | "U";

export interface ChangeEntry {
	path: string;
	status: ChangeStatus;
	origPath?: string;
	added?: number;
	deleted?: number;
	binary?: boolean;
}

/** Parses `git status --porcelain=v1 -z --untracked-files=all`. */
export function parseStatus(output: string): ChangeEntry[] {
	const parts = output.split("\0").filter((p) => p.length > 0);
	const entries: ChangeEntry[] = [];
	for (let i = 0; i < parts.length; i++) {
		const record = parts[i];
		if (record.length < 4) continue;
		const xy = record.slice(0, 2);
		const path = record.slice(3);
		if (xy === "??") {
			entries.push({ path, status: "U" });
			continue;
		}
		if (xy.includes("R") || xy.includes("C")) {
			entries.push({ path, status: "R", origPath: parts[++i] });
			continue;
		}
		const status: ChangeStatus = xy.includes("D") ? "D" : xy.includes("A") ? "A" : "M";
		entries.push({ path, status });
	}
	return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/** Parses `git diff --numstat -z HEAD` into counts keyed by (new) path. */
export function parseNumstat(output: string): Map<string, { added?: number; deleted?: number; binary?: boolean }> {
	const counts = new Map<string, { added?: number; deleted?: number; binary?: boolean }>();
	const parts = output.split("\0");
	for (let i = 0; i < parts.length; i++) {
		const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(parts[i]);
		if (!match) continue;
		// Renames: "a\td\t" followed by old and new paths as separate fields.
		const path = match[3] === "" ? parts[(i += 2)] : match[3];
		const binary = match[1] === "-";
		counts.set(path, binary ? { binary } : { added: Number(match[1]), deleted: Number(match[2]) });
	}
	return counts;
}

export function withCounts(entries: readonly ChangeEntry[], counts: ReadonlyMap<string, { added?: number; deleted?: number; binary?: boolean }>): ChangeEntry[] {
	return entries.map((e) => ({ ...e, ...counts.get(e.path) }));
}

export function totals(entries: readonly ChangeEntry[]): { files: number; added: number; deleted: number } {
	return entries.reduce((t, e) => ({ files: t.files + 1, added: t.added + (e.added ?? 0), deleted: t.deleted + (e.deleted ?? 0) }), { files: 0, added: 0, deleted: 0 });
}

const STATUS_TONE: Record<ChangeStatus, Tone> = { M: "warning", A: "success", U: "success", D: "error", R: "accent" };
export const statusTone = (s: ChangeStatus): Tone => STATUS_TONE[s];

export function diffLineTone(line: string): Tone {
	if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("diff ") || line.startsWith("index ")) return "dim";
	if (line.startsWith("@@")) return "accent";
	if (line.startsWith("+")) return "success";
	if (line.startsWith("-")) return "error";
	return "text";
}

/** Line count as git counts it: a trailing newline does not start a new line. */
export function countLines(content: string): number {
	if (content === "") return 0;
	return content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
}

/** A new, untracked file shown as an all-added diff. */
export function untrackedAsDiff(path: string, content: string): string[] {
	const lines = content.split("\n");
	if (lines.at(-1) === "") lines.pop();
	return [`+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((l) => `+${l}`)];
}

export const DIFF_MAX_LINES = 20_000;
export const DIFF_MAX_BYTES = 1024 * 1024;

export function boundDiff(text: string): string[] {
	if (Buffer.byteLength(text, "utf8") > DIFF_MAX_BYTES) return ["Diff too large to show (over 1 MiB)."];
	const lines = text.replace(/\n$/, "").split("\n");
	return lines.length > DIFF_MAX_LINES ? [...lines.slice(0, DIFF_MAX_LINES), `… ${lines.length - DIFF_MAX_LINES} more lines`] : lines;
}
