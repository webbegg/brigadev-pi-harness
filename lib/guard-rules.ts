// The guard's decisions as pure functions of plain inputs, so they run in
// tests without the Pi packages that extensions/guard.ts imports. The
// extension reads the facts (paths, environment, git) and acts on the answer.

import { dirname, relative, sep } from "node:path";
import { classifyCommand } from "./command-classifier.ts";
import { type BranchFacts, decideWithBranchRule } from "./commit-branch.ts";
import { isWithinSurfaces } from "./edit-surfaces.ts";
import { isInside } from "./paths.ts";
import { type Decision, type PermissionMode } from "./permission-policy.ts";
import { isRepoDocsPath } from "./repo-docs.ts";

export interface FileAccessInput {
	isChild: boolean;
	/** Canonical absolute path of the target. */
	absolutePath: string;
	projectRoot: string;
	/** Repo docs folder; a function is called only when a parent write lands outside the project. */
	docsDir: string | (() => string);
	/** The path commonly holds secrets. */
	sensitive: boolean;
	/** A subagent without write tools (read-only agent). */
	readOnly: boolean;
	/** Edit surfaces of a writer subagent; undefined means unrestricted. */
	surfaces: string[] | undefined;
	/** Write or edit (default); false for a read. */
	isWrite?: boolean;
	/** The path as the model wrote it, for messages (default: `absolutePath`). */
	rawPath?: string;
	/** Name of the subagent, for messages. */
	agent?: string;
}

/** What to do with the access once any sensitive-path question is settled. */
export type PathVerdict = { action: "allow" } | { action: "block"; reason: string } | { action: "ask"; kind: "outside"; target: string };

/** A sensitive path asks first; `then` is the verdict if the user allows it. */
export type FileAccessDecision = PathVerdict | { action: "ask"; kind: "sensitive"; then: PathVerdict };

const ALLOW: PathVerdict = { action: "allow" };
const block = (reason: string): PathVerdict => ({ action: "block", reason });

function decideAfterSensitive(input: FileAccessInput): PathVerdict {
	const { isChild, absolutePath, projectRoot } = input;
	if (input.isWrite === false) return ALLOW;

	if (!isInside(projectRoot, absolutePath)) {
		// The parent's harness documents (feature documents, review ledgers) live outside the project by design.
		if (!isChild) {
			const docsDir = typeof input.docsDir === "function" ? input.docsDir() : input.docsDir;
			if (isRepoDocsPath(docsDir, absolutePath)) return ALLOW;
		}
		if (isChild) return block(`Blocked by brigadev guard: ${input.rawPath ?? absolutePath} is outside the project root ${projectRoot}.`);
		return { action: "ask", kind: "outside", target: dirname(absolutePath) };
	}

	if (isChild) {
		if (input.readOnly) return block(`Blocked by brigadev guard: ${input.agent ?? "this agent"} is read-only.`);
		const rel = relative(projectRoot, absolutePath).split(sep).join("/");
		if (input.surfaces && !isWithinSurfaces(rel, input.surfaces)) {
			return block(`Blocked by brigadev guard: ${rel} is outside the allowed edit surfaces (${input.surfaces.join(", ")}). Stop and report status: interaction_required with the path you need.`);
		}
	}
	return ALLOW;
}

/**
 * Order: a sensitive path first (subagents blocked, the parent asked), then,
 * for writes, the parent-only docs exemption, the outside-project rule, and
 * for a subagent inside the project its read-only flag and edit surfaces.
 */
export function decideFileAccess(input: FileAccessInput): FileAccessDecision {
	if (input.sensitive) {
		if (input.isChild) return block(`Blocked by brigadev guard: ${input.rawPath ?? input.absolutePath} may hold secrets; subagents never read or write it.`);
		return { action: "ask", kind: "sensitive", then: decideAfterSensitive(input) };
	}
	return decideAfterSensitive(input);
}

export interface BashDecisionInput {
	command: string;
	mode: PermissionMode;
	isChild: boolean;
	/** The session's working directory, where the command runs. */
	cwd: string;
	/** Reads branch facts of the repository at a directory; called only for a plain `git commit`. */
	readFacts: (cwd: string) => Promise<BranchFacts>;
}

/** Classifies the command and applies the permission rules, with the feature-branch commit rule reading facts at the session cwd. */
export function decideBashCommand(input: BashDecisionInput): Promise<Decision> {
	return decideWithBranchRule(classifyCommand(input.command), input.mode, input.isChild, () => input.readFacts(input.cwd));
}
