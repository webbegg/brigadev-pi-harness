import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type FrontmatterParser } from "../lib/agents.ts";
import { ASSETS_ROOT } from "../lib/runtime.ts";
import { composeRequest } from "../lib/workflow-run.ts";
import { discoverWorkflows, parseWorkflow, workflowDirs } from "../lib/workflows.ts";

/**
 * Stand-in for Pi's YAML frontmatter parser, so the loader tests run without
 * Pi. It reads the subset the workflow files use: `key: value` lines, a
 * `questions:` list of `- key: value` maps, JSON-style strings and arrays,
 * booleans, and numbers.
 */
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

const file = (name: string, extra = "", body = "Do the thing: {{what}}", questions = '  - id: what\n    label: "What?"\n    kind: text\n    required: true') =>
	`---\nname: ${JSON.stringify(name)}\ndescription: "About ${name}"\n${extra}questions:\n${questions}\n---\n${body}\n`;

const NINE = [
	"New feature",
	"Bug fix",
	"Review a PR or branch",
	"Open a PR",
	"Answer PR feedback",
	"Create an issue",
	"UI change from a design or ticket",
	"Refactor a component",
	"Upgrade dependencies",
];

describe("package workflows", () => {
	const loaded = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });

	it("ships exactly the nine workflows, in menu order, with no warnings", () => {
		assert.deepEqual(loaded.warnings, []);
		assert.deepEqual(loaded.workflows.map((w) => w.name), NINE);
		assert.ok(loaded.workflows.every((w) => w.source === "package" && w.description.length > 0 && w.body.length > 0));
	});

	it("declares valid questions for each workflow", () => {
		for (const workflow of loaded.workflows) {
			assert.ok(workflow.questions.length > 0, workflow.name);
			for (const q of workflow.questions) {
				assert.ok(["text", "long", "choice"].includes(q.kind), `${workflow.name}/${q.id}`);
				if (q.kind === "choice") assert.ok((q.options?.length ?? 0) >= 2, `${workflow.name}/${q.id}`);
			}
		}
	});
});

describe("package workflows composed", () => {
	const loaded = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });
	const facts = { currentBranch: "feat/x", defaultBranch: "main", testScript: "package.json test script: npm run check" };
	// Names the skill or command each workflow must hand to the orchestrator.
	const NEEDS: Record<string, string[]> = {
		"New feature": ["/track"],
		"Bug fix": ["regression test"],
		"Review a PR or branch": ["brigadev-review", "feat/x against main"],
		"Open a PR": ["brigadev-branch-pr", "brigadev-review", "Base branch: main"],
		"Answer PR feedback": ["brigadev-comment-writer"],
		"Create an issue": ["brigadev-issue-creation", "Target repository: origin"],
		"UI change from a design or ticket": ["Verification: Both"],
		"Refactor a component": ["brigadev-work-unit-commits"],
		"Upgrade dependencies": ["brigadev-work-unit-commits", "npm run check"],
	};

	for (const name of NINE) {
		it(`${name}: quotes the required answers and names what it needs`, () => {
			const workflow = loaded.workflows.find((w) => w.name === name)!;
			const answers = Object.fromEntries(workflow.questions.filter((q) => q.required).map((q) => [q.id, `answer for ${q.id} with {{braces}} and $dollars`]));
			const text = composeRequest(workflow, answers, facts);
			for (const answer of Object.values(answers)) assert.ok(text.includes(answer), `${name}: ${answer}`);
			for (const needle of NEEDS[name]) assert.ok(text.includes(needle), `${name}: ${needle}`);
			assert.ok(!/\{\{(?!braces)/.test(text), `${name}: unfilled placeholder`);
		});
	}
});

