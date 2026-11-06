// Infers the orchestrator's ODD phase from the tool it is about to run, for
// the working label. Best effort: unknown tools keep the current phase.

import { isShellLookup } from "./exploration-budget.ts";

export type OddPhase = "exploring" | "planning" | "implementing" | "checking" | "delegating" | "deciding" | "delivering";

const CHECK_COMMAND = /\b(npm|pnpm|yarn|bun)\s+(run\s+)?(test|lint|typecheck|check|build)\b|\bnode\s+--test\b|\b(vitest|jest|pytest|tsc|eslint|cargo\s+(test|check|build)|go\s+(test|vet|build)|make\s+(test|check))\b/;
const DELIVERY_COMMAND = /\bgit\s+(commit|push|tag)\b|\bgh\s+(pr|issue|release)\s+(create|merge|comment|edit)\b/;

export function inferPhase(toolName: string, input: Record<string, unknown> | undefined): { phase: OddPhase; detail?: string } | undefined {
	const path = typeof input?.path === "string" ? input.path : "";
	switch (toolName) {
		case "read":
		case "grep":
		case "find":
		case "ls":
			return { phase: "exploring" };
		case "edit":
		case "write":
			// Feature documents live in the repo docs folder, ~/.brigadev/<repo>/tasks/.
			return /(^|\/)\.brigadev\/[^/]+\/tasks\//.test(path) ? { phase: "planning" } : { phase: "implementing" };
		case "todo":
			return { phase: "planning" };
		case "ask_user_choice":
			return { phase: "deciding" };
		case "subagent": {
			const tasks = Array.isArray(input?.tasks) ? (input.tasks as Array<{ agent?: unknown }>) : undefined;
			const agents = tasks ? tasks.map((t) => String(t.agent ?? "?")) : [String(input?.agent ?? "?")];
			return { phase: "delegating", detail: agents.length > 1 ? `${agents.length} agents` : agents[0] };
		}
		case "bash": {
			const command = typeof input?.command === "string" ? input.command : "";
			if (DELIVERY_COMMAND.test(command)) return { phase: "delivering" };
			if (CHECK_COMMAND.test(command)) return { phase: "checking" };
			if (isShellLookup(command)) return { phase: "exploring" };
			return undefined;
		}
		default:
			return undefined;
	}
}

export function phaseLabel(phase: { phase: OddPhase; detail?: string }): string {
	return phase.detail ? `${phase.phase} · ${phase.detail}` : phase.phase;
}
