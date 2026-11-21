// Feeds pi-agent-dashboard (github.com/BlackBeltTechnology/pi-agent-dashboard) from the brigadev bus, with no
// dependency on it. Two of its zero-SDK seams on `pi.events`:
// - event forwarding: declare our channels on `dashboard:register-event-forward` (again on every
//   `dashboard:bridge-ready`, whatever the load order), and its bridge forwards each `brigadev:*` emit as a session
//   event that a dashboard plugin can read;
// - UI descriptors: answer the synchronous `ui:list-modules` probe with a loop breadcrumb and footer segments, and
//   emit `ui:invalidate` when what they show changes.
// Guard and ask dialogs need nothing here: the dashboard patches `ctx.ui` and races its own prompt bus with the TUI.
// Without the dashboard nobody listens and all of this is a few no-op emits.

import { type AgentState, BUS, type Bus, CHANNELS, type CheckState, type ModeState, type PhaseState, PHASES } from "./bus.ts";

export const DASHBOARD_PLUGIN_ID = "brigadev";
export const REGISTER_FORWARD = "dashboard:register-event-forward";
export const BRIDGE_READY = "dashboard:bridge-ready";
export const LIST_MODULES = "ui:list-modules";
export const INVALIDATE = "ui:invalidate";
const NAMESPACE = "brigadev";

const LABELS: Record<(typeof PHASES)[number], string> = {
	authorize: "Authorize",
	explore: "Explore",
	decide: "Decide",
	implement: "Implement",
	check: "Check",
	commit: "Commit",
	close: "Close",
};

interface Descriptor {
	kind: "breadcrumb" | "footer-segment";
	namespace: string;
	id: string;
	payload: Record<string, unknown>;
}

/** Installs the adapter on `bus`; returns the function that removes it. */
export function installDashboardAdapter(bus: Bus): () => void {
	let phase: PhaseState | undefined;
	let mode: string | undefined;
	let check: CheckState | undefined;
	const running = new Set<string>();

	const declare = () => {
		try {
			bus.emit(REGISTER_FORWARD, { pluginId: DASHBOARD_PLUGIN_ID, channels: { ...CHANNELS } });
		} catch {
			// The dashboard is optional.
		}
	};

	const modules = (): Descriptor[] => {
		const visited = new Set(phase?.visited ?? []);
		const active = phase && phase.phase !== "idle" ? phase.phase : undefined;
		const out: Descriptor[] = [
			{
				kind: "breadcrumb",
				namespace: NAMESPACE,
				id: "loop",
				payload: {
					steps: PHASES.map((id) => ({ id, label: LABELS[id], status: id === active ? "active" : visited.has(id) ? "done" : "pending" })),
					...(active ? { current: active } : {}),
				},
			},
		];
		const segment = (id: string, text: string, tooltip?: string) => out.push({ kind: "footer-segment", namespace: NAMESPACE, id, payload: tooltip ? { text, tooltip } : { text } });
		if (active) segment("phase", `${active} (inferred)`, phase?.detail);
		if (mode) segment("mode", `mode ${mode}`);
		if (running.size > 0) segment("agents", `${running.size} agent${running.size === 1 ? "" : "s"} running`);
		if (check) segment("check", `check ${check.outcome}`, check.command);
		return out;
	};

	// Re-probe only when the descriptors would differ: agent updates arrive every ~100 ms per task.
	let shown = JSON.stringify(modules());
	const changed = () => {
		const next = JSON.stringify(modules());
		if (next === shown) return;
		shown = next;
		try {
			bus.emit(INVALIDATE, { id: NAMESPACE });
		} catch {
			// The dashboard is optional.
		}
	};

	const offs = [
		bus.on(BRIDGE_READY, declare),
		bus.on(LIST_MODULES, (probe) => {
			const list = (probe as { modules?: unknown } | undefined)?.modules;
			if (Array.isArray(list)) list.push(...modules());
		}),
		bus.on(BUS.phase, (data) => {
			phase = data as PhaseState;
			changed();
		}),
		bus.on(BUS.mode, (data) => {
			mode = (data as ModeState).mode;
			changed();
		}),
		bus.on(BUS.check, (data) => {
			check = data as CheckState;
			changed();
		}),
		bus.on(BUS.agent, (data) => {
			const agent = data as AgentState;
			if (agent.status === "running" || agent.status === "queued") running.add(agent.id);
			else running.delete(agent.id);
			changed();
		}),
	];
	declare();
	return () => {
		for (const off of offs) off();
	};
}
