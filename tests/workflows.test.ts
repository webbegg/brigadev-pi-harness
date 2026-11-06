import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type FrontmatterParser } from "../lib/agents.ts";
import { ASSETS_ROOT } from "../lib/runtime.ts";
import { composeRequest } from "../lib/workflow-run.ts";
import { discoverWorkflows, loadWorkflows, parseWorkflow, RESERVED_KEYS, resolveWorkflow, workflowDirs, workflowId, type Workflow } from "../lib/workflows.ts";

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

	it("gives the nine workflows their dashboard keys: n b r p f i u x d, none reserved", () => {
		assert.deepEqual(loaded.workflows.map((w) => w.key), ["n", "b", "r", "p", "f", "i", "u", "x", "d"]);
		assert.ok(loaded.workflows.every((w) => !RESERVED_KEYS.includes(w.key!)));
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

	it("asks the frontend context questions as optional text, after the question they extend", () => {
		const ids = (name: string) => loaded.workflows.find((w) => w.name === name)!.questions;
		const bug = ids("Bug fix");
		const environment = bug.find((q) => q.id === "environment")!;
		assert.equal(environment.label, "Environment: browser, device, app version, or feature flag");
		assert.deepEqual([environment.kind, environment.required], ["text", false]);
		assert.equal(bug.findIndex((q) => q.id === "environment"), bug.findIndex((q) => q.id === "where") + 1);
		const ui = ids("UI change from a design or ticket");
		for (const label of ["Design system components or tokens to use", "Accessibility and i18n requirements"]) {
			const q = ui.find((candidate) => candidate.label === label)!;
			assert.deepEqual([q.kind, q.required], ["text", false], label);
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
		"Refactor a component": ["brigadev-work-unit-commits", "contract change", "Risk: item 3"],
		"Upgrade dependencies": ["brigadev-work-unit-commits", "npm run check", "State your grouping", "Risk: item 5"],
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

	it("reads an optional one-letter key and leaves it off when absent", () => {
		assert.equal(ok(file("Ship it", 'key: "s"\n')).key, "s");
		assert.equal(ok(file("Ship it", "key: s\n")).key, "s");
		assert.equal(ok(file("Ship it")).key, undefined);
	});

	it("rejects a key that is not exactly one lowercase letter", () => {
		for (const bad of ['"N"', '"nn"', '""', '"1"', '"-"', "5", "true"]) {
			assert.throws(() => ok(file("Ship it", `key: ${bad}\n`)), /key/, bad);
		}
	});

	it("treats an empty `key:` line (null in real YAML) as no key, not as an invalid file", () => {
		const yamlNull: FrontmatterParser = () => ({ frontmatter: { name: "Ship it", description: "d", key: null }, body: "Do it" });
		const workflow = parseWorkflow("ignored", "/w/x.md", "user", yamlNull);
		assert.equal(workflow.key, undefined);
		assert.ok(!("key" in workflow));
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

	it("a folder that is really a file becomes a warning, and the other layers still load", () => {
		put("notdir", "placeholder.txt", "x");
		const { workflows, warnings } = discoverWorkflows({ ...dirs(), userDir: join(scratch, "notdir", "placeholder.txt"), repoDir: undefined });
		assert.deepEqual(workflows.map((w) => w.name), ["Alpha", "Beta"]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /placeholder\.txt/);
	});

	it("an unreadable folder becomes a warning instead of a throw", { skip: process.platform === "win32" || process.getuid?.() === 0 }, () => {
		put("locked", "x.md", file("Locked"));
		chmodSync(join(scratch, "locked"), 0o000);
		try {
			const { workflows, warnings } = discoverWorkflows({ ...dirs(), userDir: join(scratch, "locked"), repoDir: undefined });
			assert.deepEqual(workflows.map((w) => w.name), ["Alpha", "Beta"]);
			assert.equal(warnings.length, 1);
			assert.match(warnings[0], /locked/);
		} finally {
			chmodSync(join(scratch, "locked"), 0o755);
		}
	});

	it("an invalid override keeps the lower layer's workflow", () => {
		put("repo2", "beta.md", file("Beta", "", "Uses {{missing}}"));
		const { workflows, warnings } = discoverWorkflows({ ...dirs(), repoDir: join(scratch, "repo2") });
		assert.equal(workflows.find((w) => w.name === "Beta")?.source, "package");
		assert.equal(warnings.length, 1);
	});
});

describe("workflow keys across files", () => {
	let scratch: string;
	const put = (dir: string, fileName: string, content: string) => {
		mkdirSync(join(scratch, dir), { recursive: true });
		writeFileSync(join(scratch, dir, fileName), content);
	};
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-workflow-keys-"));
		put("pkg", "one.md", file("One", 'order: 1\nkey: "o"\n'));
		put("pkg", "two.md", file("Two", 'order: 2\nkey: "o"\n'));
		put("pkg", "three.md", file("Three", 'order: 3\nkey: "g"\n'));
		put("pkg", "four.md", file("Four", 'order: 4\nkey: "f"\n'));
		put("user", "five.md", file("Five", 'order: 5\nkey: "f"\n'));
		put("user", "six.md", file("Six", "order: 6\n"));
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("reserves g a m k q for the tools", () => {
		assert.deepEqual([...RESERVED_KEYS].sort(), ["a", "g", "k", "m", "q"]);
	});

	it("within a layer the first workflow in menu order keeps a duplicate key; a reserved key is dropped; a higher layer wins over a lower one (still valid)", () => {
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), parse });
		assert.deepEqual(workflows.map((w) => [w.name, w.key]), [["One", "o"], ["Two", undefined], ["Three", undefined], ["Four", undefined], ["Five", "f"], ["Six", undefined]]);
		assert.equal(warnings.length, 3);
		assert.match(warnings.find((w) => w.includes("two.md"))!, /key "o" is already used by "One"/);
		assert.match(warnings.find((w) => w.includes("three.md"))!, /key "g" is reserved/);
		assert.match(warnings.find((w) => w.includes("four.md"))!, /key "f" is already used by "Five"/);
	});
});

describe("workflow key inheritance and layer precedence", () => {
	let scratch: string;
	const put = (dir: string, fileName: string, content: string) => {
		mkdirSync(join(scratch, dir), { recursive: true });
		writeFileSync(join(scratch, dir, fileName), content);
	};
	const discover = (layers: { userDir?: string; repoDir?: string }) => discoverWorkflows({ packageDir: join(scratch, "pkg"), parse, ...layers });
	const keys = (workflows: Workflow[]) => workflows.map((w) => [w.name, w.key, w.source]);
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-workflow-inherit-"));
		put("pkg", "bug-fix.md", file("Bug fix", 'order: 1\nkey: "b"\n'));
		put("pkg", "review.md", file("Review", 'order: 2\nkey: "r"\n'));
		put("user", "bug-fix.md", file("Bug fix", "order: 1\n", "User bug fix"));
		put("user", "review.md", file("Review", 'order: 2\nkey: "v"\n'));
		put("repo", "bug-fix.md", file("bug fix", "order: 1\n", "Repo bug fix"));
		put("claim", "mine.md", file("Mine", 'order: 3\nkey: "b"\n'));
		put("claimrepo", "theirs.md", file("Theirs", 'order: 4\nkey: "b"\n'));
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("an override without a key inherits the shipped key and warns about nothing", () => {
		const { workflows, warnings } = discover({ userDir: join(scratch, "user") });
		const bug = workflows.find((w) => w.name === "Bug fix")!;
		assert.deepEqual([bug.source, bug.key, bug.body], ["user", "b", "User bug fix"]);
		assert.deepEqual(warnings, []);
	});

	it("an override with its own key keeps that key", () => {
		const { workflows } = discover({ userDir: join(scratch, "user") });
		assert.deepEqual(keys(workflows).find(([name]) => name === "Review"), ["Review", "v", "user"]);
	});

	it("a repo override of a user override inherits through both layers", () => {
		const { workflows, warnings } = discover({ userDir: join(scratch, "user"), repoDir: join(scratch, "repo") });
		assert.deepEqual(keys(workflows).find(([name]) => name === "bug fix"), ["bug fix", "b", "repo"]);
		assert.deepEqual(warnings, []);
	});

	it("a user workflow claiming a package key wins it; the package workflow loses it with a warning", () => {
		const { workflows, warnings } = discover({ userDir: join(scratch, "claim") });
		assert.deepEqual(keys(workflows), [["Bug fix", undefined, "package"], ["Review", "r", "package"], ["Mine", "b", "user"]]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /bug-fix\.md.*key "b" is already used by "Mine"/);
	});

	it("a repo workflow beats a user workflow, which beats a package workflow, whatever the menu order", () => {
		const { workflows } = discover({ userDir: join(scratch, "claim"), repoDir: join(scratch, "claimrepo") });
		assert.deepEqual(keys(workflows), [["Bug fix", undefined, "package"], ["Review", "r", "package"], ["Mine", undefined, "user"], ["Theirs", "b", "repo"]]);
	});
});

describe("resolveWorkflow", () => {
	const { workflows } = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });

	it("finds a workflow by name, ignoring case", () => {
		assert.equal(resolveWorkflow(workflows, "Bug fix").name, "Bug fix");
		assert.equal(resolveWorkflow(workflows, "  upgrade DEPENDENCIES ").name, "Upgrade dependencies");
	});

	it("finds a workflow by file id", () => {
		assert.equal(resolveWorkflow(workflows, "bug-fix").name, "Bug fix");
		assert.equal(resolveWorkflow(workflows, "pr-feedback").name, "Answer PR feedback");
		assert.equal(workflowId(workflows[0]), "new-feature");
	});

	it("finds a workflow by key", () => {
		assert.equal(resolveWorkflow(workflows, "b").name, "Bug fix");
		assert.equal(resolveWorkflow(workflows, "x").name, "Refactor a component");
	});

	it("prefers an exact name over a file id or a key, so two workflows sharing a file id each resolve by name", () => {
		const make = (name: string, id: string, key?: string): Workflow => ({ name, description: "d", order: 1, questions: [], body: "b", source: "user", filePath: `/w/${id}.md`, ...(key ? { key } : {}) });
		const shared = [make("Bug fix", "bug-fix", "b"), make("Defect triage", "bug-fix"), make("b", "zzz"), make("Other", "bug-fix-2", "o")];
		assert.equal(resolveWorkflow(shared, "Defect triage"), shared[1]);
		assert.equal(resolveWorkflow(shared, "Bug fix"), shared[0]);
		// A workflow named like another's key is reached by its name first.
		assert.equal(resolveWorkflow(shared, "b"), shared[2]);
		// A name that is also another workflow's file id still wins.
		const clash = [make("Alpha", "bug-fix"), make("bug-fix", "other")];
		assert.equal(resolveWorkflow(clash, "bug-fix"), clash[1]);
	});

	it("throws for an unknown workflow, listing every name", () => {
		assert.throws(() => resolveWorkflow(workflows, "zzz"), (error: Error) => {
			assert.match(error.message, /Unknown workflow "zzz"/);
			for (const workflow of workflows) assert.ok(error.message.includes(workflow.name), workflow.name);
			return true;
		});
		// Tool keys are not workflow keys.
		assert.throws(() => resolveWorkflow(workflows, "g"), /Unknown workflow/);
	});
});

