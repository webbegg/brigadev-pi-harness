// Full-screen two-pane layout shared by the Changes and Agents viewers:
// title row, a selectable list on the left, a scrollable detail pane on the
// right, and a key-hint footer. Pure: painting, width measuring, and
// truncation are supplied by the caller.

import type { Tone } from "./shell-bar.ts";

export interface Row {
	text: string;
	tone?: Tone;
}

export interface Painter {
	paint(tone: Tone, text: string): string;
	bold(text: string): string;
	measure(text: string): number;
	/** Truncates to a visible width, without padding. */
	truncate(text: string, width: number): string;
}

export interface TwoPaneInput {
	width: number;
	height: number;
	title: string;
	list: Row[];
	selected: number;
	detail: Row[];
	detailScroll: number;
	footer: string;
	/** Hide the list and give the detail the full width. */
	detailOnly?: boolean;
	empty?: string;
}

/** First visible index so that `selected` stays on screen. */
export function windowStart(selected: number, total: number, visible: number): number {
	if (total <= visible) return 0;
	return Math.max(0, Math.min(selected - Math.floor(visible / 2), total - visible));
}

export function maxScroll(total: number, visible: number): number {
	return Math.max(0, total - visible);
}

/** Wraps plain text to a width, breaking on spaces where possible. */
export function wrapText(text: string, width: number): string[] {
	if (width <= 0) return [text];
	const out: string[] = [];
	for (const raw of text.split("\n")) {
		let line = raw;
		while (line.length > width) {
			const cut = line.lastIndexOf(" ", width);
			const at = cut > width / 3 ? cut : width;
			out.push(line.slice(0, at));
			line = line.slice(at).replace(/^ /, "");
		}
		out.push(line);
	}
	return out;
}

export function listWidth(width: number): number {
	return Math.max(18, Math.min(48, Math.floor(width * 0.34)));
}

/** Cuts `text` to `width` columns and fills the rest with spaces. */
export function pad(p: Painter, text: string, width: number): string {
	const cut = p.truncate(text, width);
	return cut + " ".repeat(Math.max(0, width - p.measure(cut)));
}

export function renderTwoPane(input: TwoPaneInput, p: Painter): string[] {
	const width = Math.max(20, input.width);
	const bodyHeight = Math.max(1, input.height - 3);
	const lines: string[] = [];
	lines.push(pad(p, p.paint("accent", p.bold(` ${input.title}`)), width));
	lines.push(p.paint("borderMuted", "─".repeat(width)));

	const leftW = input.detailOnly ? 0 : listWidth(width);
	const rightW = input.detailOnly ? width : width - leftW - 3;
	const start = windowStart(input.selected, input.list.length, bodyHeight);
	const scroll = Math.min(input.detailScroll, maxScroll(input.detail.length, bodyHeight));

	for (let i = 0; i < bodyHeight; i++) {
		const right = input.detail[scroll + i];
		const rightText = right ? p.paint(right.tone ?? "text", p.truncate(right.text, rightW)) : "";
		if (input.detailOnly) {
			lines.push(pad(p, ` ${rightText}`, width));
			continue;
		}
		const index = start + i;
		const row = input.list[index];
		let left = "";
		if (row) {
			const selected = index === input.selected;
			const marker = selected ? p.paint("accent", "›") : " ";
			left = `${marker} ${p.paint(selected ? "accent" : (row.tone ?? "text"), p.truncate(row.text, leftW - 2))}`;
		} else if (i === 0 && input.list.length === 0) left = p.paint("dim", `  ${input.empty ?? "Nothing here"}`);
		lines.push(`${pad(p, left, leftW)} ${p.paint("borderMuted", "│")} ${rightText}`);
	}
	lines.push(pad(p, p.paint("dim", ` ${input.footer}`), width));
	return lines.map((l) => p.truncate(l, width));
}
