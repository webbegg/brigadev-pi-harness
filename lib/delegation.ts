import type { AgentDefinition } from "./agents.ts";
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

const RISK_ITEM = /\b(risk\s*:?\s*)?item\s*[1-6]\b/i;

/**
 * Checks one launch against the delegation rules. Returns the list of
 * problems; an empty list means the launch is admitted.
 */
export function admitLaunch(request: LaunchRequest, agent: AgentDefinition | undefined, available: readonly AgentDefinition[]): string[] {
	if (!agent) return [`Unknown agent "${request.agent}". Available: ${available.map((a) => a.name).join(", ") || "none"}`];
	const problems: string[] = [];
	if (!request.task?.trim()) problems.push("task must not be empty");
	if (!request.reason?.trim()) {
		problems.push("reason must name the delegation trigger (evidence budget, risk item N, independent units, or context backstop)");
	}
	if (agent.admission === "risk" && !RISK_ITEM.test(request.reason ?? "")) {
		problems.push(`${agent.name} runs only for a named high-risk item: put "Risk: item N (why)" in reason`);
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
