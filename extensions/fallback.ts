/**
 * brigadev orchestrator fallback: when a run ends on a failure another model
 * can get past (quota, auth, rate limit, provider trouble, timeout,
 * network), switch the session to the next model of the profile's
 * orchestrator chain and continue the same conversation. Pi's own retries
 * run first; this acts at the final settle boundary. The chain is walked
 * once per episode, which ends with the next successful turn or prompt.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { classifyFailure, cooldownMs, launchOrder, priceNote } from "../lib/fallback.ts";
import { blockedReason, fallbackState } from "../lib/fallback-state.ts";
import { ORCHESTRATOR_KEY, resolveModelRef } from "../lib/model-routing.ts";
import { currentModelRef, listPrice, modelCatalog } from "../lib/pi-adapters.ts";
import { effectiveProfile, readProfiles } from "../lib/profiles-store.ts";
import { isChildSession } from "../lib/runtime.ts";

interface AssistantLike {
	role?: string;
	stopReason?: string;
	errorMessage?: string;
	content?: unknown;
}

const REQUEST_QUOTE_MAX = 2000;

/** Text of the user's latest request, so the continuation cannot drift to other work. */
function latestRequest(messages: readonly AssistantLike[]): string | undefined {
	const user = [...messages].reverse().find((m) => m.role === "user");
	const content = user?.content;
	const text = typeof content === "string" ? content : Array.isArray(content) ? content.filter((p) => p?.type === "text").map((p) => p.text).join("\n") : "";
	const trimmed = text.trim();
	return trimmed ? (trimmed.length > REQUEST_QUOTE_MAX ? `${trimmed.slice(0, REQUEST_QUOTE_MAX)}…` : trimmed) : undefined;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	// Models tried in the current failure episode.
	let attempted = new Set<string>();

	pi.on("input", async () => {
		attempted = new Set();
		return undefined;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const last = lastAssistant(ctx);
		if (last && last.stopReason !== "error") attempted = new Set();
	});

	pi.on("agent_before_settle", async (event, ctx) => {
		if (event.outcome !== "error") return undefined;
		const messages = event.context.llmMessages as AssistantLike[];
		const request = latestRequest(messages);
		const failedTurn = [...messages].reverse().find((m) => m.role === "assistant");
		const category = classifyFailure(failedTurn?.stopReason, failedTurn?.errorMessage);
		const current = currentModelRef(ctx);
		if (!category || !current) return undefined;

		const now = Date.now();
		fallbackState().cooldowns.cool(current, now + cooldownMs(category));
		attempted.add(current);

		const profile = effectiveProfile(readProfiles().file, ctx.sessionManager.getBranch()).profile;
		const route = profile?.[ORCHESTRATOR_KEY];
		if (!route?.fallbacks?.length) return undefined;
		const chain = launchOrder({ model: route.model ?? current, thinking: route.thinking }, route.fallbacks, (m) => blockedReason(m, now) !== undefined);

		for (const step of chain) {
			if (attempted.has(step.model) || blockedReason(step.model, now)) continue;
			attempted.add(step.model);
			const ref = resolveModelRef(step.model, modelCatalog(ctx), ctx.model?.provider);
			const model = "model" in ref ? ctx.modelRegistry.find(ref.model.provider, ref.model.id) : undefined;
			if (!model || !(await pi.setModel(model))) continue;
			if (step.thinking) pi.setThinkingLevel(step.thinking as Parameters<typeof pi.setThinkingLevel>[0]);
			const next = `${model.provider}/${model.id}`;
			if (ctx.hasUI) ctx.ui.notify(`brigadev: orchestrator hit ${category} on ${current} → continuing on ${next}${priceNote(listPrice(ctx, current), listPrice(ctx, next))}`, "warning");
			return {
				entries: [
					...event.entries,
					{ type: "custom" as const, customType: "brigadev-fallback", data: { agent: ORCHESTRATOR_KEY, from: current, to: next, category } },
					{
						type: "custom_message" as const,
						customType: "brigadev-fallback-continue",
						content: [
							`[brigadev] The previous model (${current}) failed with ${category}; you now run on ${next}.`,
							"Pick up the user's latest request exactly where the transcript above stops: do not repeat finished steps and do not start other work.",
							request ? `\nThe user's latest request:\n${request}` : "",
						].join("\n"),
						display: true,
					},
				],
				continue: true,
			};
		}
		if (ctx.hasUI) ctx.ui.notify(`brigadev: orchestrator hit ${category} on ${current}; no usable fallback left in the profile.`, "warning");
		return undefined;
	});

	function lastAssistant(ctx: ExtensionContext): AssistantLike | undefined {
		const branch = ctx.sessionManager.getBranch();
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			if (entry.type === "message" && entry.message.role === "assistant") return entry.message as AssistantLike;
		}
		return undefined;
	}
}
