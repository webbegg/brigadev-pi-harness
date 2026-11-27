// A human prompt answerable from two places at once: the TUI dialog and a remote answer (`{action:"answer", id, value}`
// on the brigadev bus). The first answer wins; the other side is cancelled (the dialog's AbortSignal, the component's
// `done`) and the prompt is published once more with its final status. Nothing stays "open" after it settles.

import { randomUUID } from "node:crypto";
import { BUS, onAction, publish, type Bus, type PromptState } from "./bus.ts";
import { redact } from "./redact.ts";

/** The part of Pi's `ctx` that `askConfirm` uses (`select`: `askPermission`, for its third answer). */
export interface ConfirmHost {
	ui: {
		confirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
		select?(title: string, options: string[], opts?: { signal?: AbortSignal }): Promise<string | undefined>;
	};
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

/** A permission question: `details` is text a UI may fold away; `sessionLabel` offers a third answer, yes for the rest of the session. */
export interface PermissionSpec extends ConfirmSpec {
	details?: string;
	level?: "Low" | "Medium" | "High";
	sessionLabel?: string;
}

export type PermissionAnswer = "yes" | "session" | "no";

/** Shows the TUI side in place of Pi's dialogs (the guard's card); resolves the answer, or null when dismissed. */
export type ShowPermission = (signal: AbortSignal) => Promise<PermissionAnswer | null>;

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
	/** More fields for the final snapshot. */
	settled?(result: T): Partial<PromptState>;
	/** Starts the TUI side; `cancel` is what the race calls when the web answers first. The promise's value is the TUI's answer, null for a dismissal. */
	start(onCancel: (cancel: () => void) => void): Promise<T | null | undefined>;
}

type Outcome<T> = { kind: "answered"; result: T; by: "tui" | "web" } | { kind: "dismissed"; aborted?: true } | { kind: "failed"; error: unknown };

/**
 * Runs the race; resolves with the first answer, or null when the TUI was dismissed or the run was aborted (`signal`).
 * An abort closes both sides at once, so a late answer cannot resume a call the user aborted. A failing TUI rejects, after the prompt is closed.
 */
function race<T>(bus: Bus, { prompt, fromWeb, toAnswer, settled: settledFields, start }: Race<T>, signal?: AbortSignal): Promise<T | null> {
	if (signal?.aborted) return Promise.resolve(null);
	return new Promise<T | null>((resolve, reject) => {
		let settled = false;
		let cancelTui: (() => void) | undefined;
		const onAbort = () => settle({ kind: "dismissed", aborted: true });
		const settle = (outcome: Outcome<T>) => {
			if (settled) return;
			settled = true;
			stop();
			signal?.removeEventListener("abort", onAbort);
			// The web answered first, or the run was aborted: close the TUI side; whatever it reports afterwards is ignored.
			if ((outcome.kind === "answered" && outcome.by === "web") || (outcome.kind === "dismissed" && outcome.aborted)) closeTui();
			const final: PromptState =
				outcome.kind === "answered"
					? { ...prompt, status: "answered", answer: toAnswer(outcome.result), ...settledFields?.(outcome.result), by: outcome.by, at: Date.now() }
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
		signal?.addEventListener("abort", onAbort, { once: true });
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
 * Asks a yes/no question in the TUI and on the bus; the first answer wins. A TUI that is dismissed (Esc) answers false,
 * and so does an aborted `signal` (the run's: Esc, the web Abort), which closes the dialog and the web prompt.
 * With no bus this is the plain dialog.
 */
export async function askConfirm(bus: Bus | undefined, ctx: ConfirmHost, { source, title, body }: ConfirmSpec, signal?: AbortSignal): Promise<boolean> {
	if (!bus) return signal ? ctx.ui.confirm(title, body, { signal }) : ctx.ui.confirm(title, body);
	const controller = new AbortController();
	const result = await race<boolean>(bus, {
		// The dialog shows the real text; the bus (and so the page) gets it redacted.
		prompt: { id: randomUUID(), kind: "confirm", source, title: redact(title), body: redact(body) },
		fromWeb: (value) => (typeof value === "boolean" ? value : undefined),
		toAnswer: (result) => result,
		start: (onCancel) => {
			onCancel(() => controller.abort());
			return Promise.resolve(ctx.ui.confirm(title, body, { signal: controller.signal })).then((answer) => Boolean(answer));
		},
	}, signal);
	return result ?? false;
}

/**
 * A permission question in the TUI and on the bus; the first answer wins. Like `askConfirm`, with folded `details` for the page
 * and an optional third answer (`sessionLabel`: yes, and do not ask again this session). `show` replaces Pi's dialogs on the TUI
 * side (the guard's card); without it, a third answer asks with Pi's select (an RPC client: T3 Code), and none asks with confirm.
 * Dismissed, aborted, or no answer: "no".
 */
export async function askPermission(bus: Bus | undefined, ctx: ConfirmHost, spec: PermissionSpec, signal?: AbortSignal, show?: ShowPermission): Promise<PermissionAnswer> {
	const { source, title, body, details, level, sessionLabel } = spec;
	const tui = async (tuiSignal: AbortSignal): Promise<PermissionAnswer | null> => {
		if (show) return show(tuiSignal);
		if (sessionLabel && typeof ctx.ui.select === "function") {
			const picked = await ctx.ui.select(`${title}\n${body}`, ["Yes", sessionLabel, "No"], { signal: tuiSignal });
			return picked === undefined ? null : picked === "Yes" ? "yes" : picked === sessionLabel ? "session" : "no";
		}
		return (await ctx.ui.confirm(title, body, { signal: tuiSignal })) ? "yes" : "no";
	};
	if (!bus) return (await tui(signal ?? new AbortController().signal)) ?? "no";
	const controller = new AbortController();
	const result = await race<PermissionAnswer>(bus, {
		// The dialog shows the real text; the bus (and so the page) gets it redacted.
		prompt: {
			id: randomUUID(),
			kind: "confirm",
			source,
			title: redact(title),
			body: redact(body),
			...(details ? { details: redact(details) } : {}),
			...(level ? { level } : {}),
			...(sessionLabel ? { sessionLabel } : {}),
		},
		fromWeb: (value) => (value === true ? "yes" : value === false ? "no" : value === "session" && sessionLabel ? "session" : undefined),
		toAnswer: (answer) => answer !== "no",
		settled: (answer) => (answer === "session" ? { forSession: true } : {}),
		start: (onCancel) => {
			onCancel(() => controller.abort());
			return tui(controller.signal);
		},
	}, signal);
	return result ?? "no";
}

/**
 * Asks a question with options in the TUI and on the bus; the first answer wins. `runTui` shows the component and
 * resolves with its answer (null when dismissed); it hands the race the function that closes the component, which is
 * called when the web answers first or `signal` (the run's) aborts, which resolves null. A web answer is an option's label,
 * or free text unless `allowOther` is false. With no bus this is `runTui` alone.
 */
export async function askChoice(bus: Bus | undefined, spec: ChoiceSpec, runTui: (onClose: (close: () => void) => void) => Promise<ChoiceAnswer | null>, signal?: AbortSignal): Promise<ChoiceAnswer | null> {
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
	}, signal);
}
