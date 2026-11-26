/**
 * brigadev stats: /brigadev:stats reports cost by phase, context percentiles,
 * cache rebuilds, evidence-gate activity, run outcomes (per workflow), and failed
 * subagent runs from Pi's session logs.
 *
 * A user command only: no tools, no hooks, no prompt text (zero per-turn tokens).
 *   /brigadev:stats        the current session
 *   /brigadev:stats all    every session of this project
 *   /brigadev:stats <N>d   sessions modified in the last N days
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { isChildSession, PACKAGE_WORKFLOWS_DIR } from "../lib/runtime.ts";
import { computeStats, readEvidenceDir, readSessionFile, readWorkflowNames, renderStats, sessionFiles, type SessionLog } from "../lib/stats.ts";
import { workflowDirs } from "../lib/workflows.ts";

const USAGE = "Usage: /brigadev:stats [all|<N>d]  (default: the current session)";

type Scope = { kind: "current" } | { kind: "all" } | { kind: "days"; days: number };

function parseScope(args: string): Scope | undefined {
	const arg = args.trim().toLowerCase();
	if (arg === "") return { kind: "current" };
	if (arg === "all") return { kind: "all" };
	const days = /^(\d+)d$/.exec(arg);
	return days && Number(days[1]) > 0 ? { kind: "days", days: Number(days[1]) } : undefined;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	pi.registerCommand("brigadev:stats", {
		description: "Session stats from the Pi logs: cost by phase, context percentiles, cache rebuilds, gate blocks and forces, outcomes. Args: all | <N>d",
		handler: async (args, ctx) => {
			const scope = parseScope(args);
			if (!scope) return ctx.ui.notify(USAGE, "warning");

			const manager = ctx.sessionManager;
			const currentFile = manager.getSessionFile();
			const sessions: SessionLog[] = [{ id: manager.getSessionId?.() ?? "current", entries: manager.getEntries() as unknown[] }];
			if (scope.kind !== "current") {
				for (const file of sessionFiles(manager.getSessionDir(), scope.kind === "days" ? scope.days : undefined)) {
					if (file === currentFile) continue; // the live entries above are fresher than the file
					const log = readSessionFile(file);
					if (log) sessions.push(log);
				}
			}

			const label = scope.kind === "current" ? "current session" : scope.kind === "all" ? "all sessions of this project" : `sessions of the last ${scope.days} days`;
			const { userDir, repoDir } = workflowDirs(ctx.cwd);
			const stats = computeStats(sessions, readEvidenceDir(repoDocsDir(ctx.cwd)), { workflows: readWorkflowNames([PACKAGE_WORKFLOWS_DIR, userDir, repoDir]) });
			ctx.ui.notify(renderStats(stats, label).join("\n"), "info");
		},
	});
}
