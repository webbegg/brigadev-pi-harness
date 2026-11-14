import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { compactToolsMode, tidyActive } from "./tidy-detect.ts";

/** Package root, resolved from this file so it works from any install location. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ASSETS_ROOT = join(PACKAGE_ROOT, "assets");
export const PACKAGE_AGENTS_DIR = join(ASSETS_ROOT, "agents");
export const PACKAGE_WORKFLOWS_DIR = join(ASSETS_ROOT, "workflows");
export const GUARD_EXTENSION_PATH = join(PACKAGE_ROOT, "extensions", "guard.ts");
/** Loaded with -e in every child (and from package.json in the parent): records check runs as evidence. */
export const EVIDENCE_EXTENSION_PATH = join(PACKAGE_ROOT, "extensions", "evidence.ts");
/** Child-only: loaded with -e for agents that declare an output schema; not in package.json. */
export const STRUCTURED_OUTPUT_EXTENSION_PATH = join(PACKAGE_ROOT, "extensions", "structured-output.ts");

/** Environment contract between the parent session and subagent processes. */
export const CHILD_ENV = {
	CHILD: "BRIGADEV_CHILD",
	AGENT: "BRIGADEV_AGENT",
	PROJECT_ROOT: "BRIGADEV_PROJECT_ROOT",
	ALLOWED_SURFACES: "BRIGADEV_ALLOWED_SURFACES",
	READ_ONLY: "BRIGADEV_READ_ONLY",
	/** Absolute path of the agent's output JSON Schema. */
	OUTPUT_SCHEMA: "BRIGADEV_OUTPUT_SCHEMA",
} as const;

export function isChildSession(env: NodeJS.ProcessEnv = process.env): boolean {
	return env[CHILD_ENV.CHILD] === "1";
}

export function childAllowedSurfaces(env: NodeJS.ProcessEnv = process.env): string[] | undefined {
	const raw = env[CHILD_ENV.ALLOWED_SURFACES];
	if (!raw) return undefined;
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Appends a block to systemPromptOptions.appendSystemPrompt exactly once.
 * Mutating the structured options (instead of returning a replacement
 * systemPrompt) is what reaches every provider, including pi-claude-bridge,
 * which forwards only systemPromptOptions.
 */
export function appendSystemPromptOnce(options: { appendSystemPrompt?: string } | undefined, text: string): void {
	const block = text.trim();
	if (!options || !block) return;
	const current = options.appendSystemPrompt ?? "";
	if (current.includes(block)) return;
	options.appendSystemPrompt = current ? `${current}\n\n${block}` : block;
}

export interface BrigadevSettings {
	defaultMode?: string;
	/** Price zero-cost claude-bridge turns at the Anthropic list price (default true). */
	bridgePricing?: boolean;
	/** UI features, each on by default. */
	ui?: {
		footer?: boolean;
		phase?: boolean;
		dashboard?: boolean;
		/**
		 * Our one-line rows for built-in tools. "auto" (default) steps aside when pi-tidy is
		 * active, true = always ours, false = never ours.
		 */
		compactTools?: "auto" | boolean;
	};
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function settingsPath(): string {
	return join(agentDir(), "brigadev.json");
}

/**
 * Effective compact-tools mode from public data only: Pi `packages` (pass `pi.getSettings().packages`,
 * which is unavailable while an extension loads), the agent dir `extensions/` listing and the raw
 * global Pi settings.json. Unreadable inputs count as "no extension / default config".
 */
export function resolveCompactTools(packages: readonly unknown[] | undefined): { ours: boolean; reason: string } {
	let extensionEntries: string[] = [];
	try {
		extensionEntries = readdirSync(join(agentDir(), "extensions"));
	} catch {}
	let piSettings: unknown;
	try {
		piSettings = JSON.parse(readFileSync(join(agentDir(), "settings.json"), "utf8"));
	} catch {}
	const active = tidyActive({ packages, extensionEntries, piSettings });
	return compactToolsMode(readSettings().ui?.compactTools, active);
}

export function readSettings(): BrigadevSettings {
	const path = settingsPath();
	if (!existsSync(path)) return {};
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		return parsed && typeof parsed === "object" ? parsed : {};
	} catch {
		return {};
	}
}

export function writeSettings(update: BrigadevSettings): void {
	const path = settingsPath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...readSettings(), ...update }, null, 2)}\n`, "utf8");
}

const UI_FEATURES = ["footer", "phase", "dashboard"] as const;
export type UiFeature = (typeof UI_FEATURES)[number];

export interface UiSettingsStore {
	read: () => BrigadevSettings;
	write: (update: BrigadevSettings) => void;
}

/**
 * `/brigadev:ui <feature> on|off`: saves the setting and names the result. Anything else changes nothing and
 * answers with the current state and the usage. `feature` is set only when a setting was written.
 */
export function runUiCommand(args: string, store: UiSettingsStore = { read: readSettings, write: writeSettings }): { feature?: UiFeature; message: string } {
	const [feature, value] = args.trim().split(/\s+/);
	const ui = store.read().ui ?? {};
	if ((UI_FEATURES as readonly string[]).includes(feature) && (value === "on" || value === "off")) {
		store.write({ ui: { ...ui, [feature]: value === "on" } });
		return { feature: feature as UiFeature, message: `brigadev ${feature} ${value}` };
	}
	return { message: `footer: ${ui.footer === false ? "off" : "on"} · phase: ${ui.phase === false ? "off" : "on"} · dashboard: ${ui.dashboard === false ? "off" : "on"}\nUsage: /brigadev:ui footer|phase|dashboard on|off` };
}
