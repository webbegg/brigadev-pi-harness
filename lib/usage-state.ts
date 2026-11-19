// Process-wide subscription-usage state shared by the usage tracker and the
// cost extension: the latest usage snapshot per provider. Snapshots are also
// kept on disk so a new session knows a window is spent.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeJsonAtomic } from "./profiles-store.ts";
import { agentDir } from "./runtime.ts";
import type { UsageSnapshot } from "./usage-windows.ts";

const KEY = Symbol.for("brigadev.usage-state");
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60_000;

interface State {
	usage: Map<string, UsageSnapshot>;
}

export function usageState(): State {
	const g = globalThis as Record<symbol, State | undefined>;
	return (g[KEY] ??= { usage: new Map() });
}

export function usagePath(): string {
	return join(agentDir(), "brigadev-usage.json");
}

export function recordUsage(provider: string, snapshot: UsageSnapshot): void {
	const state = usageState();
	state.usage.set(provider, snapshot);
	try {
		writeJsonAtomic(usagePath(), Object.fromEntries(state.usage));
	} catch {
		// Display state only; never fail a turn over it.
	}
}

/** Loads recent snapshots from disk; never overrides a fresher in-memory one. */
export function loadUsage(now: number): void {
	const path = usagePath();
	if (!existsSync(path)) return;
	try {
		const saved = JSON.parse(readFileSync(path, "utf8")) as Record<string, UsageSnapshot>;
		const state = usageState();
		for (const [provider, snapshot] of Object.entries(saved)) {
			if (!snapshot || now - snapshot.observedAt > SNAPSHOT_MAX_AGE_MS) continue;
			const current = state.usage.get(provider);
			if (!current || current.observedAt < snapshot.observedAt) state.usage.set(provider, snapshot);
		}
	} catch {
		// A corrupt file is ignored and rewritten on the next observation.
	}
}
