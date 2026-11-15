// The text of background processes, as pure functions of snapshots (lib/bg-processes.ts): what the model reads from
// the tools, what the status line and the overlay (`/brigadev:ps`) show. No Pi imports; the clock is passed in.

import type { BgSnapshot } from "./bg-processes.ts";
import { listWidth, wrapText, type Row } from "./two-pane.ts";
import type { Tone } from "./shell-bar.ts";

/** What `bg_status` and an exit notice show of the output: the newest lines, within a byte bound. */
export const TAIL_LINES = 100;
export const TAIL_BYTES = 16 * 1024;
/** What the overlay keeps of the output (it is a viewer: more than the model gets). */
const DETAIL_LINES = 2000;
const DETAIL_BYTES = 256 * 1024;
const COMMAND_PREVIEW = 300;

/** `5s`, `1m05s`, `1h02m`. */
export function formatElapsed(ms: number): string {
	const total = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(total / 3600);
	const minutes = Math.floor((total % 3600) / 60);
	if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
	if (total >= 60) return `${minutes}m${String(total % 60).padStart(2, "0")}s`;
	return `${total}s`;
}

/**
 * Output as plain text for a person or a model: escape sequences (colors, cursor moves, window titles) removed,
 * a carriage return keeps only what was written last on its line (progress bars), other control characters dropped.
 */
