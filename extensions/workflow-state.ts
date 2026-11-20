// Publishes workflow state on the brigadev bus (lib/bus.ts) for the web UI and the dashboard adapter: the
// inferred loop phase, the todo list, and finished check runs. Read-only: it never changes what the agent does.
// It also installs the pi-agent-dashboard adapter (lib/dashboard-adapter.ts), inert without the dashboard.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BUS, type CheckState, publish, type TodoItem } from "../lib/bus.ts";
import { installDashboardAdapter } from "../lib/dashboard-adapter.ts";
import { createPhaseTracker } from "../lib/phase.ts";
import { isChildSession } from "../lib/runtime.ts";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	const bus = pi.events;
	const phase = createPhaseTracker();
	if (bus) installDashboardAdapter(bus);

	pi.on("agent_start", () => publish(bus, BUS.phase, phase.agentStart()));
	pi.on("agent_end", () => publish(bus, BUS.phase, phase.agentEnd()));
	pi.on("tool_execution_start", (event) => {
		const next = phase.tool(event.toolName, event.args);
		if (next) publish(bus, BUS.phase, next);
	});

	pi.on("tool_execution_end", (event) => {
		const details = (event.result as { details?: Record<string, unknown> } | undefined)?.details;
		if (!details) return;
		if (event.toolName === "todo" && Array.isArray(details.todos)) {
			publish(bus, BUS.todo, { scope: "todo", todos: details.todos as TodoItem[] });
		}
		if (event.toolName === "check" && typeof details.command === "string") {
			const check: CheckState = {
				id: event.toolCallId,
				command: details.command,
				outcome: String(details.outcome ?? "unknown"),
				exitCode: typeof details.exitCode === "number" ? details.exitCode : undefined,
				counts: details.counts,
				durationMs: typeof details.durationMs === "number" ? details.durationMs : event.durationMs,
				at: Date.now(),
			};
			publish(bus, BUS.check, check);
		}
	});
}
