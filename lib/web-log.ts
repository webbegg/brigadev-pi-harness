// The web UI's in-memory event log: every event gets a monotonically increasing `seq`, and `since(seq)` replays what
// a (re)connecting browser missed. Memory is bounded, and a replay stays a consistent snapshot:
// - a keyed type (a `latest`/`stream` bus channel, or one of the core UI types below) keeps only its newest event
//   per key, so replaying an old key never shows a stale value. A per-item type (tool, agent, prompt) has its own cap
//   per type; a singleton type (one snapshot per session: mode, todo, phase, session, run, live text) has none, so
//   churn in one type never evicts another;
// - an unkeyed type (a `live` channel, messages) keeps the last N overall.
// Pure and dependency-free: the server (lib/web-server.ts) and the extension (extensions/web-ui.ts) share it.

import { CHANNELS } from "./bus.ts";

export interface WebEventInput {
	type: string;
	data: unknown;
	/** Overrides the key read from `data`. */
	key?: string;
}

export interface WebEvent {
	seq: number;
	/** ms since epoch. */
	at: number;
	type: string;
	key?: string;
	data: unknown;
}

export interface WebLogOptions {
	/** Unkeyed events kept, newest. */
	maxUnkeyed?: number;
	/** Distinct keys kept per per-item type, newest. Singleton types are exempt. */
	maxKeyed?: number;
	/** Type → payload field that is its key; merged over the defaults. */
	keyed?: Record<string, string>;
}

/** UI-only event types the extension builds from Pi's core events, and the payload field that keys each. */
export const CORE_KEYED_TYPES: Record<string, string> = { run: "id", tool: "id", assistant_live: "id", session: "id" };
/** Of those, the ones with one snapshot per session. */
export const CORE_SINGLETON_TYPES: readonly string[] = ["run", "assistant_live", "session"];

function singletonTypes(): Set<string> {
	const types = new Set(CORE_SINGLETON_TYPES);
	for (const spec of Object.values(CHANNELS)) if (spec.singleton) types.add(spec.as);
	return types;
}

function defaultKeyed(): Record<string, string> {
	const keyed: Record<string, string> = { ...CORE_KEYED_TYPES };
	for (const spec of Object.values(CHANNELS)) if (spec.key && spec.delivery !== "live") keyed[spec.as] = spec.key;
	return keyed;
}

export interface WebLog {
	append(input: WebEventInput): WebEvent;
	/** Events with a seq greater than `seq`, in seq order. */
	since(seq: number): WebEvent[];
	/** The seq of the newest event, 0 when empty. */
	lastSeq(): number;
	/** Called with each appended event; returns the unsubscribe. A throwing listener is ignored. */
	subscribe(listener: (event: WebEvent) => void): () => void;
}

export function createWebLog(options: WebLogOptions = {}): WebLog {
	const maxUnkeyed = Math.max(1, options.maxUnkeyed ?? 500);
	const maxKeyed = Math.max(1, options.maxKeyed ?? 2000);
	const keyed = { ...defaultKeyed(), ...options.keyed };
	const singletons = singletonTypes();
	// Per type, key → newest event. Map iteration is insertion order: delete + set moves a key to the newest end.
	const snapshots = new Map<string, Map<string, WebEvent>>();
	const unkeyed: WebEvent[] = [];
	const listeners = new Set<(event: WebEvent) => void>();
	let seq = 0;

	const keyOf = (input: WebEventInput): string | undefined => {
		if (input.key !== undefined) return input.key;
		const field = keyed[input.type];
		if (!field || !input.data || typeof input.data !== "object") return undefined;
		const value = (input.data as Record<string, unknown>)[field];
		return typeof value === "string" || typeof value === "number" ? String(value) : undefined;
	};

	return {
		append(input) {
			const key = keyOf(input);
			const event: WebEvent = { seq: ++seq, at: Date.now(), type: input.type, ...(key !== undefined ? { key } : {}), data: input.data };
			if (key !== undefined) {
				let ofType = snapshots.get(input.type);
				if (!ofType) snapshots.set(input.type, (ofType = new Map()));
				ofType.delete(key);
				ofType.set(key, event);
				if (!singletons.has(input.type)) while (ofType.size > maxKeyed) ofType.delete(ofType.keys().next().value as string);
			} else {
				unkeyed.push(event);
				if (unkeyed.length > maxUnkeyed) unkeyed.splice(0, unkeyed.length - maxUnkeyed);
			}
			for (const listener of [...listeners]) {
				try {
					listener(event);
				} catch {
					// A broken subscriber must not break the producer.
				}
			}
			return event;
		},
		since(after) {
			const out: WebEvent[] = [];
			for (const ofType of snapshots.values()) for (const e of ofType.values()) if (e.seq > after) out.push(e);
			for (const e of unkeyed) if (e.seq > after) out.push(e);
			return out.sort((a, b) => a.seq - b.seq);
		},
		lastSeq: () => seq,
		subscribe(listener) {
			listeners.add(listener);
			return () => void listeners.delete(listener);
		},
	};
}