export function sanitizeOutput(text: string): string {
	return text
		.replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
		.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\u001b[@-Z\\-_]/g, "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.split("\r").pop() ?? "")
		.join("\n")
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** The last `maxLines` lines within `maxBytes` (whole lines leave from the top; a single line longer than the bound is cut to its end), and how many lines were left out. */
export function tailOutput(text: string, options: { maxLines?: number; maxBytes?: number } = {}): { text: string; omittedLines: number } {
	const maxLines = options.maxLines ?? TAIL_LINES;
	const maxBytes = options.maxBytes ?? TAIL_BYTES;
	const trimmed = text.replace(/\n+$/, "");
	if (trimmed === "") return { text: "", omittedLines: 0 };
	const lines = trimmed.split("\n");
	let kept = lines.slice(-maxLines);
	let bytes = Buffer.byteLength(kept.join("\n"), "utf8");
	while (kept.length > 1 && bytes > maxBytes) {
		bytes -= Buffer.byteLength(kept[0], "utf8") + 1;
		kept = kept.slice(1);
	}
	let result = kept.join("\n");
	if (kept.length === 1 && bytes > maxBytes) {
		result = result.slice(-maxBytes);
		while (Buffer.byteLength(result, "utf8") > maxBytes) result = result.slice(1);
	}
	return { text: result, omittedLines: lines.length - kept.length };
}

const oneLine = (text: string, max: number): string => {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** How a process ended, in one word: `exit 2`, `SIGTERM`, `could not run`. */
function howItEnded(snap: BgSnapshot): string {
	if (snap.signal) return snap.signal;
	if (snap.exitCode !== undefined) return `exit ${snap.exitCode}`;
	return snap.error ? "could not run" : "no exit status";
}

/** `running for 12s`, `done (exit 0) after 3s`, `failed (exit 2) after 3s`, `killed (SIGTERM) after 3s`. */
export function stateLabel(snap: BgSnapshot, now: number): string {
	if (snap.state === "running") return `running for ${formatElapsed(now - snap.startedAt)}`;
	return `${snap.state} (${howItEnded(snap)}) after ${formatElapsed((snap.endedAt ?? now) - snap.startedAt)}`;
}

const head = (snap: BgSnapshot, label: string): string => `${snap.id} "${snap.name}": ${label}${snap.pid !== undefined ? ` (pid ${snap.pid})` : ""}`;

/** The output section of a status or an exit notice: a header saying how much is shown, then the tail. */
export function outputSection(snap: BgSnapshot, options: { maxLines?: number; maxBytes?: number } = {}): string[] {
	const tail = tailOutput(sanitizeOutput(snap.output), options);
	if (tail.text === "") return [`output: ${snap.state === "running" ? "(none yet)" : "(none)"}`];
	const shown = tail.text.split("\n").length;
	const count = tail.omittedLines > 0 ? `last ${shown} of ${shown + tail.omittedLines} lines` : `last ${shown} line${shown === 1 ? "" : "s"}`;
	return [`output (${count}${snap.truncatedBytes > 0 ? "; earlier output was dropped" : ""}):`, tail.text];
}

/** Everything `bg_status` says after its first line. */
function statusBody(snap: BgSnapshot): string[] {
	return [`command: ${oneLine(snap.command, COMMAND_PREVIEW)}`, `cwd: ${snap.cwd}`, ...(snap.error ? [`error: ${oneLine(snap.error, COMMAND_PREVIEW)}`] : []), ...outputSection(snap)];
}

/** The answer of `bg_start`: what started, and that the model should not poll. */
export function startedText(snap: BgSnapshot): string {
	return [
		`Started background process ${snap.id} "${snap.name}"${snap.pid !== undefined ? ` (pid ${snap.pid})` : ""} in ${snap.cwd}.`,
		`It has no stdin. You will get one message when it exits, so do not poll: bg_status ${snap.id} shows its output, bg_kill ${snap.id} stops it.`,
	].join("\n");
}

/** The answer of `bg_status`. */
export function statusText(snap: BgSnapshot, now: number): string {
	return [head(snap, stateLabel(snap, now)), ...statusBody(snap)].join("\n");
}

/** The answer of `bg_list`: one line per process. */
export function listText(snaps: readonly BgSnapshot[], now: number): string {
	if (snaps.length === 0) return "No background processes.";
	return snaps.map((snap) => `${head(snap, stateLabel(snap, now))}: ${oneLine(snap.command, 100)}`).join("\n");
}

/** The answer of `bg_kill`: the final state, or that the process was not running. */
export function killText(snap: BgSnapshot, now: number): string {
	const first = snap.state === "killed" ? `Killed ${snap.id} "${snap.name}": ${stateLabel(snap, now)}` : `${snap.id} "${snap.name}" was not running: ${stateLabel(snap, now)}`;
	return [first, ...statusBody(snap)].join("\n");
}

/** The one-line footer status, only while some process runs. */
export function statusLine(running: number): string | undefined {
	return running > 0 ? `bg: ${running} running` : undefined;
}

// ---- the overlay ----

export function psTitle(snaps: readonly BgSnapshot[]): string {
	if (snaps.length === 0) return "Background processes · none";
	const running = snaps.filter((s) => s.state === "running").length;
	return `Background processes · ${running} running · ${snaps.length - running} finished`;
}

const STATE_TONE: Record<BgSnapshot["state"], Tone> = { running: "text", done: "success", failed: "error", killed: "muted" };
const STATE_TAG: Record<BgSnapshot["state"], string> = { running: "run", done: "done", failed: "fail", killed: "kill" };

export function psRows(snaps: readonly BgSnapshot[], now: number): Row[] {
	return snaps.map((snap) => ({ text: `${snap.id} ${STATE_TAG[snap.state]} ${formatElapsed((snap.endedAt ?? now) - snap.startedAt)} ${snap.name}`, tone: STATE_TONE[snap.state] }));
}

/** Width of the detail pane for a full-screen two-pane layout of `width` columns (lib/two-pane.ts). */
export function detailWidth(width: number): number {
	const total = Math.max(20, width);
	return Math.max(10, total - listWidth(total) - 3);
}

/** The detail pane: the process's facts, then its output (cleaned, tabs expanded, wrapped to `width`). */
export function psDetail(snap: BgSnapshot, width: number, now: number): Row[] {
	const rows: Row[] = [];
	const add = (text: string, tone: Tone) => rows.push(...wrapText(text, width).map((line) => ({ text: line, tone })));
	add(`${snap.id} "${snap.name}"`, "accent");
	add(`${stateLabel(snap, now)}${snap.pid !== undefined ? ` (pid ${snap.pid})` : ""}`, STATE_TONE[snap.state]);
	add(`command: ${oneLine(snap.command, COMMAND_PREVIEW)}`, "dim");
	add(`cwd: ${snap.cwd}`, "dim");
	if (snap.error) add(`error: ${oneLine(snap.error, COMMAND_PREVIEW)}`, "error");
	rows.push({ text: "", tone: "text" });
	const tail = tailOutput(sanitizeOutput(snap.output), { maxLines: DETAIL_LINES, maxBytes: DETAIL_BYTES });
	if (snap.truncatedBytes > 0 || tail.omittedLines > 0) add("(earlier output was dropped)", "dim");
	if (tail.text === "") add(snap.state === "running" ? "(no output yet)" : "(no output)", "dim");
	else for (const line of tail.text.split("\n")) add(line.replace(/\t/g, "    "), "text");
	return rows;
}

export function psFooter(): string {
	return "j/k process · space/J/K scroll · g top · G follow the end · x kill · q close";
}
