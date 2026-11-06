/**
 * brigadev cost: API-equivalent cost visibility.
 *
 * - Prices zero-cost claude-bridge turns at the Anthropic list price when they
 *   end, so Pi's own footer, session files, and this tally show real numbers.
 *   Disable with {"bridgePricing": false} in ~/.pi/agent/brigadev.json.
 * - Tallies the parent session and every subagent run on the current branch.
 * - /brigadev:cost shows the breakdown per model and per agent.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { addUsage, cacheHitRate, CLAUDE_BRIDGE_PROVIDER, emptyTally, formatCost, formatTokens, priceBridgeMessage, type Tally, type UsageLike } from "../lib/cost.ts";
import { panelState } from "../lib/panel-state.ts";
import { costCalculator } from "../lib/pi-adapters.ts";
import { isChildSession, readSettings } from "../lib/runtime.ts";

const STATUS_KEY = "brigadev-cost";

interface SubagentRunDetails {
	agent: string;
	model?: string;
	usage?: Tally;
}

interface State {
	parentByModel: Map<string, Tally>;
	agents: Map<string, Tally & { runs: number; models: Set<string> }>;
	usesBridge: boolean;
}

const newState = (): State => ({ parentByModel: new Map(), agents: new Map(), usesBridge: false });

function total(tallies: Iterable<Tally>): Tally {
	const sum = emptyTally();
	for (const t of tallies) {
		sum.turns += t.turns;
		sum.input += t.input;
		sum.output += t.output;
		sum.cacheRead += t.cacheRead;
		sum.cacheWrite += t.cacheWrite;
		sum.cost += t.cost;
	}
	return sum;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let state = newState();
	const pricingEnabled = () => readSettings().bridgePricing !== false;

	const recordAssistant = (message: { provider?: unknown; model?: unknown; usage?: UsageLike }) => {
		const key = `${String(message.provider ?? "?")}/${String(message.model ?? "?")}`;
		const tally = state.parentByModel.get(key) ?? emptyTally();
		addUsage(tally, message.usage);
		state.parentByModel.set(key, tally);
		if (message.provider === CLAUDE_BRIDGE_PROVIDER) state.usesBridge = true;
	};

	const recordSubagents = (details: unknown) => {
		const results = (details as { results?: SubagentRunDetails[] } | undefined)?.results ?? [];
		for (const run of results) {
			if (!run?.agent || !run.usage) continue;
			const tally = state.agents.get(run.agent) ?? { ...emptyTally(), runs: 0, models: new Set<string>() };
			tally.runs++;
			tally.turns += run.usage.turns;
			tally.input += run.usage.input;
			tally.output += run.usage.output;
			tally.cacheRead += run.usage.cacheRead ?? 0;
			tally.cacheWrite += run.usage.cacheWrite ?? 0;
			tally.cost += run.usage.cost;
			if (run.model) tally.models.add(run.model);
			state.agents.set(run.agent, tally);
		}
	};

	const sessionTotal = () => total([...state.parentByModel.values(), ...state.agents.values()]);

	const publishStatus = (ctx: ExtensionContext) => {
		const sum = sessionTotal();
		panelState().publish("cost", { cost: sum.cost, apiEquivalent: state.usesBridge });
		if (!ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, sum.cost > 0 ? `${formatCost(sum.cost)}${state.usesBridge ? " API-eq" : ""}` : undefined);
	};

	const reconstruct = (ctx: ExtensionContext) => {
		state = newState();
		const price = costCalculator(ctx);
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const message = entry.message as { role: string; toolName?: string; details?: unknown; provider?: unknown; model?: unknown; usage?: UsageLike };
			if (message.role === "assistant") recordAssistant(pricingEnabled() ? (priceBridgeMessage(message, price) ?? message) : message);
			else if (message.role === "toolResult" && message.toolName === "subagent") recordSubagents(message.details);
		}
		publishStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("message_end", async (event, ctx) => {
		const message = event.message as { role: string; provider?: unknown; model?: unknown; usage?: UsageLike };
		if (message.role !== "assistant") return undefined;
		const priced = pricingEnabled() ? priceBridgeMessage(message, costCalculator(ctx)) : undefined;
		recordAssistant(priced ?? message);
		publishStatus(ctx);
		return priced ? { message: priced as typeof event.message } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		if (event.toolName !== "subagent") return undefined;
		recordSubagents(event.details);
		publishStatus(ctx);
		return undefined;
	});

	pi.registerCommand("brigadev:cost", {
		description: "Session cost breakdown: orchestrator per model and subagents per agent",
		handler: async (_args, ctx) => {
			const parent = total(state.parentByModel.values());
			const agents = total(state.agents.values());
			const all = sessionTotal();
			const hit = (t: Tally) => {
				const rate = cacheHitRate(t);
				return rate === undefined ? "" : ` · cache ${Math.round(rate * 100)}%`;
			};
			const row = (label: string, t: Tally, extra = "") =>
				`  ${label.padEnd(36)} ${String(t.turns).padStart(4)} turns · ↑${formatTokens(t.input + t.cacheRead + t.cacheWrite)} ↓${formatTokens(t.output)}${hit(t)} · ${formatCost(t.cost)}${extra}`;

			const lines = [state.usesBridge ? "Session cost at API list price (claude-bridge runs on your subscription; this is what the tokens would cost on the API)" : "Session cost"];
			lines.push(`Orchestrator  ${formatCost(parent.cost)}`);
			for (const [model, t] of [...state.parentByModel].sort((a, b) => b[1].cost - a[1].cost)) lines.push(row(model, t));
			lines.push(`Subagents     ${formatCost(agents.cost)}`);
			if (state.agents.size === 0) lines.push("  (none)");
			for (const [agent, t] of [...state.agents].sort((a, b) => b[1].cost - a[1].cost)) {
				lines.push(row(`${agent} ×${t.runs}`, t, `  [${[...t.models].join(", ")}]`));
			}
			lines.push(`Total         ${formatCost(all.cost)}${hit(all)}`);
			if (!pricingEnabled()) lines.push('bridge pricing is off ({"bridgePricing": false} in brigadev.json)');
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
