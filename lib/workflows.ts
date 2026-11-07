// Workflow files: markdown with frontmatter (name, description, questions) and
// a prompt body with `{{question-id}}` placeholders. Package defaults live in
// `assets/workflows/`; the user's own sit in `<brigadev home>/workflows/`
// (global) and `<repo docs folder>/workflows/` (per repo) and override by name
// or add new workflows. Pure loading and validation; no Pi imports.

import { existsSync, readdirSync, readFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";
import type { FrontmatterParser } from "./agents.ts";
import { brigadevHome, repoDocsDir } from "./repo-docs.ts";

export type WorkflowSource = "package" | "user" | "repo";
export type QuestionKind = "text" | "long" | "choice";

/** Values the session can look up locally; a question default may embed them as `{{name}}`. */
export const FACT_NAMES = ["currentBranch", "defaultBranch", "testScript"] as const;

const QUESTION_KINDS: readonly string[] = ["text", "long", "choice"];
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const UNORDERED = 1_000;
const KEY_PATTERN = /^[a-z]$/;

/** Dashboard keys the tools and the New feature submenu use (Changes, Agents history, Cost, Usage, Status, Panel, Model profile, Permission mode, Launch dashboard, Doctor, Commands, Quit, New feature); a workflow cannot take them. */
export const RESERVED_KEYS: readonly string[] = ["g", "a", "c", "s", "t", "o", "m", "e", "h", "y", "k", "q", "n"];

export interface WorkflowGroup {
	id: string;
	label: string;
}

/** A group the dashboard ships, with what it needs to show it. */
export interface ShippedGroup extends WorkflowGroup {
	/** Display position among the groups; the groups a workflow file adds sit at `CUSTOM_GROUP_ORDER`. */
	order: number;
	/** The key that opens the group: a letter (New feature) or a digit. Absent for an inline group. */
	key?: string;
	/** Absent for an inline group, which has no row of its own. */
	icon?: string;
	/** True when the group has no submenu: its workflows are rows on the top level, at the group's position. */
	inline?: boolean;
}

/** Where the groups a workflow file adds are shown: after Other workflows, before Tools. */
export const CUSTOM_GROUP_ORDER = 50;

/** The one table of the dashboard's own groups. Plain BMP symbols, no Nerd Font glyphs. */
export const SHIPPED_GROUPS: readonly ShippedGroup[] = [
	{ id: "feature", label: "New feature", order: 10, key: "n", icon: "✦" },
	{ id: "main", label: "Top level", order: 20, inline: true },
	{ id: "other", label: "Other workflows", order: 30, key: "1", icon: "⋯" },
	{ id: "tools", label: "Tools", order: 90, key: "2", icon: "⚙" },
];

/** The dashboard's own groups, in display order. A workflow's `group:` matches one by id or label, ignoring case. */
export const KNOWN_GROUPS: readonly WorkflowGroup[] = SHIPPED_GROUPS.map(({ id, label }) => ({ id, label }));

/** Group names of earlier versions (ids and labels, lowercase) and the group each now belongs to. */
const GROUP_ALIASES: Readonly<Record<string, string>> = {
	build: "other",
	ship: "other",
	"review & ship": "other",
	inspect: "tools",
	settings: "tools",
};

const DEFAULT_GROUP = KNOWN_GROUPS.find((group) => group.id === "other")!;

export interface WorkflowQuestion {
	id: string;
	label: string;
	kind: QuestionKind;
	required: boolean;
	/** Literal text, optionally with `{{fact}}` placeholders; dropped when a fact is unknown. */
	default?: string;
	/** Choices, for `kind: choice`. */
	options?: string[];
}

export interface Workflow {
	name: string;
	description: string;
	/** Menu position: lower first, then by name. */
	order: number;
	/** Dashboard key: one lowercase letter, unique among workflows and not reserved; dropped (with a warning) when it is not. An override without one inherits the key of the workflow it replaces. */
	key?: string;
	/** Dashboard category: a shipped group's id or label, or a new category's name. Absent means Other workflows. An override without one inherits the group of the workflow it replaces. */
	group?: string;
	questions: WorkflowQuestion[];
	/** Prompt body with `{{question-id}}` placeholders. */
	body: string;
	source: WorkflowSource;
	filePath: string;
}

export interface WorkflowDiscovery {
	workflows: Workflow[];
	/** One line per skipped file: the path and why. */
	warnings: string[];
}

const placeholders = (text: string): string[] => [...text.matchAll(PLACEHOLDER)].map((match) => match[1].trim());

function parseQuestion(raw: unknown, index: number): WorkflowQuestion {
	if (!raw || typeof raw !== "object") throw new Error(`question ${index + 1} is not a map`);
	const { id, label, kind, required, default: fallback, options } = raw as Record<string, unknown>;
	if (typeof id !== "string" || !ID_PATTERN.test(id)) throw new Error(`question ${index + 1} needs an id of lowercase letters, digits, and dashes`);
	if (typeof label !== "string" || !label.trim()) throw new Error(`question "${id}" needs a label`);
	if (typeof kind !== "string" || !QUESTION_KINDS.includes(kind)) throw new Error(`question "${id}" has kind ${JSON.stringify(kind)}; use text, long, or choice`);
	if (fallback !== undefined && typeof fallback !== "string") throw new Error(`question "${id}" default must be text`);
	for (const fact of placeholders(fallback ?? "")) {
		if (!(FACT_NAMES as readonly string[]).includes(fact)) throw new Error(`question "${id}" default uses unknown fact "${fact}"`);
	}
	const question: WorkflowQuestion = { id, label: label.trim(), kind: kind as QuestionKind, required: required === true };
	if (kind === "choice") {
		const choices = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string" && o.trim() !== "") : [];
		if (choices.length < 2) throw new Error(`question "${id}" is a choice and needs at least two options`);
		if (fallback !== undefined && !choices.includes(fallback)) throw new Error(`question "${id}" default must be one of its options`);
		question.options = choices;
	}
	if (fallback !== undefined) question.default = fallback;
	return question;
}

/** Throws an Error naming the problem when the file is not a valid workflow. */
export function parseWorkflow(content: string, filePath: string, source: WorkflowSource, parse: FrontmatterParser): Workflow {
	const { frontmatter, body } = parse(content);
	if (typeof frontmatter.name !== "string" || !frontmatter.name.trim()) throw new Error("missing name");
	if (typeof frontmatter.description !== "string" || !frontmatter.description.trim()) throw new Error("missing description");
	if (!body.trim()) throw new Error("missing prompt body");
	// An empty `key:` line is null in YAML: no key, not an invalid one.
	const key = frontmatter.key ?? undefined;
	if (key !== undefined && (typeof key !== "string" || !KEY_PATTERN.test(key))) throw new Error("key must be one lowercase letter");
	// Same for an empty `group:` line.
	const rawGroup = frontmatter.group ?? undefined;
	if (rawGroup !== undefined && (typeof rawGroup !== "string" || !rawGroup.trim())) throw new Error("group must be a non-empty name");
	const group = rawGroup?.trim();
	const rawQuestions = frontmatter.questions ?? [];
	if (!Array.isArray(rawQuestions)) throw new Error("questions must be a list");
	const questions = rawQuestions.map(parseQuestion);
	const ids = new Set<string>();
	for (const { id } of questions) {
		if (ids.has(id)) throw new Error(`duplicate question id "${id}"`);
		ids.add(id);
	}
	for (const used of placeholders(body)) {
		if (!ids.has(used)) throw new Error(`prompt body uses unknown question "${used}"`);
	}
	return {
		name: frontmatter.name.trim(),
		description: frontmatter.description.trim(),
		order: typeof frontmatter.order === "number" ? frontmatter.order : UNORDERED,
		...(key !== undefined ? { key } : {}),
		...(group !== undefined ? { group } : {}),
		questions,
		body: body.trim(),
		source,
		filePath,
	};
}

function loadDir(dir: string | undefined, source: WorkflowSource, parse: FrontmatterParser, warnings: string[]): Workflow[] {
	if (!dir || !existsSync(dir)) return [];
	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
	} catch (error) {
		warnings.push(`${dir}: could not read the folder: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const found: Workflow[] = [];
	for (const entry of entries) {
		if (!entry.name.endsWith(".md") || !(entry.isFile() || entry.isSymbolicLink())) continue;
		const filePath = join(dir, entry.name);
		try {
			found.push(parseWorkflow(readFileSync(filePath, "utf8"), filePath, source, parse));
		} catch (error) {
			warnings.push(`${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
	return found;
}

export interface WorkflowDiscoveryOptions {
	packageDir: string;
	userDir?: string;
	repoDir?: string;
	parse: FrontmatterParser;
}

/**
 * Later layers override earlier ones by name (ignoring case): package < user < repo. An invalid override leaves the lower layer's workflow in place.
 * An override without a `key` or a `group` keeps the one of the workflow it replaces.
 */
export function discoverWorkflows(options: WorkflowDiscoveryOptions): WorkflowDiscovery {
	const warnings: string[] = [];
	const byName = new Map<string, Workflow>();
	const layers: Array<[string | undefined, WorkflowSource]> = [
		[options.packageDir, "package"],
		[options.userDir, "user"],
		[options.repoDir, "repo"],
	];
	for (const [dir, source] of layers) {
		for (const workflow of loadDir(dir, source, options.parse, warnings)) {
			const id = workflow.name.toLowerCase();
			const replaced = byName.get(id);
			byName.set(id, {
				...workflow,
				...(workflow.key === undefined && replaced?.key !== undefined ? { key: replaced.key } : {}),
				...(workflow.group === undefined && replaced?.group !== undefined ? { group: replaced.group } : {}),
			});
		}
	}
	const workflows = [...byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	return { workflows: assignKeys(workflows, warnings), warnings };
}

const LAYER_RANK: Record<WorkflowSource, number> = { package: 0, user: 1, repo: 2 };

/**
 * A key goes to the highest layer that claims it (repo, then user, then package), and within a layer to the first
 * workflow in menu order. A reserved or already used key is dropped with a warning, and the workflow stays.
 */
function assignKeys(workflows: Workflow[], warnings: string[]): Workflow[] {
	const owners = new Map<string, Workflow>();
	const dropped = new Set<Workflow>();
	// Array.prototype.sort is stable, so menu order breaks ties within a layer.
	const claims = workflows.filter((workflow) => workflow.key !== undefined).sort((a, b) => LAYER_RANK[b.source] - LAYER_RANK[a.source]);
	for (const workflow of claims) {
		const key = workflow.key!;
		const owner = owners.get(key);
		if (RESERVED_KEYS.includes(key)) warnings.push(`${workflow.filePath}: key "${key}" is reserved by the dashboard; "${workflow.name}" has no key`);
		else if (owner) warnings.push(`${workflow.filePath}: key "${key}" is already used by "${owner.name}"; "${workflow.name}" has no key`);
		else {
			owners.set(key, workflow);
			continue;
		}
		dropped.add(workflow);
	}
	return workflows.map((workflow) => {
		if (!dropped.has(workflow)) return workflow;
		const { key: _dropped, ...keyless } = workflow;
		return keyless;
	});
}

export interface LoadedWorkflows extends WorkflowDiscovery {
	/** Ready-to-show text for the skipped files, when there are any. */
	warning?: string;
}

export const SKIPPED_WORKFLOWS_TITLE = "brigadev: workflow file warnings";

/** `discoverWorkflows` plus the notification text, so every caller words the warning the same way. */
export function loadWorkflows(parse: FrontmatterParser, dirs: Omit<WorkflowDiscoveryOptions, "parse">): LoadedWorkflows {
	const found = discoverWorkflows({ ...dirs, parse });
	return found.warnings.length ? { ...found, warning: `${SKIPPED_WORKFLOWS_TITLE}\n${found.warnings.join("\n")}` } : found;
}

/** The category a workflow sits in on the dashboard: Other workflows when it names none, a shipped group when the name matches one (an earlier version's name maps to its new group), else its own category labelled as written. */
export function workflowGroup(workflow: Workflow): WorkflowGroup {
	const name = workflow.group?.trim();
	if (!name) return DEFAULT_GROUP;
	const wanted = name.toLowerCase();
	const known = KNOWN_GROUPS.find((group) => group.id === wanted || group.label.toLowerCase() === wanted);
	if (known) return known;
	const aliased = Object.hasOwn(GROUP_ALIASES, wanted) ? KNOWN_GROUPS.find((group) => group.id === GROUP_ALIASES[wanted]) : undefined;
	return aliased ?? { id: wanted, label: name };
}

/** The workflow's file name without `.md`, the id `/brigadev:start` also accepts. */
export const workflowId = (workflow: Workflow): string => basename(workflow.filePath, ".md");

/** Finds a workflow by name (ignoring case), file id, or key. Throws an Error listing the names when none matches. */
export function resolveWorkflow(workflows: readonly Workflow[], query: string): Workflow {
	const wanted = query.trim().toLowerCase();
	const found = workflows.find((w) => w.name.toLowerCase() === wanted) ?? workflows.find((w) => workflowId(w).toLowerCase() === wanted) ?? workflows.find((w) => w.key !== undefined && w.key === wanted);
	if (found) return found;
	throw new Error(`Unknown workflow "${query.trim()}". Workflows: ${workflows.map((w) => (w.key ? `${w.name} (${w.key})` : w.name)).join(", ")}`);
}

/** The user's global and per-repo workflow folders, under the same root as the repo docs. */
export function workflowDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): { userDir: string; repoDir: string } {
	return { userDir: join(brigadevHome(env), "workflows"), repoDir: join(repoDocsDir(cwd, env), "workflows") };
}
