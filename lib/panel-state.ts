// Process-wide store behind the side panel. The todo, subagent, and cost
// extensions publish their latest data here; the panel subscribes and
// repaints. Kept on globalThis so every extension instance shares one store,
// like fallback-state.

import type { AgentRun } from "./agents-card.ts";
import type { Todo } from "./todo-card.ts";

const KEY = Symbol.for("brigadev.panel-state");

export interface PanelCost {
	cost: number;
	/** True when the number prices subscription (claude-bridge) turns at API list price. */
	apiEquivalent: boolean;
}

export interface PanelSections {
	todos: Todo[];
	agents: AgentRun[];
	cost: PanelCost;
}

export type PanelSection = keyof PanelSections;

export class PanelStore {
	private readonly data: Partial<PanelSections> = {};
	private readonly listeners = new Set<(section: PanelSection) => void>();

	publish<K extends PanelSection>(section: K, value: PanelSections[K]): void {
		this.data[section] = value;
		for (const listener of [...this.listeners]) {
			try {
				listener(section);
			} catch {
				// A broken panel must never fail the extension that publishes.
			}
		}
	}

	read<K extends PanelSection>(section: K): PanelSections[K] | undefined {
		return this.data[section];
	}

	/** Returns the function that removes the subscription. */
	subscribe(listener: (section: PanelSection) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}
}

export function panelState(): PanelStore {
	const g = globalThis as Record<symbol, PanelStore | undefined>;
	return (g[KEY] ??= new PanelStore());
}
