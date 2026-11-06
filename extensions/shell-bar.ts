/**
 * brigadev status bar: replaces Pi's footer with one line of segments.
 *
 *   ◆ mai-pi-harness main ±3 │ 🚀 yolo │ sonnet-5-5 · medium │ ctx ▰▰▰▱▱▱▱▱ 45% │ $0.42 API-eq │ ⚙ economy
 *
 * Segments drop out by priority on narrow terminals. Statuses other
 * extensions publish with setStatus are appended. /brigadev:ui toggles it.
 */

import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { contextGauge, KNOWN_STATUS_ORDER, layoutSegments, SEPARATOR, statusSegment, type Segment } from "../lib/shell-bar.ts";
import { isChildSession, readSettings, runUiCommand } from "../lib/runtime.ts";

const DIRTY_REFRESH_MS = 2000;
const FILE_TOOLS = new Set(["edit", "write", "bash"]);

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let dirty = 0;
	let requestRender: (() => void) | undefined;
	let lastDirtyRefresh = 0;

	const enabled = () => readSettings().ui?.footer !== false;

	const refreshDirty = async (ctx: ExtensionContext, force = false) => {
		const now = Date.now();
		if (!force && now - lastDirtyRefresh < DIRTY_REFRESH_MS) return;
		lastDirtyRefresh = now;
		const result = await pi.exec("git", ["status", "--porcelain"], { cwd: ctx.cwd, timeout: 3000 }).catch(() => undefined);
		const next = result && result.code === 0 ? result.stdout.split("\n").filter(Boolean).length : 0;
		if (next !== dirty) {
			dirty = next;
			requestRender?.();
		}
	};

	const install = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (!enabled()) {
			ctx.ui.setFooter(undefined);
			requestRender = undefined;
			return;
		}
		ctx.ui.setFooter((tui, theme, footerData) => {
			requestRender = () => tui.requestRender();
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
			return {
				dispose() {
					unsubscribe();
					requestRender = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					const branch = footerData.getGitBranch();
					const gauge = contextGauge(ctx.getContextUsage()?.percent);
					const segments: Segment[] = [
						{ id: "repo", text: `◆ ${basename(ctx.cwd)}${branch ? ` ${branch}` : ""}${dirty ? ` ±${dirty}` : ""}`, tone: "muted", priority: 50 },
						{ id: "model", text: ctx.model ? `${ctx.model.id} · ${pi.getThinkingLevel()}` : "no model", tone: "text", priority: 80 },
						{ id: "ctx", text: gauge.text, tone: gauge.tone, priority: 70 },
					];
					const statuses = footerData.getExtensionStatuses();
					const keys = [...KNOWN_STATUS_ORDER.filter((k) => statuses.has(k)), ...[...statuses.keys()].filter((k) => !KNOWN_STATUS_ORDER.includes(k)).sort()];
					for (const key of keys) {
						const text = statuses.get(key)?.trim();
						const segment = text ? statusSegment(key, text) : undefined;
						if (segment) segments.push(segment);
					}
					// Keep the repo, model, and gauge first, then statuses in their published order.
					const kept = layoutSegments(segments, width, visibleWidth);
					const line = kept.map((s) => theme.fg(s.tone ?? "muted", s.text)).join(theme.fg("dim", SEPARATOR));
					return [truncateToWidth(line, width)];
				},
			};
		});
	};

	pi.on("session_start", async (_event, ctx) => {
		install(ctx);
		await refreshDirty(ctx, true);
	});
	pi.on("agent_end", async (_event, ctx) => refreshDirty(ctx, true));
	pi.on("tool_execution_end", async (event, ctx) => {
		if (FILE_TOOLS.has(event.toolName)) await refreshDirty(ctx);
	});
	pi.on("model_select", async () => requestRender?.());
	pi.on("thinking_level_select", async () => requestRender?.());
	pi.on("turn_end", async () => requestRender?.());

	pi.registerCommand("brigadev:ui", {
		description: "Toggle brigadev UI: footer on|off, phase on|off, dashboard on|off",
		getArgumentCompletions: (prefix) => {
			const items = ["footer on", "footer off", "phase on", "phase off", "dashboard on", "dashboard off"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value }));
			return items.length ? items : null;
		},
		handler: async (args, ctx) => {
			const { feature, message } = runUiCommand(args);
			if (feature === "footer") install(ctx);
			ctx.ui.notify(message, "info");
		},
	});
}