describe("loadWorkflows", () => {
	it("returns the workflows with one ready-to-show warning text, or none", () => {
		const scratch = mkdtempSync(join(tmpdir(), "brigadev-load-workflows-"));
		try {
			mkdirSync(join(scratch, "user"));
			writeFileSync(join(scratch, "user", "bad.md"), file("Bad", "", "Uses {{missing}}"));
			const clean = loadWorkflows(parse, { packageDir: join(ASSETS_ROOT, "workflows") });
			assert.equal(clean.workflows.length, 9);
			assert.equal(clean.warning, undefined);
			const dirty = loadWorkflows(parse, { packageDir: join(ASSETS_ROOT, "workflows"), userDir: join(scratch, "user") });
			assert.equal(dirty.workflows.length, 9);
			assert.match(dirty.warning!, /^brigadev: skipped invalid workflow files\n.*bad\.md: .*unknown question "missing"/);
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
});

describe("workflowDirs", () => {
	it("puts user workflows under the brigadev home and per-repo ones under the repo docs folder", () => {
		const dirs = workflowDirs("/tmp/some-project", { BRIGADEV_HOME: "/tmp/bh" });
		assert.equal(dirs.userDir, "/tmp/bh/workflows");
		assert.equal(dirs.repoDir, "/tmp/bh/some-project/workflows");
	});
});
