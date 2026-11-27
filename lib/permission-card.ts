// The guard's permission card in the TUI: a bordered panel, colored by the risk level, with the short part always shown
// (the action, what happens, why, the risk in one line, the command) and the full WHAT IT WILL DO / RISK sections behind `d`.
// Rendering and keys are pure (`renderPermissionCard`, `cardKey`) so tests can check them without a terminal.

import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import type { PermissionAnswer } from "./human-prompt.ts";
import { SESSION_LABEL, type PermissionCard, type RiskLevel } from "./permission-dialog.ts";

export type CardTone = "error" | "warning" | "success" | "accent" | "muted" | "dim" | "text";

export interface CardPainter {
	paint(tone: CardTone, text: string): string;
	bold(text: string): string;
	/** Terminal columns of plain text. */
	measure(text: string): number;
}

export interface CardState {
	expanded: boolean;
	/** Index into `cardOptions(card)`. */
	choice: number;
}

export type CardKey = "up" | "down" | "left" | "right" | "tab" | "enter" | "escape" | "yes" | "no" | "session" | "details";

/** The answers, in order: Yes, the session yes when the card offers it, No. */
export function cardOptions(card: PermissionCard): Array<{ label: string; answer: PermissionAnswer }> {
	return [{ label: "Yes", answer: "yes" }, ...(card.sessionActions ? [{ label: SESSION_LABEL, answer: "session" as const }] : []), { label: "No", answer: "no" }];
}

/** The next state, or the answer (null: dismissed, Esc). `s` answers the session yes only when the card offers it. */
export function cardKey(card: PermissionCard, state: CardState, key: CardKey): { state: CardState } | { answer: PermissionAnswer | null } {
	const options = cardOptions(card);
	const move = (step: number) => ({ state: { ...state, choice: (state.choice + step + options.length) % options.length } });
	switch (key) {
		case "up":
		case "left":
			return move(-1);
		case "down":
		case "right":
		case "tab":
			return move(1);
		case "details":
			return { state: { ...state, expanded: !state.expanded } };
		case "enter":
			return { answer: options[Math.min(state.choice, options.length - 1)].answer };
		case "yes":
			return { answer: "yes" };
		case "no":
			return { answer: "no" };
		case "session":
			return card.sessionActions ? { answer: "session" } : { state };
		case "escape":
			return { answer: null };
	}
}

export const LEVEL_TONE: Record<RiskLevel, CardTone> = { High: "error", Medium: "warning", Low: "success" };
const HEADER = "brigadev · Needs your permission";
const HINT = "↑↓ choose · enter answer · d details · esc no";
/** Narrower than this, the border is dropped: the text matters more than the frame. */
const MIN_BOX_WIDTH = 30;

/** Plain text wrapped to `width` columns; a word longer than the line is cut. `indent` starts every line after the first. */
export function wrapPlain(text: string, width: number, measure: (text: string) => number, indent = ""): string[] {
	const room = Math.max(1, width);
	const lines: string[] = [];
	let line = "";
	const push = () => {
		lines.push(line);
		line = indent;
	};
	for (const word of text.split(/(\s+)/)) {
		if (word === "") continue;
		if (measure(line + word) <= room) {
			line += word;
			continue;
		}
		if (/^\s+$/.test(word)) {
			push();
			continue;
		}
		if (line.trim() !== "") push();
		for (const ch of Array.from(word)) {
			if (measure(line + ch) > room && line.trim() !== "") push();
			line += ch;
		}
	}
	if (line.trim() !== "" || lines.length === 0) lines.push(line);
	return lines.map((l) => l.trimEnd());
}

interface Row {
	/** Plain text; wrapped, then painted. */
	text: string;
	tone?: CardTone;
	bold?: boolean;
	/** A painted label in front of the first line (its width is kept on the next ones). */
	label?: { text: string; tone: CardTone };
	/** Plain prefix kept on every wrapped line (the details gutter). */
	gutter?: { text: string; tone: CardTone };
}

