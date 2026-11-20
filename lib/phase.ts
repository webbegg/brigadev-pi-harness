// Infers the current step of the brigadev loop (assets/orchestrator.md) from what the agent does: no prompt
// change and no tokens. The guess is coarse on purpose and labeled `inferred` wherever it is shown.

import type { Phase, PhaseState } from "./bus.ts";
import { COMMAND_KIND, classifyCommand } from "./command-classifier.ts";
import { checkKind } from "./evidence.ts";

const EXPLORE_TOOLS = new Set(["read", "grep", "find", "ls"]);
const IMPLEMENT_TOOLS = new Set(["edit", "write"]);
const DELEGATE_TOOLS = new Set(["subagent", "acp_delegate"]);

// Agent names (brigadev agents and acp_delegate roles) by the loop step they serve.
const AGENT_PHASE: Record<string, Phase> = {
	"brigadev-explore": "explore",
	researcher: "explore",
	planner: "explore",
	oracle: "explore",
	"brigadev-worker": "implement",
	worker: "implement",
	"brigadev-verify": "check",
	"review-4r": "check",
	reviewer: "check",
};

const agentsOf = (args: Record<string, unknown>): string[] => {
	const one = typeof args.agent === "string" ? [args.agent] : [];
	const many = Array.isArray(args.tasks) ? args.tasks.map((t) => (t && typeof t === "object" ? (t as { agent?: unknown }).agent : undefined)) : [];
	return [...one, ...many].filter((a): a is string => typeof a === "string");
};

/** The loop step a tool call points to, or undefined when it says nothing about it. */
export function phaseForTool(toolName: string, args: unknown): Phase | undefined {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	if (EXPLORE_TOOLS.has(toolName)) return "explore";
	if (IMPLEMENT_TOOLS.has(toolName)) return "implement";
	if (toolName === "ask_user_choice") return "decide";
	if (toolName === "check") return "check";
	if (DELEGATE_TOOLS.has(toolName)) {
		const phases = agentsOf(a).map((name) => AGENT_PHASE[name]);
		return phases.every((p) => p === phases[0]) ? phases[0] : undefined;
	}
	if (toolName === "bash" && typeof a.command === "string") {
		if (classifyCommand(a.command).some((m) => m.kind === COMMAND_KIND.DELIVERY)) return "commit";
		if (checkKind(a.command)) return "check";
	}
	return undefined;
}

const describe = (toolName: string, args: unknown): string => {
	const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;
	const what = [a.path, a.command, a.pattern, a.agent, a.question].find((v): v is string => typeof v === "string");
	return what ? `${toolName} ${what.split("\n")[0].slice(0, 120)}` : toolName;
};

export interface PhaseTracker {
	state(): PhaseState;
	/** A run started; returns the new state. */
	agentStart(): PhaseState;
	/** A run ended; returns the new state. */
	agentEnd(): PhaseState;
	/** A tool started; returns the new state only when the phase changed. */
	tool(toolName: string, args: unknown): PhaseState | undefined;
}

export function createPhaseTracker(now: () => number = Date.now): PhaseTracker {
	let current: PhaseState = { scope: "loop", phase: "idle", since: now(), visited: [], running: false, source: "inferred" };
	const snapshot = (): PhaseState => ({ ...current, visited: [...current.visited] });
	const move = (phase: Phase, detail?: string) => {
		const visited = phase === "idle" || current.visited.includes(phase) ? current.visited : [...current.visited, phase];
		current = { ...current, phase, since: now(), visited, detail };
	};
	return {
		state: snapshot,
		agentStart() {
			current = { ...current, visited: [], running: true };
			move("authorize");
			return snapshot();
		},
		agentEnd() {
			current = { ...current, running: false };
			move("idle");
			return snapshot();
		},
		tool(toolName, args) {
			if (!current.running) return undefined;
			const phase = phaseForTool(toolName, args);
			if (!phase || phase === current.phase) return undefined;
			move(phase, describe(toolName, args));
			return snapshot();
		},
	};
}