describe("parseWorkflow", () => {
	const ok = (content: string) => parseWorkflow(content, "/w/x.md", "user", parse);

	it("reads name, description, order, questions, and body", () => {
		const workflow = ok(
			file("Ship it", "order: 5\n", "Go: {{what}} / {{kind}}", '  - id: what\n    label: "What?"\n    kind: long\n    required: true\n    default: "{{testScript}} now"\n  - id: kind\n    label: "Kind?"\n    kind: choice\n    options: ["a", "b"]\n    default: "b"'),
		);
		assert.equal(workflow.name, "Ship it");
		assert.equal(workflow.order, 5);
		assert.equal(workflow.body, "Go: {{what}} / {{kind}}");
		assert.deepEqual(workflow.questions, [
			{ id: "what", label: "What?", kind: "long", required: true, default: "{{testScript}} now" },
			{ id: "kind", label: "Kind?", kind: "choice", required: false, options: ["a", "b"], default: "b" },
		]);
	});

	it("rejects a file without name, description, or body", () => {
		assert.throws(() => ok("---\ndescription: \"d\"\n---\nbody"), /name/);
		assert.throws(() => ok("---\nname: \"n\"\n---\nbody"), /description/);
		assert.throws(() => ok(file("N", "", "")), /body/);
	});

	it("rejects a placeholder that names an unknown question", () => {
		assert.throws(() => ok(file("N", "", "Do {{what}} and {{nope}}")), /unknown question "nope"/);
	});

	it("rejects bad questions: kind, duplicate id, choice without options, default outside options, unknown fact", () => {
		const q = (extra: string, id = "what") => `  - id: ${id}\n    label: "L"\n${extra}`;
		assert.throws(() => ok(file("N", "", "{{what}}", q("    kind: paragraph"))), /kind/);
		assert.throws(() => ok(file("N", "", "{{what}}", `${q("    kind: text")}\n${q("    kind: text")}`)), /duplicate/);
		assert.throws(() => ok(file("N", "", "{{what}}", q("    kind: choice"))), /options/);
		assert.throws(() => ok(file("N", "", "{{what}}", q('    kind: choice\n    options: ["a", "b"]\n    default: "c"'))), /default/);
		assert.throws(() => ok(file("N", "", "{{what}}", q('    kind: text\n    default: "{{nonsense}}"'))), /unknown fact "nonsense"/);
	});
});

describe("discoverWorkflows layers", () => {
	let scratch: string;
	const dirs = () => ({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), repoDir: join(scratch, "repo"), parse });
	const put = (dir: string, fileName: string, content: string) => {
		mkdirSync(join(scratch, dir), { recursive: true });
		writeFileSync(join(scratch, dir, fileName), content);
	};

	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-workflows-"));
		put("pkg", "a.md", file("Alpha", "order: 1\n"));
		put("pkg", "b.md", file("Beta", "order: 2\n"));
		put("user", "alpha.md", file("Alpha", "order: 1\n", "User alpha {{what}}"));
		put("user", "gamma.md", file("Gamma"));
		put("repo", "alpha.md", file("alpha", "order: 1\n", "Repo alpha {{what}}"));
		put("repo", "broken.md", file("Broken", "", "Uses {{missing}}"));
		put("repo", "notes.txt", "not a workflow");
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("lets user override by name, per-repo beat global, and new files add workflows", () => {
		const { workflows } = discoverWorkflows(dirs());
		assert.deepEqual(workflows.map((w) => [w.name, w.source]), [["alpha", "repo"], ["Beta", "package"], ["Gamma", "user"]]);
		assert.equal(workflows[0].body, "Repo alpha {{what}}");
	});

	it("without the repo layer the global override wins over the package", () => {
		const { workflows } = discoverWorkflows({ ...dirs(), repoDir: undefined });
		const alpha = workflows.find((w) => w.name === "Alpha");
		assert.equal(alpha?.source, "user");
		assert.equal(alpha?.body, "User alpha {{what}}");
	});

	it("skips an invalid file with a warning that names the file and the reason", () => {
		const { workflows, warnings } = discoverWorkflows(dirs());
		assert.ok(!workflows.some((w) => w.name === "Broken"));
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /broken\.md/);
		assert.match(warnings[0], /unknown question "missing"/);
	});

	it("a missing folder is not an error", () => {
		assert.deepEqual(discoverWorkflows({ packageDir: join(scratch, "nope"), parse }), { workflows: [], warnings: [] });
	});

	it("an invalid override keeps the lower layer's workflow", () => {
		put("repo2", "beta.md", file("Beta", "", "Uses {{missing}}"));
		const { workflows, warnings } = discoverWorkflows({ ...dirs(), repoDir: join(scratch, "repo2") });
		assert.equal(workflows.find((w) => w.name === "Beta")?.source, "package");
		assert.equal(warnings.length, 1);
	});
});

describe("workflowDirs", () => {
	it("puts user workflows under the brigadev home and per-repo ones under the repo docs folder", () => {
		const dirs = workflowDirs("/tmp/some-project", { BRIGADEV_HOME: "/tmp/bh" });
		assert.equal(dirs.userDir, "/tmp/bh/workflows");
		assert.equal(dirs.repoDir, "/tmp/bh/some-project/workflows");
	});
});
