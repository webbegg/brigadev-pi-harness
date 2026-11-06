// Running a workflow: ask its questions, then compose the request the
// orchestrator receives. The composer is pure (workflow + answers + facts in,
// text out); the question loop talks to an injected UI so it needs no Pi.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readBranchFacts } from "./commit-branch.ts";
import { workflowGroup, type Workflow, type WorkflowQuestion } from "./workflows.ts";
import type { ExecFn } from "./worktree-snapshot.ts";

/** Answers by question id; skipped questions are absent. */
export type Answers = Record<string, string>;

/** What the session can look up locally and read-only; absent or null when unknown. */
export interface WorkflowFacts {
	currentBranch?: string | null;
	defaultBranch?: string | null;
	testScript?: string | null;
}

/** The dialogs the question loop needs; each resolves to undefined when the user presses Esc. */
export interface QuestionUi {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
	editor(title: string, prefill?: string): Promise<string | undefined>;
}

const PLACEHOLDER = /([ \t]*)\{\{([^{}]*)\}\}/g;
const REQUIRED_HINT = "required, this answer cannot be empty";
const NO_ANSWER = "(no answer)";
const CLEAR = "-";

/** The question's default with `{{fact}}` placeholders filled; undefined when it has none or a fact is unknown. */
export function questionDefault(question: WorkflowQuestion, facts: WorkflowFacts): string | undefined {
	if (question.default === undefined) return undefined;
	let known = true;
	const text = question.default.replace(/\{\{([^{}]*)\}\}/g, (_match, name: string) => {
		const value = facts[name.trim() as keyof WorkflowFacts];
		if (!value) known = false;
		return value ?? "";
	});
	return known ? text : undefined;
}

/** The answer a question ends up with: what was given, else its default. */
function effectiveAnswer(question: WorkflowQuestion, answers: Answers, facts: WorkflowFacts): string | undefined {
	return answers[question.id]?.trim() || questionDefault(question, facts)?.trim() || undefined;
}

/** Required questions that have neither an answer nor a default. */
export function missingRequired(workflow: Workflow, answers: Answers, facts: WorkflowFacts): WorkflowQuestion[] {
	return workflow.questions.filter((question) => question.required && effectiveAnswer(question, answers, facts) === undefined);
}

/**
 * One body line with its answers filled in; undefined when every placeholder
 * on it was skipped. A skipped placeholder renders as empty. A multi-line
 * answer becomes a block quote on its own lines, indented like the line, with
 * the text before it kept above and the text after it on the line below.
 */
function composeLine(line: string, values: Map<string, string | undefined>): string[] | undefined {
	const matches = [...line.matchAll(PLACEHOLDER)];
	if (matches.length && matches.every((match) => values.get(match[2].trim()) === undefined)) return undefined;
	const indent = /^[ \t]*/.exec(line)?.[0] ?? "";
	const out: string[] = [];
	let current = "";
	let afterQuote = false;
	// Text right after a quote starts a fresh line, so its leading space goes.
	const append = (text: string) => {
		current += afterQuote && current === indent ? text.trimStart() : text;
	};
	let last = 0;
	// One pass over the line, so an answer that contains `{{...}}` is not expanded again.
	for (const match of matches) {
		append(line.slice(last, match.index));
		last = (match.index ?? 0) + match[0].length;
		const answer = values.get(match[2].trim());
		if (answer === undefined) continue;
		if (!answer.includes("\n")) {
			append(`${match[1]}${answer}`);
			continue;
		}
		if (current.trim()) out.push(current.trimEnd());
		out.push(...answer.split("\n").map((part) => `${indent}> ${part}`));
		current = indent;
		afterQuote = true;
	}
	append(line.slice(last));
	if (current.trim() || !afterQuote) out.push(current);
	return out;
}

