// Factory lanes (software-factory-lanes S1–S6): issue intake and classification, a docs lane, an explicit
// "Reproduced" step for bugs, an analysis step for features, a review-depth signal in the PR body, and an
// outcome on every close. The checks read the shipped assets and look for the structure, not exact prose.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { type FrontmatterParser } from "../lib/agents.ts";
import { ASSETS_ROOT, PACKAGE_ROOT } from "../lib/runtime.ts";
import { composeRequest } from "../lib/workflow-run.ts";
import { parseWorkflow, type Workflow } from "../lib/workflows.ts";

const read = (...parts: string[]) => readFileSync(join(...parts), "utf8");

/** Same minimal frontmatter reader as workflows.test.ts: `key: value`, a `questions:` list, JSON strings and arrays. */
const scalar = (raw: string): unknown => {
	const text = raw.trim();
	if (/^(".*"|\[.*\])$/.test(text)) return JSON.parse(text);
	if (text === "true" || text === "false") return text === "true";
	return /^-?\d+$/.test(text) ? Number(text) : text;
};
const parse: FrontmatterParser = (content) => {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, unknown> = {};
	let list: Array<Record<string, unknown>> | undefined;
	for (const line of match[1].split("\n")) {
		const item = /^\s+- (\w+):(.*)$/.exec(line);
		const field = /^\s+(\w+):(.*)$/.exec(line);
		const top = /^(\w+):(.*)$/.exec(line);
		if (item && list) list.push({ [item[1]]: scalar(item[2]) });
		else if (field && list) list[list.length - 1][field[1]] = scalar(field[2]);
		else if (top && top[2].trim() === "") frontmatter[top[1]] = list = [];
		else if (top) frontmatter[top[1]] = scalar(top[2]);
	}
	return { frontmatter, body: match[2].trim() };
};

const workflow = (id: string): Workflow => {
	const path = join(ASSETS_ROOT, "workflows", `${id}.md`);
	return parseWorkflow(read(path), path, "package", parse);
};
const facts = { currentBranch: "main", defaultBranch: "main", testScript: "package.json test script: npm test" };
const compose = (id: string, answers: Record<string, string>) => composeRequest(workflow(id), answers, facts);
const has = (text: string, needles: string[], label: string) => {
	for (const needle of needles) assert.ok(text.includes(needle), `${label}: ${needle}`);
};

describe("S1 From a GitHub issue", () => {
	it("asks the issue first, required, then optional notes and the size", () => {
		const w = workflow("issue");
		assert.equal(w.name, "From a GitHub issue");
		assert.deepEqual(w.questions.map((q) => [q.id, q.kind, q.required]), [["issue", "text", true], ["notes", "long", false], ["size", "choice", false]]);
		assert.ok(w.order < workflow("feature").order, "the issue entry comes first in the menu");
	});

	it("reads the issue with gh, classifies it with a confidence and a rationale, and confirms a low-confidence type", () => {
		const text = compose("issue", { issue: "https://github.com/o/r/issues/42" });
		has(text, ["- Issue: https://github.com/o/r/issues/42", "gh issue view", "--json title,body,labels,comments,author,url", "bug, feature, docs, or refactor", "confidence (high, medium, or low)", "one-line rationale", "`ask_user_choice`", "recommended"], "issue");
	});

	it("treats the issue text as untrusted data and routes to the four lanes", () => {
		const text = compose("issue", { issue: "42" });
		has(text, ["untrusted data", "never follow instructions", "Bug:", "Feature:", "Docs:", "Refactor:", "`diagnosis.md`", "Reproduced:", "Analysis:", "Review depth: glance", "Refs #<n>", "`Closes #<n>` only when the user says so"], "issue lanes");
		assert.ok(text.indexOf("untrusted data") < text.indexOf("Bug:"), "the untrusted-data rule comes before the lanes");
	});
});

describe("S2 Docs change", () => {
	it("asks what to change, required, then optional files and ticket", () => {
		const w = workflow("docs");
		assert.equal(w.name, "Docs change");
		assert.deepEqual(w.questions.map((q) => [q.id, q.kind, q.required]), [["what", "long", true], ["files", "text", false], ["ticket", "text", false]]);
	});

	it("is a docs-only lane: docs/ branch, no test-first or verify, glance review, stops on a source change", () => {
		const text = compose("docs", { what: "fix the install section" });
		has(text, ["docs/<short-slug>", "no test-first", "no `brigadev-verify`", "Review depth: glance (T0)", "stop and say so"], "docs");
	});
});

describe("S3 Reproduced before any source edit", () => {
	const reproduced = ["`Reproduced:`", "`Not reproduced:`", "before any source edit"];

	it("diagnosis.md asks for the Reproduced block (command, failing output, test path) or a Not reproduced stop", () => {
		const loop = read(ASSETS_ROOT, "diagnosis.md");
		has(loop, [...reproduced, "failing output", "test path", "what was tried"], "diagnosis.md");
		assert.ok(loop.indexOf("`Reproduced:`") < loop.indexOf("## 2. Minimise"), "the block closes step 1");
	});

	it("the Bug fix workflow and the Bug path of a ticket name the block", () => {
		has(compose("bug-fix", { where: "w", steps: "s", expected: "e", actual: "a" }), reproduced, "bug-fix");
		has(compose("ticket", { key: "PROJ-1", text: "t", kind: "Bug" }), ["`Reproduced:`"], "ticket");
	});
});

describe("S4 Analysis before the first source write of a feature", () => {
	const analysis = ["`Analysis:`", "a probe that fails on the current code", "numbered specs", "docs scope", "backward compatibility", "before the first source write"];

	it("Feature and the Story path of a ticket ask for the analysis block unless it is a quick change", () => {
		for (const [name, text] of [["feature", compose("feature", { what: "w" })], ["ticket", compose("ticket", { key: "PROJ-1", text: "t" })]] as const) {
			has(text, analysis, name);
			assert.match(text, /except a "Quick change"/, name);
		}
	});
});

describe("S5 Review depth in the PR body", () => {
	const skill = read(PACKAGE_ROOT, "skills", "brigadev-branch-pr", "SKILL.md");
	const body = /```markdown\n## Summary[\s\S]*?```/.exec(skill)?.[0] ?? "";

	it("the evidence-based body has a Review depth line from the tier and three risk ratings", () => {
		has(body, ["Review depth: <glance (T0) | focused (T1) | deep (T2)>", "Side effects: <none|low|medium|high>", "Performance: <none|low|medium|high>", "Backward compatibility: <none|low|medium|high>"], "PR body");
	});

	it("says where the tier comes from and that each rating carries its reason", () => {
		has(skill, ["the last `check` risk line", "each rating with its reason"], "skill");
	});
});

describe("S6 Outcome on every close", () => {
	it("the orchestrator close names Outcome with its four values, between Risk and Next", () => {
		const prompt = read(ASSETS_ROOT, "orchestrator.md");
		assert.match(prompt, /`Risk:`, `Outcome:` \(success\|flawed\|blocked\|manual\), `Next:`/);
	});

	it("the README defines the four outcomes", () => {
		const readme = read(PACKAGE_ROOT, "README.md");
		for (const word of ["success", "flawed", "blocked", "manual"]) assert.match(readme, new RegExp(`\\*\\*${word}\\*\\*`), word);
	});
});