/** The card's lines for a terminal `width` columns wide: the panel, then the question and the Yes/No below it. */
export function renderPermissionCard(card: PermissionCard, state: CardState, width: number, painter: CardPainter): string[] {
	const { paint, bold, measure } = painter;
	const border = LEVEL_TONE[card.level];
	const boxed = width >= MIN_BOX_WIDTH;
	// "│  " + text + " │"
	const inner = boxed ? width - 5 : Math.max(1, width - 1);

	const rows: Row[] = [];
	const blank = () => rows.push({ text: "" });
	blank();
	rows.push({ text: card.heading, tone: "text", bold: true });
	blank();
	rows.push({ text: card.summary, tone: "text" });
	blank();
	rows.push({ label: { text: "Why    ", tone: "muted" }, text: card.why, tone: card.whyGiven ? "text" : "warning" });
	rows.push({ label: { text: "Risk   ", tone: "muted" }, text: `● ${card.level} · ${card.risk}`, tone: border });
	blank();
	for (const line of card.subject) rows.push({ text: line, tone: "accent" });
	if (card.extra) {
		blank();
		for (const line of card.extra.split("\n")) rows.push({ text: line, tone: "warning" });
	}
	blank();
	rows.push({ text: state.expanded ? "▾ Hide details  (d)" : "▸ Show details  (d)", tone: "muted" });
	if (state.expanded) {
		for (const line of card.details.split("\n")) {
			const heading = /^[A-Z][A-Z ]+(\s+●.*)?$/.test(line);
			rows.push({ gutter: { text: "┊ ", tone: "dim" }, text: line, tone: heading ? "text" : "muted", bold: heading });
		}
	}
	blank();

	const out: string[] = [];
	const frame = (painted: string, plainWidth: number) => {
		if (!boxed) return out.push(painted);
		out.push(`${paint(border, "│")}  ${painted}${" ".repeat(Math.max(0, inner - plainWidth))} ${paint(border, "│")}`);
	};
	for (const row of rows) {
		const label = row.label?.text ?? "";
		const gutter = row.gutter?.text ?? "";
		const lead = measure(label) + measure(gutter);
		// A details line keeps its own indentation on the lines it wraps to.
		const indent = row.gutter ? (/^\s*/.exec(row.text)?.[0] ?? "") + "  " : "";
		const parts = row.text === "" ? [""] : wrapPlain(row.text, inner - lead, measure, indent);
		parts.forEach((part, index) => {
			const head = row.label ? (index === 0 ? paint(row.label.tone, label) : " ".repeat(measure(label))) : "";
			const gut = row.gutter ? paint(row.gutter.tone, gutter) : "";
			const body = part === "" ? "" : paint(row.tone ?? "text", row.bold ? bold(part) : part);
			frame(head + gut + body, lead + measure(part));
		});
	}

	if (boxed) {
		const title = ` ${HEADER} `;
		const fill = Math.max(0, width - 3 - measure(title));
		out.unshift(paint(border, "╭─") + paint(border, bold(title)) + paint(border, `${"─".repeat(fill)}╮`));
		out.push(paint(border, `╰${"─".repeat(Math.max(0, width - 2))}╯`));
	}
	const room = Math.max(1, width - 5);
	for (const line of wrapPlain(card.question, room, measure)) out.push(`   ${paint("text", bold(line))}`);
	cardOptions(card).forEach(({ label, answer }, index) => {
		const selected = index === state.choice;
		const key = answer === "session" ? "  (s)" : "";
		wrapPlain(label + key, room, measure).forEach((line, i) => out.push(`   ${i === 0 && selected ? paint("accent", "› ") : "  "}${paint(selected ? "accent" : "muted", selected ? bold(line) : line)}`));
		// The session yes says what it covers while it is the one picked.
		if (selected && answer === "session" && card.sessionActions) {
			for (const line of wrapPlain(`Stops asking about: ${card.sessionActions.join(", ")}. Until the session ends; the PR gate still asks when it finds a problem.`, room - 2, measure)) out.push(`       ${paint("dim", line)}`);
		}
	});
	for (const line of wrapPlain(card.sessionActions ? HINT.replace(" · esc", " · s session · esc") : HINT, room, measure)) out.push(`   ${paint("dim", line)}`);
	return out;
}

/** The raw terminal input as a card key; undefined for any other key. */
function keyOf(data: string): CardKey | undefined {
	if (matchesKey(data, Key.up)) return "up";
	if (matchesKey(data, Key.down)) return "down";
	if (matchesKey(data, Key.left)) return "left";
	if (matchesKey(data, Key.right)) return "right";
	if (matchesKey(data, Key.tab)) return "tab";
	if (matchesKey(data, Key.enter)) return "enter";
	if (matchesKey(data, Key.escape)) return "escape";
	if (data === "y" || data === "Y") return "yes";
	if (data === "n" || data === "N") return "no";
	if (data === "d" || data === "D") return "details";
	if (data === "s" || data === "S") return "session";
	return undefined;
}

interface CardTheme {
	fg(tone: CardTone, text: string): string;
	bold(text: string): string;
}

/** The part of Pi's `ctx.ui` the card uses. */
export interface CardHost {
	custom<T>(
		factory: (tui: { requestRender(): void }, theme: CardTheme, keybindings: unknown, done: (result: T) => void) => { render(width: number): string[]; handleInput(data: string): void; invalidate(): void },
		options?: { blocked?: { kind: "permission"; message: string } },
	): Promise<T>;
}

/** Shows the card and resolves with the answer, or null (Esc, or `signal` aborted, which closes it). */
export function showPermissionCard(ui: CardHost, title: string, card: PermissionCard, signal?: AbortSignal): Promise<PermissionAnswer | null> {
	if (signal?.aborted) return Promise.resolve(null);
	return ui.custom<PermissionAnswer | null>(
		(tui, theme, _keybindings, done) => {
			let state: CardState = { expanded: false, choice: 0 };
			let cached: { width: number; lines: string[] } | undefined;
			let finished = false;
			const finish = (answer: PermissionAnswer | null) => {
				if (finished) return;
				finished = true;
				signal?.removeEventListener("abort", onAbort);
				done(answer);
			};
			const onAbort = () => finish(null);
			signal?.addEventListener("abort", onAbort, { once: true });
			const painter: CardPainter = { paint: (tone, text) => theme.fg(tone, text), bold: (text) => theme.bold(text), measure: visibleWidth };
			return {
				render(width: number): string[] {
					if (cached?.width === width) return cached.lines;
					cached = { width, lines: renderPermissionCard(card, state, Math.max(1, width), painter) };
					return cached.lines;
				},
				handleInput(data: string): void {
					const key = keyOf(data);
					if (!key) return;
					const next = cardKey(card, state, key);
					if ("answer" in next) return finish(next.answer);
					state = next.state;
					cached = undefined;
					tui.requestRender();
				},
				invalidate(): void {
					cached = undefined;
				},
			};
		},
		{ blocked: { kind: "permission", message: title } },
	);
}
