import type { AgentDefinition } from "./agents.ts";
import type { EvidenceRecord, VerifyRecord } from "./evidence.ts";
import { surfacesOverlap, validateSurfaces } from "./edit-surfaces.ts";

export interface LaunchRequest {
	agent: string;
	task: string;
	reason: string;
	allowedEditSurfaces?: string[];
	featureDoc?: string;
	skills?: string[];
}

export interface SkillRef {
	name: string;
	filePath: string;
}

export interface ActiveWriter {
	id: string;
	agent: string;
	surfaces: string[];
}

/**
 * A named high-risk category (`Risk: security (why)`); the legacy numbered form (`Risk: item 2`) is still admitted. The literal
 * `Risk:` (colon required) must come right before the category or item, and not after a word that negates or lowers it
 * (`no risk: security`, `low risk data`, `explore item 3` do not admit).
 */
const RISK_REASON = /(?<![\w-])(?<!\b(?:no|not|low|without|zero|minimal|any|little|non|never)\s+)risk\s*:\s*(?:(?:data|security|contract|concurrency|delivery|untested)\b|item\s*[1-6]\b)/i;
/** The same reason, reading only the named category (`Risk: security (why)`); the numbered form names none. */
const RISK_CATEGORY = /(?<![\w-])(?<!\b(?:no|not|low|without|zero|minimal|any|little|non|never)\s+)risk\s*:\s*(data|security|contract|concurrency|delivery|untested)\b/gi;

export const VERIFY_AGENT = "brigadev-verify";
/** Categories a recheck is worth its cost for. */
const RECHECK_CATEGORIES = new Set(["security", "data"]);
const RECHECK_REASON = /(?<![\w-])recheck\s+(B\d+(?:\s*,\s*B\d+)*)(?![\w])/i;

/** Categories a reason names with `Risk: <category>`, lowercased, in order, without duplicates. */
export function riskCategories(reason: string): string[] {
	return [...new Set([...reason.matchAll(RISK_CATEGORY)].map((m) => m[1].toLowerCase()))];
}

/** Blocker ids of a recheck reason (`recheck B1,B2`, case-insensitive); undefined when the reason is not a recheck. */
export function parseRecheck(reason: string): string[] | undefined {
	const ids = RECHECK_REASON.exec(reason)?.[1];
	return ids ? ids.split(",").map((id) => id.trim().toUpperCase()) : undefined;
}

export interface VerifyRequest {
	reason: string;
	branch: string | null;
}

export type VerifyBudget = { ok: true } | { ok: false; ask?: boolean; message: string };

const REPRO_ADVICE = "prove the fix with a repro test RED→GREEN via check (it fails before the fix and passes after) instead of another verify";

/**
 * The verify budget (S7), judged from the evidence log so it holds across sessions: one branch verify per source tree, a new
 * source tree asks the user, and at most one recheck after a branch verify, only of that verify's blockers and only for security
 * or data. A failed run used nothing up: it never counts. `srcTree` is the current source tree (undefined when unknown).
 */
export function verifyBudget(records: readonly EvidenceRecord[], request: VerifyRequest, srcTree: string | undefined): VerifyBudget {
	const finished = records.filter((r): r is VerifyRecord => r.type === "verify" && r.branch === request.branch && r.outcome !== "failed");
	const branchVerifies = finished.filter((r) => r.scope === "branch");
	const ids = parseRecheck(request.reason);

	if (ids === undefined) {
		if (branchVerifies.length === 0) return { ok: true };
		if (srcTree !== undefined && branchVerifies.some((r) => r.srcTree === srcTree)) {
			return { ok: false, message: `${VERIFY_AGENT} already verified this source tree; do not launch another. ${REPRO_ADVICE}. After a fix, one recheck of its security or data blockers is allowed: reason "Risk: security (why); recheck B1,B2".` };
		}
		return { ok: false, ask: true, message: "A branch verify already ran on this branch; this is another branch verify on a changed source tree." };
	}

	const last = branchVerifies.at(-1);
	if (!last) return { ok: false, message: `recheck needs an earlier branch verify on this branch, and there is no earlier branch verify. Launch ${VERIFY_AGENT} without "recheck" first.` };
	const lastAt = finished.lastIndexOf(last);
	if (finished.slice(lastAt + 1).some((r) => r.scope === "recheck")) {
		return { ok: false, message: `Only one recheck per branch verify, and it is used. ${REPRO_ADVICE}; anything still failing goes to the user as a decision.` };
	}
	if (!ids.every((id) => last.blockers.includes(id))) {
		const known = last.blockers.length > 0 ? `blockers of the last branch verify: ${last.blockers.join(", ")}` : "the last branch verify reported no blockers";
		return { ok: false, message: `recheck names ids that are not ${known}. Name only those ids ("recheck B1,B2"); ${REPRO_ADVICE}.` };
	}
	const category = riskCategories(request.reason)[0];
	if (!category || !RECHECK_CATEGORIES.has(category)) {
		return { ok: false, message: `A recheck runs only for security or data blockers: put "Risk: security (why)" or "Risk: data (why)" in reason. For other categories ${REPRO_ADVICE}.` };
	}
	return { ok: true };
}

