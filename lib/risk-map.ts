// Path-based risk map: which review a branch needs before a PR. Paths are
// classified by globs into categories; the categories give a tier (T0 tests or
// docs only, T1 ordinary source or prompts, T2 data/security/contract) and the
// review lenses that fit. Config can add globs, never remove any.

import { basename } from "node:path";
import { readCurrentBranch } from "./commit-branch.ts";
import { globToRegExp } from "./edit-surfaces.ts";
import { parsePorcelain, type ExecFn } from "./worktree-snapshot.ts";
import { isDocPath } from "./worktree-tree.ts";

export type RiskCategory = "data" | "security" | "contract" | "concurrency" | "delivery";
export type Tier = "T0" | "T1" | "T2";
export type Lens = "R1" | "R2" | "R3" | "R4";
/** The five risk categories plus `prompt` (assets that steer models) and the neutral `test` paths. */
export type RiskMap = Record<RiskCategory | "prompt" | "test", string[]>;

const CATEGORIES: readonly RiskCategory[] = ["security", "data", "contract", "concurrency", "delivery"];
const GIT_TIMEOUT_MS = 10_000;

/** A glob for a name containing one of the words, as a file or as a folder. */
const named = (words: string): string[] => [`**/*{${words}}*`, `**/*{${words}}*/**`];

export const DEFAULT_RISK_MAP: RiskMap = {
	security: named("auth,permission,guard,secret,credential,token,session,crypto,sandbox,trust,sanitiz,acl"),
	data: ["**/migrations/**", ...named("migration,store,storage,persist,retention,prune,backup"), "**/*.{sql,prisma}"],
	contract: ["**/*.schema.json", "**/openapi*", "**/*.{proto,graphql}", "**/bin/**"],
	concurrency: named("worker,queue,lock,semaphore,spawn,child,process,watchdog"),
	delivery: ["**/package.json", "**/{package-lock.json,pnpm-lock.yaml,yarn.lock,bun.lock,bun.lockb,Cargo.lock,go.sum,poetry.lock,uv.lock}", "**/Dockerfile*", ".github/**"],
	prompt: ["assets/**/*.md", "skills/**/*.md", "prompts/**", "**/{AGENTS,CLAUDE}.md"],
	test: ["**/{test,tests,__tests__,fixtures}/**", "**/*.{test,spec}.*", "**/*_test.*", "**/test_*"],
};

// --- Merging config ----------------------------------------------------------

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Adds the valid globs of one `{category: [globs]}` object to `target`; the problems go to `invalid`. */
function addGlobs(scope: string, source: Record<string, unknown>, target: RiskMap, invalid: string[]): void {
	for (const [category, list] of Object.entries(source)) {
		if (!(CATEGORIES as readonly string[]).includes(category)) invalid.push(`${scope}.${category}: unknown category`);
		else if (!Array.isArray(list)) invalid.push(`${scope}.${category}: not a list`);
		else {
			list.forEach((glob, index) => {
				if (typeof glob !== "string" || !glob.trim()) invalid.push(`${scope}.${category}[${index}]: not a non-empty glob string`);
				else if (!target[category as RiskCategory].includes(glob.trim())) target[category as RiskCategory].push(glob.trim());
			});
		}
	}
}

/**
 * The defaults plus the `risk.paths` globs and the `risk.repos.<repoSlug>` globs.
 * Additive only: nothing is removed and `test` or `prompt` cannot be set, so
 * config can raise a tier but never lower one. Invalid entries are ignored and
 * listed in `invalid`; the defaults are not mutated.
 */
export function mergeRiskMap(defaults: RiskMap, risk: unknown, repoSlug: string): { map: RiskMap; invalid: string[] } {
	const map = Object.fromEntries(Object.entries(defaults).map(([key, globs]) => [key, [...globs]])) as RiskMap;
	const invalid: string[] = [];
	if (risk === undefined) return { map, invalid };
	if (!isRecord(risk)) return { map, invalid: ["risk: not an object"] };
	if (risk.paths !== undefined) {
		if (isRecord(risk.paths)) addGlobs("risk.paths", risk.paths, map, invalid);
		else invalid.push("risk.paths: not an object");
	}
	if (risk.repos !== undefined) {
		if (!isRecord(risk.repos)) invalid.push("risk.repos: not an object");
		else {
			for (const [slug, entry] of Object.entries(risk.repos)) {
				const scope = `risk.repos.${slug}`;
				if (!isRecord(entry)) invalid.push(`${scope}: not an object`);
				else addGlobs(scope, entry, slug === repoSlug ? map : structuredClone(defaults), invalid);
			}
		}
	}
	return { map, invalid };
}

// --- Classification ------------------------------------------------------------

export interface Classification {
	tier: Tier;
	categories: Partial<Record<RiskCategory, string[]>>;
	lenses: Lens[];
}

const compiled = new Map<string, RegExp>();
function matches(globs: readonly string[], path: string): boolean {
	return globs.some((glob) => {
		let regex = compiled.get(glob);
		if (!regex) compiled.set(glob, (regex = globToRegExp(glob, true)));
		return regex.test(path);
	});
}

const normalizePath = (path: string): string => path.replace(/\\/g, "/").replace(/^(?:\.\/)+/, "");

/**
 * Tier, categories, and review lenses for changed paths. Test paths are
 * neutral (they never raise the tier, whatever else they match); plain docs
 * count as nothing. T2 when data, security, or contract is hit; T1 for any
 * other source or prompt path; T0 otherwise.
 */
