/**
 * brigadev usage: Claude subscription windows (5h, weekly) from each
 * response's rate-limit headers. Shown in the status bar, detailed by
 * /brigadev:usage, and consulted by fallback chains so a launch skips a
 * provider whose limit is spent instead of failing first.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fallbackState, loadUsage, recordUsage, usagePath } from "../lib/fallback-state.ts";
import { isChildSession } from "../lib/runtime.ts";
import { formatUsage, parseUsageHeaders, spentUntil, windowLabel, type UsageSnapshot } from "../lib/usage-windows.ts";

const STATUS_KEY = "brigadev-usage";

function when(unixSeconds: number | undefined): string {
	if (!unixSeconds) return "unknown";
	const date = new Date(unixSeconds * 1000);
	const sameDay = date.toDateString() === new Date().toDateString();
	return sameDay ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : date.toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" });
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	const publish = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const provider = ctx.model?.provider;
		const snapshot = provider ? fallbackState().usage.get(provider) : undefined;
		ctx.ui.setStatus(STATUS_KEY, snapshot && snapshot.windows.length + (snapshot.status === "rejected" ? 1 : 0) > 0 ? formatUsage(snapshot) : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		loadUsage(Date.now());
		publish(ctx);
	});
	pi.on("model_select", async (_event, ctx) => publish(ctx));

	pi.on("after_provider_response", async (event, ctx) => {
		const snapshot = parseUsageHeaders(event.headers as Record<string, string | undefined>, Date.now());
		const provider = ctx.model?.provider;
		if (!snapshot || !provider) return;
		recordUsage(provider, snapshot);
		publish(ctx);
	});

	pi.registerCommand("brigadev:usage", {
		description: "Subscription usage windows per provider (5h, weekly) and when they reset",
		handler: async (_args, ctx) => {
			loadUsage(Date.now());
			const usage = [...fallbackState().usage] as Array<[string, UsageSnapshot]>;
			if (usage.length === 0) return ctx.ui.notify("No usage reported yet. It appears after the first response from a provider that sends rate-limit headers (claude-bridge, Anthropic).", "info");
			const now = Date.now();
			const lines: string[] = [];
			for (const [provider, s] of usage) {
				const age = Math.round((now - s.observedAt) / 60_000);
				const spent = spentUntil(s, now);
				lines.push(`${provider}: ${spent ? "LIMIT REACHED" : (s.status ?? "unknown")}${s.claim ? ` · binding: ${s.claim}` : ""}${s.overageStatus ? ` · extra usage: ${s.overageStatus}` : ""} · seen ${age} min ago`);
				for (const w of s.windows) {
					const percent = Math.round(w.utilization * 100);
					const bar = "▰".repeat(Math.round(percent / 10)) + "▱".repeat(10 - Math.round(Math.min(100, percent) / 10));
					lines.push(`  ${windowLabel(w.name).padEnd(10)} ${bar} ${String(percent).padStart(3)}%  resets ${when(w.resetsAt)}`);
				}
				if (spent) lines.push(`  fallback chains skip ${provider} until ${new Date(spent).toLocaleTimeString()}`);
			}
			lines.push(`(${usagePath()})`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
