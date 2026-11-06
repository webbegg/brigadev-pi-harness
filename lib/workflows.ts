// Workflow files: markdown with frontmatter (name, description, questions) and
// a prompt body with `{{question-id}}` placeholders. Package defaults live in
// `assets/workflows/`; the user's own sit in `<brigadev home>/workflows/`
// (global) and `<repo docs folder>/workflows/` (per repo) and override by name
// or add new workflows. Pure loading and validation; no Pi imports.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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
	return { workflows, warnings };
}

/** The user's global and per-repo workflow folders, under the same root as the repo docs. */
export function workflowDirs(cwd: string, env: NodeJS.ProcessEnv = process.env): { userDir: string; repoDir: string } {
	return { userDir: join(brigadevHome(env), "workflows"), repoDir: join(repoDocsDir(cwd, env), "workflows") };
}
