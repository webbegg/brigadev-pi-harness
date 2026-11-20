// A human prompt answerable from two places at once: the TUI dialog and a remote answer (`{action:"answer", id, value}`
// on the brigadev bus). The first answer wins; the other side is cancelled (the dialog's AbortSignal, the component's
// `done`) and the prompt is published once more with its final status. Nothing stays "open" after it settles.

import { randomUUID } from "node:crypto";
import { BUS, onAction, publish, type Bus, type PromptState } from "./bus.ts";

/** The part of Pi's `ctx` that `askConfirm` uses. */
export interface ConfirmHost {
	ui: { confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean> };
}

export interface ConfirmSpec {
	/** Who asks: `guard`, `ask`, `subagents`. */
	source: string;
	title: string;
	body: string;
}

export interface ChoiceSpec {
	source: string;
	question: string;
	options: Array<{ label: string; description?: string }>;
	/** 1-based. */
	recommended?: number;
	allowOther?: boolean;
}

/** An answer to a choice: one option's label, or the user's own text. */
export interface ChoiceAnswer {
	answer: string;
	wasCustom: boolean;
}

interface Race<T> {
	/** The prompt's first snapshot, minus its status. */
	prompt: Omit<PromptState, "status" | "at">;
	/** A web answer as a result, or undefined when this prompt does not take it. */
	fromWeb(value: boolean | string): T | undefined;
	/** The result as the snapshot's `answer`. */
	toAnswer(result: T): boolean | string;
	/** Starts the TUI side; `cancel` is what the race calls when the web answers first. The promise's value is the TUI's answer, null for a dismissal. */
	start(onCancel: (cancel: () => void) => void): Promise<T | null | undefined>;
}

type Outcome<T> = { kind: "answered"; result: T; by: "tui" | "web" } | { kind: "dismissed" } | { kind: "failed"; error: unknown };

/** Runs the race; resolves with the first answer, or null when the TUI was dismissed. A failing TUI rejects, after the prompt is closed. */
function race<T>(bus: Bus, { prompt, fromWeb, toAnswer, start }: Race<T>): Promise<T | null> {
	return new Promise<T | null>((resolve, reject) => {
		let settled = false;
		let cancelTui: (() => void) | undefined;
		const settle = (outcome: Outcome<T>) => {
			if (settled) return;
			settled = true;
			stop();
			// The web answered first: close the TUI side; whatever it reports afterwards is ignored.
			if (outcome.kind === "answered" && outcome.by === "web") closeTui();
			const final: PromptState =
				outcome.kind === "answered"
					? { ...prompt, status: "answered", answer: toAnswer(outcome.result), by: outcome.by, at: Date.now() }
					: { ...prompt, status: "dismissed", at: Date.now() };
			publish(bus, BUS.prompt, final);
			if (outcome.kind === "failed") reject(outcome.error);
			else resolve(outcome.kind === "answered" ? outcome.result : null);
		};
		const closeTui = () => {
			try {
				cancelTui?.();
			} catch {
				// A dialog that cannot be closed is left to its own end; its result is ignored.
			}
		};
		const stop = onAction(bus, "answer", (action) => {
			if (action.id !== prompt.id) return;
			const result = fromWeb(action.value);
			if (result !== undefined) settle({ kind: "answered", result, by: "web" });
		});

		publish(bus, BUS.prompt, { ...prompt, status: "open", at: Date.now() } satisfies PromptState);
		let tui: Promise<T | null | undefined>;
		try {
			tui = start((close) => {
				cancelTui = close;
				// The web answered while the TUI side was starting: close it now.
				if (settled) closeTui();
			});
		} catch (error) {
			settle({ kind: "failed", error });
			return;
		}
		tui.then(
			(value) => settle(value === null || value === undefined ? { kind: "dismissed" } : { kind: "answered", result: value, by: "tui" }),
			(error) => settle({ kind: "failed", error }),
		);
	});
}

/**
 * Asks a yes/no question in the TUI and on the bus; the first answer wins. A TUI that is dismissed (Esc) answers false.
 * With no bus this is the plain dialog.
 */
export async function askConfirm(bus: Bus | undefined, ctx: ConfirmHost, { source, title, body }: ConfirmSpec): Promise<boolean> {
	if (!bus) return ctx.ui.confirm(title, body);
	const controller = new AbortController();
	const result = await race<boolean>(bus, {
		prompt: { id: randomUUID(), kind: "confirm", source, title, body },
		fromWeb: (value) => (typeof value === "boolean" ? value : undefined),
		toAnswer: (result) => result,
		start: (onCancel) => {
			onCancel(() => controller.abort());
			return Promise.resolve(ctx.ui.confirm(title, body, { signal: controller.signal })).then((answer) => Boolean(answer));
		},
	});
	return result ?? false;
}

/**
 * Asks a question with options in the TUI and on the bus; the first answer wins. `runTui` shows the component and
 * resolves with its answer (null when dismissed); it hands the race the function that closes the component, which is
 * called when the web answers first. A web answer is an option's label, or free text unless `allowOther` is false.
 * With no bus this is `runTui` alone.
 */
export async function askChoice(bus: Bus | undefined, spec: ChoiceSpec, runTui: (onClose: (close: () => void) => void) => Promise<ChoiceAnswer | null>): Promise<ChoiceAnswer | null> {
	if (!bus) return runTui(() => {});
	return race<ChoiceAnswer>(bus, {
		prompt: {
			id: randomUUID(),
			kind: "choice",
			source: spec.source,
			title: spec.question,
			options: spec.options,
			...(spec.recommended === undefined ? {} : { recommended: spec.recommended }),
			...(spec.allowOther === undefined ? {} : { allowOther: spec.allowOther }),
		},
		fromWeb: (value) => {
			if (typeof value !== "string") return undefined;
			const text = value.trim();
			if (spec.options.some((o) => o.label === value)) return { answer: value, wasCustom: false };
			if (spec.allowOther === false || !text) return undefined;
			return { answer: text, wasCustom: true };
		},
		toAnswer: (result) => result.answer,
		start: runTui,
	});
}
