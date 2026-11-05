/**
 * brigadev ask_user_choice: one focused question with concrete options as a
 * real dialog instead of chat text. Adapted from Pi's official question
 * example; adds a recommended marker, number-key selection, and optional
 * free text. Parent session only (subagents return questions to the parent).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isChildSession } from "../lib/runtime.ts";

interface ChoiceDetails {
	question: string;
	options: string[];
	answer: string | null;
	wasCustom?: boolean;
}

const OptionSchema = Type.Object({
	label: Type.String(),
	description: Type.Optional(Type.String({ description: "Consequence or tradeoff" })),
});

const Params = Type.Object({
	question: Type.String(),
	options: Type.Array(OptionSchema, { description: "2-6 options" }),
	recommended: Type.Optional(Type.Number({ description: "1-based recommended option" })),
	allowOther: Type.Optional(Type.Boolean({ description: "Allow free text (default true)" })),
});

type DisplayOption = { label: string; description?: string; isOther?: boolean };

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	pi.registerTool({
		name: "ask_user_choice",
		label: "Ask",
		description:
			"Ask one focused question with concrete options as a dialog, for real product, design, or delivery decisions only.",
		parameters: Params,
		executionMode: "sequential",

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const labels = params.options.map((o) => o.label);
			const details = (answer: string | null, wasCustom?: boolean): ChoiceDetails => ({ question: params.question, options: labels, answer, wasCustom });

			if (ctx.mode !== "tui") {
				return {
					content: [{ type: "text", text: "No interactive UI: ask the question in your reply as a numbered list and stop until the user answers." }],
					details: details(null),
				};
			}
			if (params.options.length < 2) {
				return { content: [{ type: "text", text: "Error: give at least 2 options" }], details: details(null), isError: true };
			}

			const recommended = params.recommended && params.recommended >= 1 && params.recommended <= params.options.length ? params.recommended - 1 : -1;
			const allOptions: DisplayOption[] = [...params.options, ...(params.allowOther === false ? [] : [{ label: "Something else…", isOther: true }])];

			const result = await ctx.ui.custom<{ answer: string; wasCustom: boolean } | null>((tui, theme, _kb, done) => {
				let index = recommended >= 0 ? recommended : 0;
				let editing = false;
				let cached: string[] | undefined;
				const editorTheme: EditorTheme = {
					borderColor: (s) => theme.fg("accent", s),
					selectList: {
						selectedPrefix: (t) => theme.fg("accent", t),
						selectedText: (t) => theme.fg("accent", t),
						description: (t) => theme.fg("muted", t),
						scrollInfo: (t) => theme.fg("dim", t),
						noMatch: (t) => theme.fg("warning", t),
					},
				};
				const editor = new Editor(tui, editorTheme);
				const refresh = () => {
					cached = undefined;
					tui.requestRender();
				};
				editor.onSubmit = (value) => {
					const text = value.trim();
					if (text) done({ answer: text, wasCustom: true });
					else {
						editing = false;
						refresh();
					}
				};
				const choose = (i: number) => {
					if (allOptions[i].isOther) {
						editing = true;
						refresh();
					} else done({ answer: allOptions[i].label, wasCustom: false });
				};

				return {
					invalidate: () => {
						cached = undefined;
					},
					handleInput(data: string) {
						if (editing) {
							if (matchesKey(data, Key.escape)) {
								editing = false;
								editor.setText("");
								refresh();
								return;
							}
							editor.handleInput(data);
							refresh();
							return;
						}
						if (matchesKey(data, Key.up)) index = Math.max(0, index - 1);
						else if (matchesKey(data, Key.down)) index = Math.min(allOptions.length - 1, index + 1);
						else if (matchesKey(data, Key.enter)) return choose(index);
						else if (matchesKey(data, Key.escape)) return done(null);
						else if (/^[1-9]$/.test(data) && Number(data) <= allOptions.length) return choose(Number(data) - 1);
						else return;
						refresh();
					},
					render(width: number): string[] {
						if (cached) return cached;
						const w = Math.max(1, width);
						const lines: string[] = [];
						const wrap = (prefix: string, text: string) => {
							const pw = visibleWidth(prefix);
							const parts = wrapTextWithAnsi(text, Math.max(1, w - pw));
							parts.forEach((part, i) => lines.push(`${i === 0 ? prefix : " ".repeat(pw)}${part}`));
						};
						lines.push(theme.fg("accent", "─".repeat(w)));
						wrap(" ", theme.fg("text", theme.bold(params.question)));
						lines.push("");
						allOptions.forEach((opt, i) => {
							const selected = i === index;
							const marker = i === recommended ? theme.fg("success", " (recommended)") : "";
							wrap(selected ? theme.fg("accent", "› ") : "  ", theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + marker);
							if (opt.description) wrap("     ", theme.fg("muted", opt.description));
						});
						if (editing) {
							lines.push("");
							wrap(" ", theme.fg("muted", "Your answer:"));
							for (const line of editor.render(Math.max(1, w - 2))) lines.push(` ${line}`);
						}
						lines.push("");
						wrap(" ", theme.fg("dim", editing ? "Enter submit · Esc back" : "↑↓ or 1-9 · Enter select · Esc cancel"));
						lines.push(theme.fg("accent", "─".repeat(w)));
						cached = lines;
						return lines;
					},
				};
			});

			if (!result) return { content: [{ type: "text", text: "The user dismissed the question without answering. Stop and wait for them." }], details: details(null) };
			if (result.wasCustom) return { content: [{ type: "text", text: `The user answered: ${result.answer}` }], details: details(result.answer, true) };
			return { content: [{ type: "text", text: `The user chose: ${labels.indexOf(result.answer) + 1}. ${result.answer}` }], details: details(result.answer) };
		},

		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("ask ")) + theme.fg("muted", args.question ?? ""), 0, 0);
		},

		renderResult(result, _options, theme) {
			const d = result.details as ChoiceDetails | undefined;
			if (!d || d.answer === null) return new Text(theme.fg("warning", "No answer"), 0, 0);
			return new Text(theme.fg("success", "✓ ") + (d.wasCustom ? theme.fg("muted", "(wrote) ") : "") + theme.fg("accent", d.answer), 0, 0);
		},
	});
}
