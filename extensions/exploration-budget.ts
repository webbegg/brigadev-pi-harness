/**
 * brigadev exploration budget: after 5 lookups (read/grep/find/ls or
 * read-only shell commands such as cat and sed -n) in one user request,
 * appends one notice suggesting a brigadev-explore delegation. The first
 * read-only bash lookup of a request also gets a notice to use the file tools.
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
		const input = event.input as { command?: unknown };
		const notices = [budget.nudgeShellRead(event.toolName, input), budget.record(event.toolName, input)].filter((n): n is string => !!n);
		if (notices.length === 0) return undefined;
		return { content: [...event.content, ...notices.map((text) => ({ type: "text" as const, text }))] };
	});
}