/** One line of the workflow list (`alt+w`): the name, the description, and the dashboard group it sits in. */
export const workflowListLabel = (workflow: Workflow): string => `${workflow.name} — ${workflow.description} [${workflowGroup(workflow).label}]`;

/**
 * The request text: the workflow body with each `{{id}}` replaced by the
 * answer, verbatim (a multi-line answer becomes a block quote). A body line
 * is left out only when all of its answers were skipped. Throws when a
 * required answer is missing.
 */
export function composeRequest(workflow: Workflow, answers: Answers, facts: WorkflowFacts): string {
	const missing = missingRequired(workflow, answers, facts);
	if (missing.length) throw new Error(`required answers missing: ${missing.map((question) => question.id).join(", ")}`);
	const values = new Map(workflow.questions.map((question) => [question.id, effectiveAnswer(question, answers, facts)]));
	const lines: string[] = [];
	for (const line of workflow.body.split("\n")) lines.push(...(composeLine(line, values) ?? []));
	return lines.join("\n").trim();
}

/** Choices with the preferred one first, since the select dialog has no preselection. */
const defaultFirst = (options: string[], preferred: string | undefined): string[] => (preferred && options.includes(preferred) ? [preferred, ...options.filter((option) => option !== preferred)] : options);

/**
 * Asks every question in order. `current` holds earlier answers (when the user
 * edits them) and takes the place of the question's default; an optional
 * answer that was given can then be cleared (`-` for text, `(no answer)` for a
 * choice). Returns undefined when the user escapes any question or leaves a
 * required one empty twice.
 */
export async function askQuestions(workflow: Workflow, facts: WorkflowFacts, ui: QuestionUi, current: Answers = {}): Promise<Answers | undefined> {
	const answers: Answers = {};
	for (const question of workflow.questions) {
		const previous = current[question.id];
		const clearable = !question.required && previous !== undefined;
		const optional = question.required ? "" : clearable && question.kind === "text" ? ` (optional, "${CLEAR}" clears)` : " (optional)";
		const title = `${workflow.name}: ${question.label}${optional}`;
		const preset = previous ?? questionDefault(question, facts);

		if (question.kind === "choice") {
			const options = defaultFirst(question.options ?? [], preset);
			const choice = await ui.select(title, clearable ? [...options, NO_ANSWER] : options);
			if (choice === undefined) return undefined;
			if (choice !== NO_ANSWER) answers[question.id] = choice;
			continue;
		}

		let reply: string | undefined;
		for (let attempt = 0; attempt < 2; attempt++) {
			const heading = attempt === 0 ? title : `${title} — ${REQUIRED_HINT}`;
			reply = question.kind === "long" ? await ui.editor(heading, preset ?? "") : await ui.input(heading, preset);
			if (reply === undefined) return undefined;
			if (clearable && question.kind === "text" && reply.trim() === CLEAR) {
				reply = "";
				break;
			}
			// A text answer left empty accepts the default shown as the placeholder; an emptied editor means no answer.
			if (question.kind === "text" && !reply.trim()) reply = preset ?? "";
			if (reply.trim() || !question.required) break;
		}
		if (!reply?.trim()) {
			if (question.required) return undefined;
			continue;
		}
		answers[question.id] = reply.trim();
	}
	return answers;
}

/** `package.json` `scripts.test` of the session's project, as a one-line description; undefined when absent. */
export function readTestScript(cwd: string): string | undefined {
	try {
		const script = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"))?.scripts?.test;
		return typeof script === "string" && script.trim() ? `package.json test script: ${script.trim()}` : undefined;
	} catch {
		return undefined;
	}
}

/** Local, read-only lookups: current and default branch (git) and the repo's test script. No network. */
export async function gatherFacts(exec: ExecFn, cwd: string): Promise<WorkflowFacts> {
	const { currentBranch, defaultBranch } = await readBranchFacts(exec, cwd);
	return { currentBranch, defaultBranch, testScript: readTestScript(cwd) };
}
