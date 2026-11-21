// The brigadev bus: typed `brigadev:*` channels on Pi's shared event bus (`pi.events`), the one contract between
// the harness extensions that produce workflow state and the UIs that show it (the brigadev web UI, the
// pi-agent-dashboard adapter). Every outbound payload is a full, idempotent snapshot of one keyed thing, so a
// consumer that drops or reorders a frame only ever shows a stale value, never a corrupt one.
// Inbound actions (answers, cancels) arrive on one channel and are validated here: they come from a browser.

/** The subset of Pi's `EventBus` the harness uses. */
export interface Bus {
	emit(channel: string, data: unknown): void;
	on(channel: string, handler: (data: unknown) => void): () => void;
}

export const BUS = {
	/** Inferred loop phase. latest, key `scope`. */
	phase: "brigadev:phase",
	/** The todo list. latest, key `scope`. */
	todo: "brigadev:todo",
	/** One finished `check` run. live. */
	check: "brigadev:check",
	/** One subagent task. stream, key `id`. */
	agent: "brigadev:agent",
	/** One human prompt (guard confirm, ask_user_choice), from open to settled. latest, key `id`. */
	prompt: "brigadev:prompt",
	/** One guard decision on a tool call. live. */
	guard: "brigadev:guard",
	/** The guard's permission mode. latest, key `scope`. */
	mode: "brigadev:mode",
	/** Inbound: a UI asks the harness to do something. */
	action: "brigadev:action",
} as const;
export type Channel = (typeof BUS)[keyof typeof BUS];

export type Delivery = "live" | "latest" | "stream";
export interface ChannelSpec {
	/** Event type a consumer sees: `[a-z0-9_]` (the dashboard's rule). */
	as: string;
	delivery: Delivery;
	/** Payload field that identifies the snapshot; required for latest and stream. */
	key?: string;
	/** One snapshot per session (phase, todo, mode): a consumer that bounds its memory never evicts it. */
	singleton?: boolean;
}

/** Outbound channels and how a consumer should keep them. */
export const CHANNELS: Record<Exclude<Channel, typeof BUS.action>, ChannelSpec> = {
	[BUS.phase]: { as: "brigadev_phase", delivery: "latest", key: "scope", singleton: true },
	[BUS.todo]: { as: "brigadev_todo", delivery: "latest", key: "scope", singleton: true },
	[BUS.check]: { as: "brigadev_check", delivery: "live" },
	[BUS.agent]: { as: "brigadev_agent", delivery: "stream", key: "id" },
	[BUS.prompt]: { as: "brigadev_prompt", delivery: "latest", key: "id" },
	[BUS.guard]: { as: "brigadev_guard", delivery: "live" },
	[BUS.mode]: { as: "brigadev_mode", delivery: "latest", key: "scope", singleton: true },
};

/** The steps of the loop in `assets/orchestrator.md`, plus `idle` between runs. */
export const PHASES = ["authorize", "explore", "decide", "implement", "check", "commit", "close"] as const;
export type Phase = (typeof PHASES)[number] | "idle";

export interface PhaseState {
	scope: "loop";
	phase: Phase;
	/** When this phase began (ms). */
	since: number;
	/** Phases seen in the current agent run, in order of first appearance. */
	visited: Phase[];
	running: boolean;
	/** The phase is guessed from tool activity, not declared by the model. */
	source: "inferred";
	/** What moved it there, e.g. `edit lib/bus.ts`. */
	detail?: string;
}

export interface TodoItem {
	id: string;
	text: string;
	status: string;
	note?: string;
}
export interface TodoState {
	scope: "todo";
	todos: TodoItem[];
}

export interface CheckState {
	/** The tool call id. */
	id: string;
	command: string;
	outcome: string;
	exitCode?: number;
	counts?: unknown;
	durationMs?: number;
	at: number;
}

export type AgentStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export interface AgentState {
	/** `<launchId>:<index>`, stable for the task's life. */
	id: string;
	launchId: string;
	index: number;
	agent: string;
	/** First line of the task. */
	task: string;
	/** The whole task, capped. */
	taskText?: string;
	/** The launch's reason (delegation trigger or `Risk: ...`). */
	reason?: string;
	/** The child's most recent tool calls, oldest first. */
	steps?: AgentStep[];
	/** What the parent is told, once settled (capped). */
	output?: string;
	status: AgentStatus;
	model?: string;
	thinking?: string;
	tokens: number;
	cost: number;
	/** Latest assistant text, trimmed to its tail. */
	partial?: string;
	runId?: string;
	startedAt?: number;
	endedAt?: number;
	/** A UI may offer cancel. */
	cancellable: boolean;
}

