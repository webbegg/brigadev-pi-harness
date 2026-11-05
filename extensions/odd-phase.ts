/**
 * brigadev ODD phase label: the working message shows what the orchestrator
 * is doing (exploring, implementing, checking, delegating · brigadev-explore,
 * ...), inferred from the tool it starts. Parent session only; a best-effort
 * UI hint, not a source of truth. /brigadev:ui phase off disables it.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { inferPhase, phaseLabel } from "../lib/odd-phase.ts";
import { isChildSession, readSettings } from "../lib/runtime.ts";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	const enabled = () => readSettings().ui?.phase !== false;

	pi.on("tool_execution_start", async (event, ctx) => {
		if (!ctx.hasUI || !enabled() || event.parentToolCallId) return;
		const phase = inferPhase(event.toolName, event.args as Record<string, unknown> | undefined);
		if (phase) ctx.ui.setWorkingMessage(`${phaseLabel(phase)}…`);
	});

	pi.on("agent_end", async (_event, ctx) => {
		if (ctx.hasUI) ctx.ui.setWorkingMessage();
	});
}
