/**
 * brigadev doctor: read-only diagnostics, plus the opt-in fix for the
 * claude-bridge hook leak (see lib/bridge-hooks.ts).
 *
 *   /brigadev:doctor                    show checks
 *   /brigadev:doctor fix-bridge-hooks   patch the installed bridge (asks first)
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyBridgeHooksPatch, findBridge, readBridgeStatus } from "../lib/bridge-hooks.ts";
import { CLAUDE_BRIDGE_PROVIDER } from "../lib/cost.ts";
import { profilesPath, readProfiles } from "../lib/profiles-store.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { isChildSession, readSettings, settingsPath } from "../lib/runtime.ts";

const FIX = "fix-bridge-hooks";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let warned = false;

	const bridgeCheck = (): { ok: boolean; line: string } => {
		const bridge = findBridge();
		if (!bridge) return { ok: true, line: "claude-bridge: not installed through Pi's npm (nothing to check)" };
		const status = readBridgeStatus(bridge);
		const version = bridge.version ? ` ${bridge.version}` : "";
		if (status === "hooks-disabled") return { ok: true, line: `claude-bridge${version}: Claude Code hooks are off for Pi turns` };
		if (status === "hooks-enabled") {
			return { ok: false, line: `claude-bridge${version}: your Claude Code hooks run on every Pi turn (measured +~0.8k prompt and ~0.3k output tokens, 7-9 s per turn). Fix: /brigadev:doctor ${FIX}` };
		}
		return { ok: false, line: `claude-bridge${version}: unrecognized source, cannot check hooks (${bridge.path})` };
	};

	pi.on("session_start", async (_event, ctx: ExtensionContext) => {
		if (warned || !ctx.hasUI || ctx.model?.provider !== CLAUDE_BRIDGE_PROVIDER) return;
		const check = bridgeCheck();
		if (!check.ok) {
			warned = true;
			ctx.ui.notify(`brigadev: ${check.line}`, "warning");
		}
	});

	pi.registerCommand("brigadev:doctor", {
		description: `Diagnostics; "${FIX}" turns off Claude Code hooks inside claude-bridge turns`,
		getArgumentCompletions: (prefix) => (FIX.startsWith(prefix) ? [{ value: FIX, label: FIX }] : null),
		handler: async (args, ctx) => {
			if (args.trim() === FIX) {
				const bridge = findBridge();
				if (!bridge) return ctx.ui.notify("claude-bridge is not installed through Pi's npm; nothing to patch.", "error");
				const status = readBridgeStatus(bridge);
				if (status === "hooks-disabled") return ctx.ui.notify("Already done: Claude Code hooks are off for Pi turns.", "info");
				if (status === "unrecognized") return ctx.ui.notify(`This bridge version's source is not recognized; not patching ${bridge.path}.`, "error");
				const ok = ctx.hasUI
					? await ctx.ui.confirm(
							"Turn off Claude Code hooks inside Pi turns?",
							`Adds one line (disableAllHooks: true) to\n${bridge.path}\n\nYour normal Claude Code sessions keep their hooks. A bridge update undoes it; run this again after updating.`,
						)
					: false;
				if (!ok) return ctx.ui.notify("Not changed.", "info");
				const result = applyBridgeHooksPatch(bridge);
				return ctx.ui.notify(result === "patched" ? "Done. Restart Pi (or /reload) for new turns to run without hooks." : `Not changed (${result}).`, "info");
			}

			const lines: string[] = [];
			const mark = (ok: boolean, text: string) => lines.push(`${ok ? "✓" : "⚠"} ${text}`);
			const bridge = bridgeCheck();
			mark(bridge.ok, bridge.line);
			const profiles = readProfiles();
			if (!profiles.exists) mark(true, "profiles: none yet (/brigadev:profile init)");
			else mark(profiles.problems.length === 0, `profiles: ${Object.keys(profiles.file.profiles).length} in ${profilesPath()}, default ${profiles.file.active ?? "none"}${profiles.problems.length ? ` — ${profiles.problems.join("; ")}` : ""}`);
			const settings = readSettings();
			mark(true, `settings: ${settingsPath()} (default mode ${settings.defaultMode ?? "normal"}, bridge pricing ${settings.bridgePricing === false ? "off" : "on"}, footer ${settings.ui?.footer === false ? "off" : "on"}, phase ${settings.ui?.phase === false ? "off" : "on"})`);
			mark(true, `repo docs: ${repoDocsDir(ctx.cwd)} (feature documents in tasks/, review ledgers in reviews/)`);
			mark(true, `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
