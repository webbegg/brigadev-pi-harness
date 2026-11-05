// pi-claude-bridge starts Claude Code with the user's settings on every Pi
// turn, so the user's Claude Code hooks and plugin hooks (memory, telemetry,
// skill registries) run and inject their output into each turn. Measured on
// bridge 0.10.0 with a trivial prompt: about 0.8k extra prompt tokens, 0.3k
// extra output tokens (the model reacts to the injected text), and 7-9 s per
// turn, plus whatever files the hooks write into the repository.
//
// Until the bridge offers an option, this one-line patch adds Claude Code's
// own `disableAllHooks` setting to the bridge's provider-path settings. It
// affects only Claude Code processes the bridge starts; normal Claude Code
// sessions keep their hooks.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { agentDir } from "./runtime.ts";

export type BridgeHooksStatus = "hooks-enabled" | "hooks-disabled" | "unrecognized";

const ANCHOR = "\t\t\t\tincludeGitInstructions: false,\n\t\t\t},";
const PATCH_LINE = "\t\t\t\tdisableAllHooks: true, // brigadev: Claude Code hooks off for Pi turns";

export function bridgeHooksStatus(source: string): BridgeHooksStatus {
	if (/disableAllHooks\s*:/.test(source)) return "hooks-disabled";
	return source.includes(ANCHOR) ? "hooks-enabled" : "unrecognized";
}

/** Returns the patched source; never rewrites a source it does not recognize. */
export function patchBridgeHooks(source: string): { status: "patched" | "already-patched" | "unrecognized"; source: string } {
	const status = bridgeHooksStatus(source);
	if (status === "hooks-disabled") return { status: "already-patched", source };
	if (status === "unrecognized") return { status, source };
	return { status: "patched", source: source.replace(ANCHOR, `\t\t\t\tincludeGitInstructions: false,\n${PATCH_LINE}\n\t\t\t},`) };
}

export interface BridgeInstall {
	path: string;
	version?: string;
}

/** The bridge as Pi's managed npm install places it. */
export function findBridge(): BridgeInstall | undefined {
	const root = join(agentDir(), "npm", "node_modules", "pi-claude-bridge");
	const path = join(root, "src", "index.ts");
	if (!existsSync(path)) return undefined;
	let version: string | undefined;
	try {
		version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
	} catch {
		version = undefined;
	}
	return { path, version };
}

export function readBridgeStatus(install: BridgeInstall): BridgeHooksStatus {
	return bridgeHooksStatus(readFileSync(install.path, "utf8"));
}

export function applyBridgeHooksPatch(install: BridgeInstall): ReturnType<typeof patchBridgeHooks>["status"] {
	const result = patchBridgeHooks(readFileSync(install.path, "utf8"));
	if (result.status === "patched") writeFileSync(install.path, result.source, "utf8");
	return result.status;
}
