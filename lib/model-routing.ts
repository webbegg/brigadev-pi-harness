// Model routing: which model and thinking level each agent (and the
// orchestrator) uses. Profiles are named routing presets; one is active by
// default and a session can bind another.

export const ORCHESTRATOR_KEY = "orchestrator";
export const DEFAULT_KEY = "*";
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface FallbackStep {
	model: string;
	thinking?: ThinkingLevel;
}

export interface RouteEntry {
	/** Canonical "provider/model". */
	model?: string;
	thinking?: ThinkingLevel;
	/** Tried in order when a run fails on quota, auth, rate limit, or provider trouble. */
	fallbacks?: FallbackStep[];
}

export const MAX_FALLBACKS = 8;

/** Keys: agent names, prefix globs ending in "*" (e.g. "review-*"), "*", and "orchestrator". */
export type Profile = Record<string, RouteEntry>;

export interface ProfilesFile {
	version: 1;
	active?: string;
	profiles: Record<string, Profile>;
}

export const emptyProfilesFile = (): ProfilesFile => ({ version: 1, profiles: {} });

export function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return typeof value === "string" && (THINKING_LEVELS as readonly string[]).includes(value);
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype"]);

export function validateProfileName(name: string): string | undefined {
	if (!NAME.test(name) || RESERVED.has(name)) return `Invalid profile name "${name}": use 1-64 letters, digits, ".", "_", or "-", starting with a letter or digit`;
	return undefined;
}

function validKey(key: string): boolean {
	return key === DEFAULT_KEY || key === ORCHESTRATOR_KEY || /^[A-Za-z0-9][A-Za-z0-9._-]*\*?$/.test(key);
}

/** Parses a profiles file, dropping invalid parts and reporting each one. */
export function parseProfilesFile(raw: unknown): { file: ProfilesFile; problems: string[] } {
	const problems: string[] = [];
	const file = emptyProfilesFile();
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { file, problems: raw === undefined ? [] : ["profiles file is not a JSON object"] };
	const source = raw as { active?: unknown; profiles?: unknown };
	const profiles = source.profiles && typeof source.profiles === "object" && !Array.isArray(source.profiles) ? (source.profiles as Record<string, unknown>) : {};
	for (const [name, value] of Object.entries(profiles)) {
		const nameProblem = validateProfileName(name);
		if (nameProblem) {
			problems.push(nameProblem);
			continue;
		}
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			problems.push(`profile "${name}" is not an object`);
			continue;
		}
		const profile: Profile = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			if (!validKey(key)) {
				problems.push(`profile "${name}": invalid key "${key}"`);
				continue;
			}
			const e = (typeof entry === "string" ? { model: entry } : entry) as { model?: unknown; thinking?: unknown; fallbacks?: unknown } | null;
			if (!e || typeof e !== "object") {
				problems.push(`profile "${name}": "${key}" must be an object`);
				continue;
			}
			const route: RouteEntry = {};
			if (typeof e.model === "string" && e.model.trim()) route.model = e.model.trim();
			else if (e.model !== undefined) problems.push(`profile "${name}": "${key}".model must be a string`);
			if (isThinkingLevel(e.thinking)) route.thinking = e.thinking;
			else if (e.thinking !== undefined) problems.push(`profile "${name}": "${key}".thinking must be one of ${THINKING_LEVELS.join(", ")}`);
			if (e.fallbacks !== undefined) {
				const steps = parseFallbacks(e.fallbacks);
				problems.push(...steps.problems.map((p) => `profile "${name}": "${key}".fallbacks ${p}`));
				if (steps.steps.length) route.fallbacks = steps.steps;
			}
			if (route.model || route.thinking || route.fallbacks) profile[key] = route;
		}
		file.profiles[name] = profile;
	}
	if (typeof source.active === "string") {
		if (file.profiles[source.active]) file.active = source.active;
		else problems.push(`active profile "${source.active}" does not exist`);
	}
	return { file, problems };
}

function parseFallbacks(value: unknown): { steps: FallbackStep[]; problems: string[] } {
	if (!Array.isArray(value)) return { steps: [], problems: ["must be an array"] };
	const steps: FallbackStep[] = [];
	const problems: string[] = [];
	for (const item of value) {
		const step = (typeof item === "string" ? { model: item } : item) as { model?: unknown; thinking?: unknown } | null;
		if (!step || typeof step.model !== "string" || !step.model.trim()) {
			problems.push("entries need a model");
			continue;
		}
		if (steps.some((s) => s.model === step.model)) continue;
		if (steps.length >= MAX_FALLBACKS) {
			problems.push(`keep at most ${MAX_FALLBACKS} models`);
			break;
		}
		steps.push(isThinkingLevel(step.thinking) ? { model: step.model.trim(), thinking: step.thinking } : { model: step.model.trim() });
	}
	return { steps, problems };
}

/** Exact name, then the longest matching prefix glob, then "*". The orchestrator only matches its own key. */
export function routeFor(profile: Profile | undefined, agentName: string): { entry: RouteEntry; key: string } | undefined {
	if (!profile) return undefined;
	if (profile[agentName]) return { entry: profile[agentName], key: agentName };
	if (agentName === ORCHESTRATOR_KEY) return undefined;
	const globs = Object.keys(profile)
		.filter((k) => k !== DEFAULT_KEY && k.endsWith("*") && agentName.startsWith(k.slice(0, -1)))
		.sort((a, b) => b.length - a.length);
	if (globs[0]) return { entry: profile[globs[0]], key: globs[0] };
	if (profile[DEFAULT_KEY]) return { entry: profile[DEFAULT_KEY], key: DEFAULT_KEY };
	return undefined;
}