/**
 * Checks one launch against the delegation rules. Returns the list of
 * problems; an empty list means the launch is admitted.
 */
export function admitLaunch(request: LaunchRequest, agent: AgentDefinition | undefined, available: readonly AgentDefinition[]): string[] {
	if (!agent) return [`Unknown agent "${request.agent}". Available: ${available.map((a) => a.name).join(", ") || "none"}`];
	const problems: string[] = [];
	if (!request.task?.trim()) problems.push("task must not be empty");
	if (!request.reason?.trim()) {
		problems.push("reason must name the delegation trigger (exploration, risk, parallel writers, context handoff, or review)");
	}
	if (agent.admission === "risk" && !RISK_REASON.test(request.reason ?? "")) {
		problems.push(`${agent.name} runs only for a named high-risk category: put "Risk: <data|security|contract|concurrency|delivery|untested> (why)" in reason`);
	}
	if (agent.writer) {
		problems.push(...validateSurfaces(request.allowedEditSurfaces).map((p) => `${agent.name}: ${p}`));
	} else if (request.allowedEditSurfaces?.length) {
		problems.push(`${agent.name} is read-only; do not pass allowedEditSurfaces`);
	}
	return problems;
}

/** Writers that would run at the same time must have disjoint surfaces. */
export function writerConflicts(batch: ReadonlyArray<{ agent: AgentDefinition; surfaces: string[] }>, active: readonly ActiveWriter[]): string[] {
	const writers = batch.filter((b) => b.agent.writer);
	const problems: string[] = [];
	for (let i = 0; i < writers.length; i++) {
		for (let j = i + 1; j < writers.length; j++) {
			const overlap = surfacesOverlap(writers[i].surfaces, writers[j].surfaces);
			if (overlap) problems.push(`parallel writers ${i + 1} and ${j + 1}: ${overlap}`);
		}
		for (const running of active) {
			const overlap = surfacesOverlap(writers[i].surfaces, running.surfaces);
			if (overlap) problems.push(`writer ${i + 1} conflicts with running ${running.agent} (${running.id}): ${overlap}`);
		}
	}
	return problems;
}

/** Builds the task message a subagent receives. Requirements travel by reference. */
export function buildChildTask(request: LaunchRequest, agent: AgentDefinition, skills: readonly SkillRef[]): { text: string; missingSkills: string[] } {
	const sections: string[] = [`## Task\n${request.task.trim()}`, `## Delegation reason\n${request.reason.trim()}`];

	if (request.featureDoc) {
		sections.push(
			`## Feature document\nRead \`${request.featureDoc}\` from the top until \`## Log\` before any work. Its \`## Specs\` are authoritative over any summary in this task; quoted strings, error messages, and examples are exact. Report which S# you covered.`,
		);
	}

	const missingSkills: string[] = [];
	const resolved: SkillRef[] = [];
	for (const name of request.skills ?? []) {
		const skill = skills.find((s) => s.name === name);
		if (skill) resolved.push(skill);
		else missingSkills.push(name);
	}
	if (resolved.length > 0) {
		sections.push(`## Skills to load before work\nRead each file before reading, writing, or reviewing anything else:\n${resolved.map((s) => `- ${s.name}: ${s.filePath}`).join("\n")}`);
	}

	if (agent.writer && request.allowedEditSurfaces) {
		sections.push(`## Allowed edit surfaces\n${request.allowedEditSurfaces.map((s) => `- ${s}`).join("\n")}\n\nEdits outside these surfaces are blocked by the runtime.`);
	}
	return { text: sections.join("\n\n"), missingSkills };
}
