import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Package root, resolved from this file so it works from any install location. */
export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ASSETS_ROOT = join(PACKAGE_ROOT, "assets");
export const PACKAGE_AGENTS_DIR = join(ASSETS_ROOT, "agents");
export const GUARD_EXTENSION_PATH = join(PACKAGE_ROOT, "extensions", "guard.ts");

/** Environment contract between the parent session and subagent processes. */
export const CHILD_ENV = {
	CHILD: "BRIGADEV_CHILD",
	AGENT: "BRIGADEV_AGENT",
	PROJECT_ROOT: "BRIGADEV_PROJECT_ROOT",
	ALLOWED_SURFACES: "BRIGADEV_ALLOWED_SURFACES",
	READ_ONLY: "BRIGADEV_READ_ONLY",
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
}

export function agentDir(): string {
	return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

export function settingsPath(): string {
	return join(agentDir(), "brigadev.json");
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