export function classifyPaths(paths: readonly string[], map: RiskMap): Classification {
	const categories: Partial<Record<RiskCategory, string[]>> = {};
	let prompt = false;
	let source = false;
	for (const raw of new Set(paths)) {
		const path = normalizePath(raw);
		if (!path || matches(map.test, path)) continue;
		if (matches(map.prompt, path)) {
			prompt = true;
			continue;
		}
		if (isDocPath(path)) continue;
		source = true;
		for (const category of CATEGORIES) if (matches(map[category], path)) (categories[category] ??= []).push(path);
	}
	const hit = (...names: RiskCategory[]) => names.some((name) => categories[name]);
	const tier: Tier = hit("data", "security", "contract") ? "T2" : source || prompt ? "T1" : "T0";
	const lenses: Lens[] = [];
	if (tier !== "T0") {
		if (hit("security", "delivery")) lenses.push("R1");
		if (!source && prompt) lenses.push("R2");
		lenses.push("R3");
		if (hit("data", "concurrency")) lenses.push("R4");
	}
	return { tier, categories, lenses };
}

// --- The line the model sees ---------------------------------------------------

const MAX_LINE = 120;
const MAX_PATH = 48;
const SHOWN_PATHS = 2;

const shortPath = (path: string): string => (path.length > MAX_PATH ? `…${path.slice(-(MAX_PATH - 1))}` : path);

/** `risk T2 security(lib/guard-rules.ts) → before PR: brigadev-verify + R1,R3`; T1 `risk T1 → before PR: review R3`; T0 `risk T0 → tests only`. */
export function formatRiskLine(c: Classification): string {
	if (c.tier === "T0") return "risk T0 → tests only";
	const entries = CATEGORIES.flatMap((category) => {
		const paths = c.categories[category];
		return paths ? [{ category, paths }] : [];
	});
	const detail = (compact: boolean) =>
		entries
			.map(({ category, paths }) => {
				if (compact) return `${category}(${paths.length})`;
				const extra = paths.length > SHOWN_PATHS ? ` +${paths.length - SHOWN_PATHS}` : "";
				return `${category}(${paths.slice(0, SHOWN_PATHS).map(shortPath).join(", ")}${extra})`;
			})
			.join(" ");
	const action = `→ before PR: ${c.tier === "T2" ? "brigadev-verify + " : "review "}${c.lenses.join(",")}`;
	const line = (compact: boolean) => ["risk", c.tier, entries.length ? detail(compact) : "", action].filter(Boolean).join(" ");
	return line(false).length <= MAX_LINE ? line(false) : line(true);
}

// --- The branch's changed paths --------------------------------------------------

export interface BranchRisk extends Classification {
	/** Top level of the repository. */
	root: string;
	/** Current branch; null when detached. */
	branch: string | null;
	/** The merge-base the branch was compared with; absent when only the working tree counted. */
	base?: string;
}

/**
 * Classifies what the branch changes: `git diff --name-only <base>...HEAD`
 * plus the working tree (`git status`, renames count both paths). The base is
 * the merge-base with origin/HEAD, else main, else master; with none, only the
 * working tree counts. `map` may be a function of the repository slug (the
 * top-level folder's name). Undefined outside a git repository or when git fails.
 */
export async function branchRisk(exec: ExecFn, cwd: string, map: RiskMap | ((repoSlug: string) => RiskMap)): Promise<BranchRisk | undefined> {
	const git = async (...args: string[]): Promise<string | undefined> => {
		try {
			const result = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
			return result.code === 0 ? result.stdout : undefined;
		} catch {
			return undefined;
		}
	};
	const root = (await git("rev-parse", "--show-toplevel"))?.trim();
	if (!root) return undefined;
	const committed = async (): Promise<{ base?: string; paths: string[] }> => {
		for (const ref of ["origin/HEAD", "main", "master"]) {
			const base = (await git("merge-base", "HEAD", ref))?.trim();
			if (base) return { base, paths: ((await git("diff", "--name-only", "--no-renames", "-z", `${base}...HEAD`)) ?? "").split("\0") };
		}
		return { paths: [] };
	};
	const [{ base, paths: branchPaths }, status, branch] = await Promise.all([committed(), git("status", "--porcelain=v1", "-z", "--untracked-files=all"), readCurrentBranch(exec, cwd)]);
	const paths = [...branchPaths.filter(Boolean), ...parsePorcelain(status ?? "")];
	const resolved = typeof map === "function" ? map(basename(root)) : map;
	return { ...classifyPaths(paths, resolved), root, base, branch };
}

// --- The notice `check` appends ----------------------------------------------------

const lastNotice = new Map<string, string>();

/** Forgets what was noticed (tests). */
export function resetRiskNotices(): void {
	lastNotice.clear();
}

/**
 * The risk line for the repository at `cwd`, only when the tier or the
 * category set differs from the last notice for this root and branch (the
 * first call always answers). Never throws: undefined also means no git.
 */
/** The risk map for a repository slug: the defaults plus `risk` from brigadev.json (used by check and the PR gate). */
export const riskMapFor = (settings: unknown): ((slug: string) => RiskMap) => {
	const risk = (settings as { risk?: unknown } | undefined)?.risk;
	return (slug) => mergeRiskMap(DEFAULT_RISK_MAP, risk, slug).map;
};

export async function riskNotice(exec: ExecFn, cwd: string, settings: unknown): Promise<string | undefined> {
	try {
		const result = await branchRisk(exec, cwd, riskMapFor(settings));
		if (!result) return undefined;
		const key = `${result.root}\0${result.branch ?? "HEAD"}`;
		const signature = `${result.tier}|${Object.keys(result.categories).sort().join(",")}`;
		if (lastNotice.get(key) === signature) return undefined;
		lastNotice.set(key, signature);
		return formatRiskLine(result);
	} catch {
		return undefined;
	}
}