export interface AgentStep {
	tool: string;
	/** Path, command or pattern of the call, capped. */
	summary: string;
}

export type PromptStatus = "open" | "answered" | "dismissed";
export interface PromptState {
	id: string;
	kind: "confirm" | "choice";
	/** Who asked: `guard`, `ask`, `subagents`. */
	source: string;
	title: string;
	body?: string;
	/** choice only. */
	options?: Array<{ label: string; description?: string }>;
	/** choice only, 1-based. */
	recommended?: number;
	allowOther?: boolean;
	status: PromptStatus;
	/** confirm: boolean; choice: the label or free text. */
	answer?: boolean | string;
	by?: "tui" | "web";
	at: number;
}

export interface GuardDecision {
	id: string;
	toolCallId?: string;
	tool?: string;
	/** The command or path judged. */
	subject?: string;
	action: "allow" | "confirm" | "block";
	reason?: string;
	at: number;
}

export interface ModeState {
	scope: "mode";
	mode: string;
}

export type Action =
	| { action: "answer"; id: string; value: boolean | string }
	| { action: "cancel-agent"; id: string }
	| { action: "prompt"; text: string; deliverAs?: "steer" | "followUp" }
	| { action: "abort" };

const MAX_TEXT = 20_000;
const MAX_ID = 200;
const shortString = (value: unknown, max = MAX_ID): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** The action, if `raw` is a well-formed one; anything else is undefined. */
export function parseAction(raw: unknown): Action | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const a = raw as Record<string, unknown>;
	switch (a.action) {
		case "answer":
			if (!shortString(a.id)) return undefined;
			if (typeof a.value === "boolean") return { action: "answer", id: a.id, value: a.value };
			if (shortString(a.value, MAX_TEXT)) return { action: "answer", id: a.id, value: a.value };
			return undefined;
		case "cancel-agent":
			return shortString(a.id) ? { action: "cancel-agent", id: a.id } : undefined;
		case "prompt": {
			if (!shortString(a.text, MAX_TEXT) || !a.text.trim()) return undefined;
			if (a.deliverAs !== undefined && a.deliverAs !== "steer" && a.deliverAs !== "followUp") return undefined;
			return a.deliverAs ? { action: "prompt", text: a.text, deliverAs: a.deliverAs } : { action: "prompt", text: a.text };
		}
		case "abort":
			return { action: "abort" };
		default:
			return undefined;
	}
}

/** Publishes one snapshot; a failing listener never breaks the producer. */
export function publish(bus: Bus | undefined, channel: Channel, data: unknown): void {
	if (!bus) return;
	try {
		bus.emit(channel, data);
	} catch {
		// A UI is an observer: its failure must not change what the harness does.
	}
}

/** Calls `handler` for every valid inbound action of `kind`; returns the unsubscribe. */
export function onAction<K extends Action["action"]>(bus: Bus | undefined, kind: K, handler: (action: Extract<Action, { action: K }>) => void): () => void {
	if (!bus) return () => {};
	return bus.on(BUS.action, (raw) => {
		const action = parseAction(raw);
		if (action?.action !== kind) return;
		try {
			handler(action as Extract<Action, { action: K }>);
		} catch {
			// One bad action must not take the bus down.
		}
	});
}

/** The tail of `text`, at most `max` characters, for live previews. */
export function tail(text: string | undefined, max = 600): string | undefined {
	if (!text) return undefined;
	return text.length <= max ? text : `…${text.slice(-max)}`;
}

/** A minimal in-memory `Bus`, for tests and for a session without `pi.events`. */
export function createBus(): Bus {
	const handlers = new Map<string, Set<(data: unknown) => void>>();
	return {
		emit(channel, data) {
			for (const h of [...(handlers.get(channel) ?? [])]) h(data);
		},
		on(channel, handler) {
			const set = handlers.get(channel) ?? new Set();
			set.add(handler);
			handlers.set(channel, set);
			return () => void set.delete(handler);
		},
	};
}
