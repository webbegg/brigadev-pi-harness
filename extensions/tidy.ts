/**
 * /brigadev:tidy: add "subagent" to pi-tidy's alwaysShowTools so brigadev's
 * subagent rows are not folded into pi-tidy's groups.
 *
 * Shows the exact change to <agentDir>/settings.json and writes only after the
 * user confirms. With no UI it never writes and prints the manual instruction.
 *
 * Pi saves settings.json by re-reading the file under a lock and overwriting
 * only the fields it changed (settings-manager.js persistScopedSettings), so
 * the added key is not dropped by a later Pi save. pi-tidy reads its config at
 * load, hence the /reload.
 */

import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { commitTidyPlan, describePlan, readTidyPlan } from "../lib/tidy-settings.ts";
import { agentDir, isChildSession } from "../lib/runtime.ts";

const TOOL = "subagent";
const RELOAD = "pi-tidy reads its config when it loads: run /reload to apply it. Pi keeps unknown keys when it saves settings, so the change stays.";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	pi.registerCommand("brigadev:tidy", {
		description: `Add "${TOOL}" to pi-tidy's alwaysShowTools so subagent rows stay visible (shows the change, asks first)`,
		handler: async (_args, ctx) => {
			const path = join(agentDir(), "settings.json");
			const shown = readTidyPlan(path, TOOL);
			const text = describePlan(shown.plan, path, TOOL);
			if (shown.plan.kind === "refuse") return ctx.ui.notify(text, "error");
			if (shown.plan.kind === "noop") return ctx.ui.notify(text, "info");

			if (!ctx.hasUI) {
				return ctx.ui.notify(
					`${text}\n\nNot written (no UI to confirm). To apply it by hand, set ${shown.plan.key}.alwaysShowTools to ${JSON.stringify(shown.plan.after)} in ${path}, then /reload.`,
					"info",
				);
			}

			const ok = await ctx.ui.confirm("Show subagent rows even with pi-tidy?", `${text}\n\nEverything else in the file is kept as is.`);
			if (!ok) return ctx.ui.notify("Not changed.", "info");

			const result = commitTidyPlan(path, shown, TOOL);
			if (!result.ok) return ctx.ui.notify(`Not changed: ${result.reason}.`, "error");
			ctx.ui.notify(`Done: ${TOOL} added to ${shown.plan.key}.alwaysShowTools in ${path}.\n${RELOAD}`, "info");
		},
	});
}
