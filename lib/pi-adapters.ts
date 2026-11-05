// Thin adapters over the Pi runtime, shared by several extensions. Pure
// logic stays in the other lib modules so it can be tested without Pi.

import { join } from "node:path";
import { calculateCost } from "@earendil-works/pi-ai";
import { getAgentDir, parseFrontmatter, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { discoverAgents, type AgentDefinition } from "./agents.ts";
import { CLAUDE_BRIDGE_PROVIDER, LIST_PRICE_PROVIDER, type CostCalculator } from "./cost.ts";
import type { ModelId } from "./model-routing.ts";
import { PACKAGE_AGENTS_DIR } from "./runtime.ts";

export function loadAgents(ctx: ExtensionContext): AgentDefinition[] {
	return discoverAgents({
		packageAgentsDir: PACKAGE_AGENTS_DIR,
		userAgentsDir: join(getAgentDir(), "agents"),
		cwd: ctx.cwd,
		includeProject: ctx.isProjectTrusted(),
		parse: (content) => parseFrontmatter<Record<string, unknown>>(content),
	});
}

export function modelCatalog(ctx: ExtensionContext): ModelId[] {
	return ctx.modelRegistry.getAll().map((m) => ({ provider: m.provider, id: m.id }));
}

export function costCalculator(ctx: ExtensionContext): CostCalculator {
	return (provider, modelId, usage) => {
		const model = ctx.modelRegistry.find(provider, modelId);
		if (!model) return undefined;
		return calculateCost(model, usage as Parameters<typeof calculateCost>[1]);
	};
}

export function currentModelRef(ctx: ExtensionContext): string | undefined {
	return ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
}

/** List price per 1M tokens; claude-bridge models are priced as their Anthropic twins. */
export function listPrice(ctx: ExtensionContext, modelRef: string | undefined): { input: number; output: number } | undefined {
	if (!modelRef) return undefined;
	const slash = modelRef.indexOf("/");
	if (slash < 0) return undefined;
	const provider = modelRef.slice(0, slash);
	const id = modelRef.slice(slash + 1);
	const model = ctx.modelRegistry.find(provider === CLAUDE_BRIDGE_PROVIDER ? LIST_PRICE_PROVIDER : provider, id);
	return model ? { input: model.cost.input, output: model.cost.output } : undefined;
}
