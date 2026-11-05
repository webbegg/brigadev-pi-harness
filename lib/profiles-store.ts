import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emptyProfilesFile, parseProfilesFile, type Profile, type ProfilesFile } from "./model-routing.ts";
import { agentDir } from "./runtime.ts";

export const PROFILE_ENTRY = "brigadev-profile";

export function profilesPath(): string {
	return join(agentDir(), "brigadev-profiles.json");
}

export function readProfiles(path = profilesPath()): { file: ProfilesFile; problems: string[]; exists: boolean } {
	if (!existsSync(path)) return { file: emptyProfilesFile(), problems: [], exists: false };
	try {
		return { ...parseProfilesFile(JSON.parse(readFileSync(path, "utf8"))), exists: true };
	} catch (error) {
		return { file: emptyProfilesFile(), problems: [`cannot read ${path}: ${(error as Error).message}`], exists: true };
	}
}

/** Atomic replace: an interrupted write never leaves truncated JSON. */
export function writeJsonAtomic(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
	renameSync(tmp, path);
}

export function writeProfiles(file: ProfilesFile, path = profilesPath()): void {
	writeJsonAtomic(path, file);
}

interface BranchEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

/** Latest session binding on the branch: a profile name, null for an explicit clear, undefined for none. */
export function sessionBinding(entries: readonly BranchEntry[]): string | null | undefined {
	let binding: string | null | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== PROFILE_ENTRY) continue;
		const name = (entry.data as { name?: unknown } | undefined)?.name;
		binding = typeof name === "string" ? name : null;
	}
	return binding;
}

export interface EffectiveProfile {
	name?: string;
	profile?: Profile;
	source: "session" | "default" | "none";
	/** A session binding whose profile no longer exists. */
	missing?: string;
}

export function effectiveProfile(file: ProfilesFile, entries: readonly BranchEntry[]): EffectiveProfile {
	const bound = sessionBinding(entries);
	if (typeof bound === "string") {
		if (file.profiles[bound]) return { name: bound, profile: file.profiles[bound], source: "session" };
		return { source: "none", missing: bound, ...(file.active ? { name: file.active, profile: file.profiles[file.active], source: "default" as const } : {}) };
	}
	if (file.active && file.profiles[file.active]) return { name: file.active, profile: file.profiles[file.active], source: "default" };
	return { source: "none" };
}

/**
 * Sets Pi's default model and thinking level for new sessions, preserving
 * every other key. Refuses to overwrite a settings file it cannot parse.
 */
export function writePiDefaultModel(provider: string, modelId: string, thinking?: string): string {
	const path = join(agentDir(), "settings.json");
	let settings: Record<string, unknown> = {};
	if (existsSync(path)) {
		const parsed = JSON.parse(readFileSync(path, "utf8"));
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} is not a JSON object; left unchanged`);
		settings = parsed;
	}
	settings.defaultProvider = provider;
	settings.defaultModel = modelId;
	if (thinking) settings.defaultThinkingLevel = thinking;
	writeJsonAtomic(path, settings);
	return path;
}
