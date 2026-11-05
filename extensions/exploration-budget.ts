/**
 * brigadev exploration budget: after 5 read/grep/find/ls calls in one user
 * request, appends one notice suggesting a brigadev-explore delegation.
 * Parent session only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createExplorationBudget } from "../lib/exploration-budget.ts";
import { isChildSession } from "../lib/runtime.ts";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	const budget = createExplorationBudget();

	pi.on("input", async () => {
		budget.reset();
		return undefined;
	});

	pi.on("tool_result", async (event) => {
		const notice = budget.record(event.toolName);
		if (!notice) return undefined;
		return { content: [...event.content, { type: "text" as const, text: notice }] };
	});
}
