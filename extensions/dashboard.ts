/**
 * brigadev launch dashboard (/brigadev:dashboard): a full-screen start menu
 * of four groups (Build, Review & ship, Inspect, Settings, plus any a
 * workflow file names) with the workflows and tools in them, one key each. It opens by itself
 * once when Pi starts in the terminal UI with an empty session and no initial
 * prompt, never in subagents; `/brigadev:ui dashboard off` (or
 * `BRIGADEV_DASHBOARD=0`) turns that off. Choosing a row closes the dashboard
 * and runs the command, like the palette. The decisions live in
 * lib/dashboard-controller.ts; this file only connects them to Pi.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { dispatch, reduceKey, renderState, scheduleAutoOpen, shouldOpenOnStart, startState, type DashboardState } from "../lib/dashboard-controller.ts";
import { buildMenu, DASHBOARD_COMMAND, type DashboardAction } from "../lib/dashboard.ts";
import { isChildSession, PACKAGE_WORKFLOWS_DIR } from "../lib/runtime.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { loadWorkflows, workflowDirs } from "../lib/workflows.ts";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let opening = false;
	// Set while the overlay exists; calling it closes the dashboard without choosing anything.
	let closeOverlay: (() => void) | undefined;
	// Set while the deferred automatic open is waiting for its turn.
	let cancelAutoOpen: (() => void) | undefined;

	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify(`/${DASHBOARD_COMMAND} needs the interactive UI`, "error");
		if (opening) return;
		opening = true;
		let action: DashboardAction | undefined;
		try {
			const { workflows, warning } = loadWorkflows((content) => parseFrontmatter<Record<string, unknown>>(content), { packageDir: PACKAGE_WORKFLOWS_DIR, ...workflowDirs(ctx.cwd) });
			if (warning) ctx.ui.notify(warning, "warning");
			const menu = buildMenu(workflows);
			const repo = basename(ctx.cwd);

			action = await ctx.ui.custom<DashboardAction | undefined>((tui, theme, _kb, done) => {
				const painter = themePainter(theme);
				let state: DashboardState = startState;
				closeOverlay = () => done(undefined);
				return {
					invalidate() {},
					handleInput(data: string) {
						const result = reduceKey(state, data, menu, matchesKey);
						state = result.state;
						if (result.done) return done(result.done);
						tui.requestRender();
					},
					render: (width: number) => renderState(menu, state, { width, height: tui.terminal.rows }, painter, repo),
				};
			}, FULLSCREEN_OVERLAY);
		} finally {
			opening = false;
			closeOverlay = undefined;
		}

		// The dashboard is closed by now.
		dispatch(action, { sendUserMessage: (text, options) => pi.sendUserMessage(text, options), shutdown: () => ctx.shutdown(), notify: (message, level) => ctx.ui.notify(message, level) });
	};

	pi.on("session_start", async (event, ctx) => {
		if (!shouldOpenOnStart({ reason: event.reason, mode: ctx.mode, branch: ctx.sessionManager.getBranch() })) return;
		// Not awaited: the overlay waits for a key press and must not hold up the rest of startup.
		cancelAutoOpen?.();
		cancelAutoOpen = scheduleAutoOpen(() => open(ctx), (message, level) => ctx.ui.notify(message, level));
	});

	pi.on("session_shutdown", async () => {
		cancelAutoOpen?.();
		cancelAutoOpen = undefined;
		closeOverlay?.();
	});

	pi.registerCommand(DASHBOARD_COMMAND, { description: "Open the launch dashboard: workflows and tools in groups, one key each", handler: async (_args, ctx) => open(ctx) });
}
