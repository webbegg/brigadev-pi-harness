// brigadev-t3: brigadev in T3 Code. Loaded next to the harness (T3 settings → Pi launch arguments: `-e <path>/t3`), it
// turns itself off outside T3 Code and in subagents. It reads only the public `brigadev:*` bus on `pi.events`, never
// harness code, and adds what T3 can show: status chips for the loop, and a prompt section that settles where brigadev's
// and T3's rules overlap.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CHANNELS, type CheckSnapshot, type PhaseSnapshot, type TodoSnapshot } from "./channels.ts";
import { SECTION_KEY, T3_SECTION, T3_SECTION_TAGGED } from "./prompt.ts";
import { type StatusState, statusTexts } from "./statuses.ts";

type Ui = ExtensionContext["ui"];

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export default function brigadevT3(pi: ExtensionAPI): void {
	if (!process.env.T3CODE_THREAD_ID || process.env.BRIGADEV_CHILD) return;

	let state: StatusState = {};
	let ui: Ui | undefined;
	const shown = new Map<string, string | undefined>();

	const render = () => {
		if (!ui) return;
		for (const [key, text] of Object.entries(statusTexts(state))) {
			if (shown.has(key) && shown.get(key) === text) continue;
			shown.set(key, text);
			try {
				ui.setStatus(key, text);
			} catch {
				// A chip is decoration: a UI that fails must not break the session.
			}
		}
	};

	/** Chips go to the newest session UI; a new one gets every chip again. */
	const attach = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (ctx.ui !== ui) {
			ui = ctx.ui;
			shown.clear();
		}
		render();
	};

	const offs = [
		pi.events.on(CHANNELS.phase, (data) => {
			if (!isObject(data) || typeof data.phase !== "string") return;
			state.phase = data as unknown as PhaseSnapshot;
			render();
		}),
		pi.events.on(CHANNELS.todo, (data) => {
			if (!isObject(data) || !Array.isArray(data.todos)) return;
			state.todo = data as unknown as TodoSnapshot;
			render();
		}),
		pi.events.on(CHANNELS.check, (data) => {
			if (!isObject(data) || typeof data.outcome !== "string") return;
			state.check = data as unknown as CheckSnapshot;
			render();
		}),
	];

	// Pi reruns this factory when it replaces the session: the old instance stops listening.
	pi.on("session_shutdown", () => {
		for (const off of offs) off();
		ui = undefined;
	});

	pi.on("session_start", (_event, ctx) => {
		state = {};
		attach(ctx);
	});

	pi.on("before_agent_start", (event, ctx) => {
		attach(ctx);
		const options = event.systemPromptOptions;
		if (isObject(options?.sections) && options.forceSystemPrompt === undefined) {
			options.sections[SECTION_KEY] = T3_SECTION;
			return undefined;
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${T3_SECTION_TAGGED}` };
	});
}
