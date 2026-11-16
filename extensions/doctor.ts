/**
 * brigadev doctor: read-only diagnostics, plus the opt-in fix for the
 * claude-bridge hook leak (see lib/bridge-hooks.ts).
 *
 *   /brigadev:doctor                    show checks
 *   /brigadev:doctor fix-bridge-hooks   patch the installed bridge (asks first)
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyBridgeHooksPatch, findBridge, readBridgeStatus } from "../lib/bridge-hooks.ts";
import { CLAUDE_BRIDGE_PROVIDER } from "../lib/cost.ts";
import { credLockLine } from "../lib/dsp-credlock.ts";
import { defaultModeWarning } from "../lib/dsp-policy.ts";
import { isPermissionMode, PERMISSION_MODE } from "../lib/permission-policy.ts";
import { profilesPath, readProfiles } from "../lib/profiles-store.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { isChildSession, readSettings, settingsPath } from "../lib/runtime.ts";
import { resolveTidy } from "./tidy-bundled.ts";

const FIX = "fix-bridge-hooks";

/** The session's permission mode, restored as the guard does: the saved default, then the last `brigadev-mode` entry of the branch. */
function sessionMode(ctx: ExtensionContext, saved: unknown): string {
	let mode: unknown = saved;
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === "brigadev-mode") mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		}
	} catch {
		// No session to read: the saved default stands.
	}
	return isPermissionMode(mode) ? mode : PERMISSION_MODE.NORMAL;
}

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
			const dspWarning = defaultModeWarning(settings.defaultMode);
			if (dspWarning) mark(false, dspWarning);
			if (sessionMode(ctx, settings.defaultMode) === PERMISSION_MODE.DSP) {
				const lockLine = credLockLine();
				mark(!lockLine.includes("NOT APPLIED"), lockLine);
				// libcurl reads ~/.netrc for git over https, and the lock does not take it away.
				if (existsSync(join(homedir(), ".netrc"))) mark(false, "~/.netrc can authenticate git over https; the DSP credential lock does not cover it");
			}
			let packages: unknown[] | undefined;
			try {
				packages = pi.getSettings().packages;
			} catch {}
			const tidy = resolveTidy(packages);
			const tidyLine = { separate: "separate install (takes precedence over the bundled copy)", bundled: "bundled with brigadev", off: "off (not available, or tidy.enabled is false)" }[tidy.state];
			mark(true, `pi-tidy: ${tidyLine}`);
			mark(true, `compact tool rows: ${tidy.ours ? "on" : "off"} (${tidy.reason})`);
			mark(true, `repo docs: ${repoDocsDir(ctx.cwd)} (feature documents in tasks/, review ledgers in reviews/)`);
			mark(true, `model: ${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "none"}`);
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
