/**
 * brigadev context control (S16): compacts before context gets expensive. No model-facing text, only a UI notice.
 *
 * - agent_settled (final idle, nothing running): context >= context.compactAt -> ctx.compact.
 *   (Pi compacts by itself only near the model's window; this is the cost threshold. It is not checked between tool
 *   turns of one run, so a single long run can pass the threshold; the next settle catches it.)
 * - input (new prompt): the previous assistant turn ended > context.idleCompactMinutes ago and context >=
 *   context.idleCompactMin -> compact first, then the prompt proceeds. Pi's `input` hook cannot wait for a compaction,
 *   and ctx.compact does not block, so the prompt is "handled" and resubmitted with pi.sendUserMessage once the
 *   compaction finishes (also when it fails). Typed prompts only: extension-sent, rpc, and queued (steer/follow-up) input passes, and so does every prompt of a session without a UI.
 *
 * Settings (brigadev.json, read on every decision): context.enabled, compactAt, idleCompactMinutes, idleCompactMin.
 * Never in children, never twice without a new turn in between.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMPACT_INSTRUCTIONS, type ControlState, decide, formatTokens, type Reason, recordCompaction, resolveContextSettings } from "../lib/context-control.ts";
import { isChildSession, readSettings } from "../lib/runtime.ts";

/** A compaction that has not called back by now counts as lost: the swallowed prompt is resubmitted anyway. */
const COMPACT_SAFETY_MS = 120_000;

/** When the last assistant message of the current branch was written (resumed sessions have no in-memory turn). */
function lastAssistantMs(ctx: ExtensionContext): number | undefined {
	let branch: any[] = [];
	try {
		branch = ctx.sessionManager.getBranch() as any[];
	} catch {
		return undefined;
	}
	for (let i = branch.length - 1; i >= 0; i--) {
		const message = branch[i]?.message;
		if (branch[i]?.type !== "message" || message?.role !== "assistant") continue;
		if (typeof message.timestamp === "number") return message.timestamp;
		const parsed = Date.parse(branch[i].timestamp);
		return Number.isNaN(parsed) ? undefined : parsed;
	}
	return undefined;
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let turnsSinceCompact = 1;
	let lastTurnEndMs: number | undefined;
	let inFlight = false;

	const settings = () => resolveContextSettings((readSettings() as Record<string, unknown>).context);
	const state = (ctx: ExtensionContext, trigger: ControlState["trigger"]): ControlState => ({
		child: false,
		trigger,
		tokens: ctx.getContextUsage()?.tokens,
		lastTurnEndMs: lastTurnEndMs ?? lastAssistantMs(ctx),
		turnsSinceCompact,
		busy: inFlight,
	});

	function compact(ctx: ExtensionContext, reason: Reason, tokens: number, then?: () => void): void {
		inFlight = true;
		turnsSinceCompact = 0;
		recordCompaction({ atMs: Date.now(), reason, tokens });
		ctx.ui.notify(`brigadev: compacting context (${formatTokens(tokens)} tokens, ${reason === "idle" ? "cache is cold after the idle gap" : "over the threshold"})`, "info");
		// Whichever of complete, error, a synchronous throw, or the safety timeout comes first settles it; the rest do nothing,
		// so the swallowed prompt is resubmitted exactly once and `inFlight` never sticks.
		let settled = false;
		let safety: ReturnType<typeof setTimeout> | undefined;
		const finish = (notice?: { message: string; type: "info" | "warning" }) => {
			if (settled) return;
			settled = true;
			if (safety !== undefined) clearTimeout(safety);
			inFlight = false;
			if (notice) ctx.ui.notify(notice.message, notice.type);
			then?.();
		};
		if (then) {
			safety = setTimeout(() => finish({ message: "brigadev: compaction did not report back; continuing with your prompt", type: "warning" }), COMPACT_SAFETY_MS);
			safety.unref?.();
		}
		try {
			ctx.compact({
				customInstructions: COMPACT_INSTRUCTIONS,
				onComplete: () => finish({ message: "brigadev: context compacted", type: "info" }),
				onError: (error: Error) => finish({ message: `brigadev: compaction failed (${error.message})`, type: "warning" }),
			});
		} catch (error) {
			finish({ message: `brigadev: compaction failed (${error instanceof Error ? error.message : String(error)})`, type: "warning" });
		}
	}

	pi.on("turn_end", async () => {
		turnsSinceCompact++;
		lastTurnEndMs = Date.now();
	});

	// Any compaction (ours, Pi's own, /compact) restarts the count; the next one needs a new turn.
	pi.on("session_compact", async () => {
		turnsSinceCompact = 0;
		inFlight = false;
	});

	pi.on("agent_settled", async (_event, ctx) => {
		lastTurnEndMs = Date.now();
		const s = state(ctx, "settled");
		const decision = decide(s, settings(), Date.now());
		if (decision.action === "compact") compact(ctx, decision.reason, s.tokens as number);
	});

	pi.on("input", async (event, ctx) => {
		// Only typed prompts of a session with a UI: an rpc client or a print-mode run has no one to resubmit a swallowed prompt.
		if (event.source === "extension" || event.source === "rpc" || event.streamingBehavior || !ctx.hasUI) return { action: "continue" as const };
		const s = state(ctx, "input");
		const decision = decide(s, settings(), Date.now());
		if (decision.action !== "compact") return { action: "continue" as const };
		const content = event.images?.length ? [{ type: "text" as const, text: event.text }, ...event.images] : event.text;
		// While the agent is running, a message needs a delivery mode; a follow-up waits for it to finish.
		compact(ctx, decision.reason, s.tokens as number, () => pi.sendUserMessage(content, ctx.isIdle() ? { expandPromptTemplates: true } : { expandPromptTemplates: true, deliverAs: "followUp" }));
		return { action: "handled" as const };
	});
}
