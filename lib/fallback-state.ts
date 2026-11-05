// Process-wide fallback state shared by the orchestrator fallback, the
// subagent runner, and the usage tracker (separate extensions): model
// cooldowns and the latest usage snapshot per provider. Usage snapshots are
// also kept on disk so a new session knows a window is spent.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Cooldowns, providerOf } from "./fallback.ts";
import { writeJsonAtomic } from "./profiles-store.ts";
import { agentDir } from "./runtime.ts";
import { spentUntil, type UsageSnapshot } from "./usage-windows.ts";

const KEY = Symbol.for("brigadev.fallback-state");
const SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60_000;

interface State {
	cooldowns: Cooldowns;
	usage: Map<string, UsageSnapshot>;
}

export function fallbackState(): State {
	const g = globalThis as Record<symbol, State | undefined>;
	return (g[KEY] ??= { cooldowns: new Cooldowns(), usage: new Map() });
}

export function usagePath(): string {
	return join(agentDir(), "brigadev-usage.json");
}

export function recordUsage(provider: string, snapshot: UsageSnapshot): void {
	const state = fallbackState();
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
		const state = fallbackState();
		for (const [provider, snapshot] of Object.entries(saved)) {
			if (!snapshot || now - snapshot.observedAt > SNAPSHOT_MAX_AGE_MS) continue;
			const current = state.usage.get(provider);
			if (!current || current.observedAt < snapshot.observedAt) state.usage.set(provider, snapshot);
		}
	} catch {
		// A corrupt file is ignored and rewritten on the next observation.
	}
}

/** Why a model should not be launched right now, or undefined when it can be. */
export function blockedReason(model: string, now: number): string | undefined {
	const state = fallbackState();
	if (state.cooldowns.isCooling(model, now)) return `cooling down until ${new Date(state.cooldowns.coolingUntil(model)!).toLocaleTimeString()}`;
	const provider = providerOf(model);
	const until = provider ? spentUntil(state.usage.get(provider), now) : undefined;
	return until ? `${provider} usage limit reached until ${new Date(until).toLocaleTimeString()}` : undefined;
}
