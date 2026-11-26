// ask_user_choice for a client that drives Pi over RPC (T3 Code, any `pi --mode rpc` front end): it cannot show the TUI
// component, so the question becomes Pi's standard dialogs: a select of numbered option lines (descriptions inline, the
// recommended one marked, the free-text entry last), then an input when the user picks the free-text entry.

import type { ChoiceAnswer } from "./human-prompt.ts";

export const OTHER_LABEL = "Something else…";

export interface ChoiceOption {
	label: string;
	description?: string;
}

/** The select's lines: `1. label — description`, ` (recommended)` on the recommended one (0-based), the free-text entry last unless `allowOther` is false. */
export function choiceDialogLines(options: readonly ChoiceOption[], recommended: number, allowOther: boolean | undefined): string[] {
	const lines = options.map((option, i) => `${i + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}${i === recommended ? " (recommended)" : ""}`);
	if (allowOther !== false) lines.push(`${options.length + 1}. ${OTHER_LABEL}`);
	return lines;
}

/** What a picked line means: an option (by its index), the free-text entry, or nothing (a line that is not one of ours). */
export function choiceOfLine(line: string | undefined, lines: readonly string[], options: readonly ChoiceOption[]): { option: number } | "other" | undefined {
	const index = line === undefined ? -1 : lines.indexOf(line);
	if (index < 0) return undefined;
	return index < options.length ? { option: index } : "other";
}

/** The part of Pi's ctx.ui the dialogs use. */
export interface DialogHost {
	select(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	input(title: string, placeholder?: string, opts?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/** Asks with the standard dialogs; null when dismissed (or `signal` aborts), or for an empty free-text answer. */
export async function askWithDialogs(ui: DialogHost, question: string, options: readonly ChoiceOption[], recommended: number, allowOther: boolean | undefined, signal: AbortSignal): Promise<ChoiceAnswer | null> {
	const lines = choiceDialogLines(options, recommended, allowOther);
	const picked = choiceOfLine(await ui.select(question, lines, { signal }), lines, options);
	if (picked === undefined || signal.aborted) return null;
	if (picked !== "other") return { answer: options[picked.option].label, wasCustom: false };
	const text = (await ui.input(question, "Your answer", { signal }))?.trim();
	return text && !signal.aborted ? { answer: text, wasCustom: true } : null;
}
