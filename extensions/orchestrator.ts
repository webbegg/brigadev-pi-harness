/**
 * brigadev orchestrator: injects the ODD orchestrator contract into the
 * parent session's system prompt. Subagents never receive it.
 *
 * The prompt is re-read on every run, so editing assets/orchestrator.md
 * takes effect on the next prompt without /reload.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { appendSystemPromptOnce, ASSETS_ROOT, isChildSession, PACKAGE_ROOT, settingsPath } from "../lib/runtime.ts";

const HARNESS_ENTRY = "brigadev-harness";
const STATUS_KEY = "brigadev-harness";

function loadOrchestratorPrompt(): string {
	return readFileSync(join(ASSETS_ROOT, "orchestrator.md"), "utf8").replaceAll("{{ASSETS_ROOT}}", ASSETS_ROOT);
}

function packageVersion(): string {
	try {
		return JSON.parse(readFileSync(join(PACKAGE_ROOT, "package.json"), "utf8")).version ?? "unknown";
	} catch {
		return "unknown";
	}
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let enabled = true;

	const publishStatus = (ctx: ExtensionContext) => {
		if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, enabled ? undefined : "brigadev: harness off");
	};

	const restore = (ctx: ExtensionContext) => {
		enabled = true;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === HARNESS_ENTRY) {
				enabled = (entry.data as { enabled?: unknown } | undefined)?.enabled !== false;
			}
		}
		publishStatus(ctx);
	};

	pi.on("session_start", async (_event, ctx) => restore(ctx));
	pi.on("session_tree", async (_event, ctx) => restore(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		try {
			appendSystemPromptOnce(event.systemPromptOptions, loadOrchestratorPrompt());
		} catch (error) {
			if (ctx.hasUI) ctx.ui.notify(`brigadev: could not load orchestrator prompt (${String(error)})`, "error");
		}
	});

	pi.registerCommand("brigadev:harness", {
		description: "Turn the brigadev orchestrator prompt on or off for this session: on | off",
		getArgumentCompletions: (prefix) => ["on", "off"].filter((v) => v.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args, ctx) => {
			const value = args.trim();
			if (value !== "on" && value !== "off") return ctx.ui.notify(`brigadev harness is ${enabled ? "on" : "off"}. Usage: /brigadev:harness on|off`, "info");
			enabled = value === "on";
			pi.appendEntry(HARNESS_ENTRY, { enabled });
			publishStatus(ctx);
			ctx.ui.notify(`brigadev harness ${value} (takes effect on the next prompt)`, "info");
		},
	});

	pi.registerCommand("brigadev:status", {
		description: "Show brigadev harness status",
		handler: async (_args, ctx) => {
			ctx.ui.notify(
				[
					`brigadev-harness v${packageVersion()}`,
					`orchestrator prompt: ${enabled ? "on" : "off"}`,
					`assets: ${ASSETS_ROOT}`,
					`settings: ${settingsPath()}`,
					"commands: /brigadev:profile, /brigadev:cost, /brigadev:mode, /brigadev:agents, /brigadev:ui, /brigadev:harness, /review, /judgment-day, /track",
				].join("\n"),
				"info",
			);
		},
	});
}