export type RouteSource = "profile" | "definition" | "parent" | "none";

export interface ResolvedRoute {
	model?: string;
	thinking?: string;
	modelSource: RouteSource;
	thinkingSource: RouteSource;
	/** Profile key that supplied a value, e.g. "review-*". */
	profileKey?: string;
}

/**
 * Precedence per field: profile route > agent definition (frontmatter) >
 * parent session. Thinking is inherited from the parent only when the model
 * is too, since a level tuned for one model rarely fits another.
 */
export function resolveAgentRoute(input: {
	profile?: Profile;
	agent: { name: string; model?: string; thinking?: string };
	parent: { model?: string; thinking?: string };
}): ResolvedRoute {
	const match = routeFor(input.profile, input.agent.name);
	const result: ResolvedRoute = { modelSource: "none", thinkingSource: "none", profileKey: match?.key };

	if (match?.entry.model) [result.model, result.modelSource] = [match.entry.model, "profile"];
	else if (input.agent.model) [result.model, result.modelSource] = [input.agent.model, "definition"];
	else if (input.parent.model) [result.model, result.modelSource] = [input.parent.model, "parent"];

	if (match?.entry.thinking) [result.thinking, result.thinkingSource] = [match.entry.thinking, "profile"];
	else if (input.agent.thinking) [result.thinking, result.thinkingSource] = [input.agent.thinking, "definition"];
	else if (result.modelSource === "parent" && input.parent.thinking) [result.thinking, result.thinkingSource] = [input.parent.thinking, "parent"];

	if (!match?.entry.model && !match?.entry.thinking) result.profileKey = undefined;
	return result;
}

export interface ModelId {
	provider: string;
	id: string;
}

/**
 * Resolves "provider/model" or a bare model id against the catalog. A bare
 * id prefers the given provider, otherwise it must be unique.
 */
export function resolveModelRef(ref: string, catalog: readonly ModelId[], preferredProvider?: string): { model: ModelId } | { error: string } {
	const trimmed = ref.trim();
	const slash = trimmed.indexOf("/");
	if (slash > 0) {
		const provider = trimmed.slice(0, slash);
		const id = trimmed.slice(slash + 1);
		const found = catalog.find((m) => m.provider === provider && m.id === id);
		return found ? { model: found } : { error: `Unknown model "${trimmed}"` };
	}
	const matches = catalog.filter((m) => m.id === trimmed);
	if (matches.length === 0) return { error: `Unknown model "${trimmed}"` };
	const preferred = matches.find((m) => m.provider === preferredProvider);
	if (preferred) return { model: preferred };
	if (matches.length === 1) return { model: matches[0] };
	return { error: `"${trimmed}" exists in several providers (${matches.map((m) => m.provider).join(", ")}); use provider/model` };
}

/** Returns a copy with one route set, or removed when entry is empty. */
export function withRoute(file: ProfilesFile, profileName: string, key: string, entry: RouteEntry): ProfilesFile {
	const next: ProfilesFile = structuredClone(file);
	const profile = next.profiles[profileName];
	if (!profile) throw new Error(`Profile "${profileName}" does not exist`);
	if (!validKey(key)) throw new Error(`Invalid routing key "${key}"`);
	const merged: RouteEntry = { ...profile[key], ...entry };
	if (entry.model === undefined && "model" in entry) delete merged.model;
	if (entry.thinking === undefined && "thinking" in entry) delete merged.thinking;
	if (merged.model || merged.thinking || merged.fallbacks?.length) profile[key] = merged;
	else delete profile[key];
	return next;
}

/** Returns a copy with the fallback chain of one route replaced (empty clears it). */
export function withFallbacks(file: ProfilesFile, profileName: string, key: string, steps: FallbackStep[]): ProfilesFile {
	const next: ProfilesFile = structuredClone(file);
	const profile = next.profiles[profileName];
	if (!profile) throw new Error(`Profile "${profileName}" does not exist`);
	if (!validKey(key)) throw new Error(`Invalid routing key "${key}"`);
	const unique = steps.filter((s, i) => steps.findIndex((o) => o.model === s.model) === i);
	if (unique.length > MAX_FALLBACKS) throw new Error(`Keep at most ${MAX_FALLBACKS} fallback models`);
	const route: RouteEntry = { ...profile[key] };
	if (unique.length) route.fallbacks = unique;
	else delete route.fallbacks;
	if (route.model || route.thinking || route.fallbacks?.length) profile[key] = route;
	else delete profile[key];
	return next;
}

/** Profile keys that match no known agent (typos are silently ignored at launch otherwise). */
export function unmatchedKeys(profile: Profile, agentNames: readonly string[]): string[] {
	return Object.keys(profile).filter((key) => {
		if (key === DEFAULT_KEY || key === ORCHESTRATOR_KEY) return false;
		if (key.endsWith("*")) return !agentNames.some((n) => n.startsWith(key.slice(0, -1)));
		return !agentNames.includes(key);
	});
}
