// Workflow files: markdown with frontmatter (name, description, questions) and
// a prompt body with `{{question-id}}` placeholders. Package defaults live in
// `assets/workflows/`; the user's own sit in `<brigadev home>/workflows/`
// (global) and `<repo docs folder>/workflows/` (per repo) and override by name
// or add new workflows. Pure loading and validation; no Pi imports.

import { existsSync, readdirSync, readFileSync } from "node:fs";
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

/** Dashboard keys the tools use (Changes, Agents history, Model profile, Commands, Quit); a workflow cannot take them. */
export const RESERVED_KEYS: readonly string[] = ["g", "a", "m", "k", "q"];

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
	/** Dashboard key: one lowercase letter, unique among workflows and not reserved; dropped (with a warning) when it is not. */
	key?: string;
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
	if (frontmatter.key !== undefined && (typeof frontmatter.key !== "string" || !KEY_PATTERN.test(frontmatter.key))) throw new Error("key must be one lowercase letter");
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
		...(frontmatter.key !== undefined ? { key: frontmatter.key as string } : {}),
		questions,
		body: body.trim(),
		source,
		filePath,
	};
}

function loadDir(dir: string | undefined, source: WorkflowSource, parse: FrontmatterParser, warnings: string[]): Workflow[] {
	if (!dir || !existsSync(dir)) return [];
	const found: Workflow[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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

/** Later layers override earlier ones by name (ignoring case): package < user < repo. An invalid override leaves the lower layer's workflow in place. */
export function discoverWorkflows(options: WorkflowDiscoveryOptions): WorkflowDiscovery {
	const warnings: string[] = [];
	const byName = new Map<string, Workflow>();
	const layers: Array<[string | undefined, WorkflowSource]> = [
		[options.packageDir, "package"],
		[options.userDir, "user"],
		[options.repoDir, "repo"],
	];
	for (const [dir, source] of layers) {
		for (const workflow of loadDir(dir, source, options.parse, warnings)) byName.set(workflow.name.toLowerCase(), workflow);
	}
	const workflows = [...byName.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
	return { workflows: assignKeys(workflows, warnings), warnings };
}

/** In menu order the first workflow keeps a key; a reserved or already used one is dropped with a warning, and the workflow stays. */
function assignKeys(workflows: Workflow[], warnings: string[]): Workflow[] {
	const owners = new Map<string, Workflow>();
	return workflows.map((workflow) => {
		const { key, ...keyless } = workflow;
		if (key === undefined) return workflow;
		const owner = owners.get(key);
		if (RESERVED_KEYS.includes(key)) warnings.push(`${workflow.filePath}: key "${key}" is reserved for the dashboard tools; "${workflow.name}" has no key`);
		else if (owner) warnings.push(`${workflow.filePath}: key "${key}" is already used by "${owner.name}"; "${workflow.name}" has no key`);
		else {
			owners.set(key, workflow);
			return workflow;
		}
		return keyless;
	});
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
