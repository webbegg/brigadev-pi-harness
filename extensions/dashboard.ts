/**
 * brigadev launch dashboard (/brigadev:dashboard): a full-screen start menu
 * with the nine workflows and a few tools, one key each. It opens by itself
 * once when Pi starts in the terminal UI with an empty session and no initial
 * prompt, never in subagents; `/brigadev:ui dashboard off` turns that off.
 * Choosing a row closes the dashboard and runs the command, like the palette.
 */

import { basename, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { buildEntries, DASHBOARD_COMMAND, entryForKey, hasInitialPrompt, hasMessageEntries, moveSelection, renderDashboard, shouldShowDashboard, type DashboardAction } from "../lib/dashboard.ts";
import { ASSETS_ROOT, isChildSession, readSettings } from "../lib/runtime.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { discoverWorkflows, workflowDirs } from "../lib/workflows.ts";

const START_COMMAND = "/brigadev:start";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let opening = false;

	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify(`/${DASHBOARD_COMMAND} needs the interactive UI`, "error");
		if (opening) return;
		opening = true;
		let action: DashboardAction | undefined;
		try {
			const { workflows, warnings } = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), ...workflowDirs(ctx.cwd), parse: (content) => parseFrontmatter<Record<string, unknown>>(content) });
			if (warnings.length) ctx.ui.notify(`brigadev: skipped invalid workflow files\n${warnings.join("\n")}`, "warning");
			const entries = buildEntries(workflows);
			const repo = basename(ctx.cwd);

			action = await ctx.ui.custom<DashboardAction | undefined>((tui, theme, _kb, done) => {
				const painter = themePainter(theme);
				let selected = 0;
				return {
					invalidate() {},
					handleInput(data: string) {
						if (matchesKey(data, Key.escape)) return done({ kind: "chat" });
						if (matchesKey(data, Key.enter)) return done(entries[selected].action);
						if (matchesKey(data, Key.down) || matchesKey(data, "ctrl+n")) selected = moveSelection(selected, 1, entries.length);
						else if (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p")) selected = moveSelection(selected, -1, entries.length);
						else {
							const hit = entryForKey(entries, data);
							if (hit) return done(hit.action);
						}
						tui.requestRender();
					},
					render: (width: number) => renderDashboard({ width, height: tui.terminal.rows, title: "brigadev", subtitle: repo, entries, selected }, painter),
				};
			}, FULLSCREEN_OVERLAY);
		} finally {
			opening = false;
		}

		// The dashboard is closed by now. sendUserMessage returns void; only expandPromptTemplates makes pi run the text as a command.
		const run = (text: string) => {
			try {
				pi.sendUserMessage(text, { expandPromptTemplates: true });
			} catch (error) {
				ctx.ui.notify(`Could not run ${text}: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		};
		if (action?.kind === "workflow") run(`${START_COMMAND} ${action.query}`);
		else if (action?.kind === "command") run(action.command);
		else if (action?.kind === "quit") ctx.shutdown();
	};

	pi.on("session_start", async (event, ctx) => {
		const show = shouldShowDashboard({
			reason: event.reason,
			mode: ctx.mode,
			branchHasMessages: hasMessageEntries(ctx.sessionManager.getBranch()),
			hasInitialPrompt: hasInitialPrompt(process.argv.slice(2)),
			enabled: readSettings().ui?.dashboard !== false,
			child: isChildSession(),
		});
		if (!show) return;
		// Not awaited: the overlay waits for a key press and must not hold up the rest of startup.
		setTimeout(() => void open(ctx).catch(() => undefined), 0);
	});

	pi.registerCommand(DASHBOARD_COMMAND, { description: "Open the launch dashboard: workflows and tools, one key each", handler: async (_args, ctx) => open(ctx) });
}
