/**
 * Escape during a run asks "Stop the current run?" instead of aborting at once. Enter (Yes) stops it; Escape or No keeps it running.
 *
 * Pi has no hook to veto its interrupt, and `registerShortcut("escape")` is reserved, so this listens to raw terminal input, which
 * runs before any component. It takes Escape only when the agent is running (`!isIdle()`) and the main editor has focus with no
 * autocomplete open: dialogs, selectors, overlays, and our own tools' UIs keep their Escape, and so does everything Pi does with
 * Escape while idle (double Escape, a `!` bash command). The editor is recognized as Pi itself does (an `actionHandlers` map, an
 * internal detail): if that changes, nothing matches and Escape aborts at once again, the safe direction. TUI only; rpc/print
 * aborts are untouched. Off with `"ui": { "confirmStop": false }` in brigadev.json, or `/brigadev:ui confirmStop off`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";
import { isChildSession, readSettings } from "../lib/runtime.ts";

const PROBE_WIDGET = "brigadev-stop-confirm";

type Focusable = { getFocusedComponent(): unknown };

export function stopConfirmEnabled(): boolean {
	return readSettings().ui?.confirmStop !== false;
}

export default function stopConfirm(pi: ExtensionAPI) {
	let tui: Focusable | undefined;
	let pending: AbortController | undefined;

	/** The main editor has focus and shows no autocomplete. */
	const editorFocused = (): boolean => {
		const focused = tui?.getFocusedComponent() as { actionHandlers?: unknown; isShowingAutocomplete?: () => boolean } | null | undefined;
		return !!focused && focused.actionHandlers instanceof Map && focused.isShowingAutocomplete?.() !== true;
	};

	async function ask(ctx: ExtensionContext): Promise<void> {
		const controller = new AbortController();
		pending = controller;
		try {
			const stop = await ctx.ui.confirm("Stop the current run?", "Enter stops it; Escape keeps it running.", { signal: controller.signal });
			// The run may have ended while the question was open: abort only one that is still going.
			if (stop && !controller.signal.aborted && !ctx.isIdle()) ctx.abort();
		} finally {
			if (pending === controller) pending = undefined;
		}
	}

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui" || !ctx.hasUI || isChildSession() || !stopConfirmEnabled()) return;
		// A widget with no lines, only to get the TUI (its focused component); it adds no height.
		ctx.ui.setWidget(PROBE_WIDGET, (instance) => {
			tui = instance as unknown as Focusable;
			return { render: () => [], invalidate() {} };
		});
		ctx.ui.onTerminalInput((data) => {
			if (!matchesKey(data, "escape") || isKeyRelease(data) || isKeyRepeat(data)) return undefined;
			if (pending || ctx.isIdle() || !editorFocused()) return undefined;
			void ask(ctx);
			return { consume: true };
		});
	});

	pi.on("agent_settled", () => pending?.abort());
}
