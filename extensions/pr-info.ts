/**
 * Pull request of the current branch.
 *
 * `/brigadev:pr` shows its number, title, state, review and check summary, and
 * URL (read with `gh pr view --json`, never written). The footer shows `PR #N`
 * through the `brigadev-pr` status. The lookup is cached and refreshed at
 * session start, on the command, and after a bash command that pushes or
 * switches branches. It never blocks a turn: refreshes run in the background,
 * and a slow answer that a newer refresh overtook is dropped. Silent when gh
 * is missing, unauthenticated, offline, or the branch has no PR. Parent only.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { commandChangesPr, createPrTracker, prReport } from "../lib/pr-info.ts";
import { isChildSession } from "../lib/runtime.ts";

const STATUS_KEY = "brigadev-pr";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let uiContext: ExtensionContext | undefined;

	const tracker = createPrTracker({
		exec: (command, args, options) => pi.exec(command, args, options),
		onChange: (footerText) => {
			if (!uiContext?.hasUI) return;
			try {
				uiContext.ui.setStatus(STATUS_KEY, footerText);
			} catch {
				// The context belongs to a session that has ended.
			}
		},
	});

	/** Fire and forget: the footer updates when the lookup answers. */
	const refreshInBackground = (ctx: ExtensionContext) => {
		uiContext = ctx;
		void tracker.refresh(ctx.cwd);
	};

	pi.on("session_start", async (_event, ctx) => {
		tracker.reset();
		refreshInBackground(ctx);
	});
	pi.on("session_shutdown", async () => {
		tracker.reset();
		uiContext = undefined;
	});
	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "bash") return;
		const command = (event as { input?: { command?: unknown } }).input?.command;
		if (typeof command === "string" && commandChangesPr(command)) refreshInBackground(ctx);
	});

	pi.registerCommand("brigadev:pr", {
		description: "Show the pull request of the current branch (state, review, checks, URL)",
		handler: async (_args, ctx) => {
			uiContext = ctx;
			const lookup = await tracker.refresh(ctx.cwd);
			if (lookup.status === "found") ctx.ui.notify(prReport(lookup.pr), "info");
			else if (lookup.status === "none") ctx.ui.notify("No pull request for the current branch.", "info");
			else ctx.ui.notify("Could not read the pull request: gh is missing, not signed in, offline, or this is not a GitHub repository.", "warning");
		},
	});
}
