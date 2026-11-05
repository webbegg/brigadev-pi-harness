/**
 * brigadev exploration budget: after 5 lookups (read/grep/find/ls or
 * read-only shell commands such as cat and sed -n) in one user request,
 * appends one notice suggesting a brigadev-explore delegation.
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
		const notice = budget.record(event.toolName, event.input as { command?: unknown });
		if (!notice) return undefined;
		return { content: [...event.content, { type: "text" as const, text: notice }] };
	});
}
