import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type FrontmatterParser } from "../lib/agents.ts";
import { ASSETS_ROOT } from "../lib/runtime.ts";
import { composeRequest } from "../lib/workflow-run.ts";
import { CUSTOM_GROUP_ORDER, discoverWorkflows, KNOWN_GROUPS, loadWorkflows, parseWorkflow, RESERVED_KEYS, resolveWorkflow, SHIPPED_GROUPS, workflowDirs, workflowGroup, workflowId, type Workflow } from "../lib/workflows.ts";

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

const SHIPPED = [
	"Quick change",
	"Feature",
	"Big feature (plan first)",
	"Work on a ticket",
	"Review a team PR",
	"My PRs: feedback",
	"Bug fix",
	"Review my branch",
	"Open a PR",
	"Create an issue",
	"UI change from a design or ticket",
	"Refactor a component",
	"Upgrade dependencies",
];

describe("package workflows", () => {
	const loaded = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });

	it("ships exactly the thirteen workflows, in menu order, with no warnings", () => {
		assert.deepEqual(loaded.warnings, []);
		assert.deepEqual(loaded.workflows.map((w) => w.name), SHIPPED);
		assert.ok(loaded.workflows.every((w) => w.source === "package" && w.description.length > 0 && w.body.length > 0));
	});

	it("gives the workflows their dashboard keys: none for the three sizes, then j r f b v p i u x d, none reserved", () => {
		assert.deepEqual(loaded.workflows.map((w) => w.key), [undefined, undefined, undefined, "j", "r", "f", "b", "v", "p", "i", "u", "x", "d"]);
		assert.ok(loaded.workflows.every((w) => w.key === undefined || !RESERVED_KEYS.includes(w.key)));
	});

	it("puts the sizes in feature, ticket / team review / my PRs in main, and the rest in other", () => {
		const groups = Object.fromEntries(loaded.workflows.map((w) => [workflowId(w), w.group]));
		assert.deepEqual(groups, {
			"quick-change": "feature",
			"new-feature": "feature",
			"big-feature": "feature",
			ticket: "main",
			"team-review": "main",
			"pr-feedback": "main",
			"bug-fix": "other",
			review: "other",
			"open-pr": "other",
			"create-issue": "other",
			"ui-change": "other",
			refactor: "other",
			"upgrade-dependencies": "other",
		});
	});

	it("asks the questions of the new and renamed workflows", () => {
		const questions = (id: string) => loaded.workflows.find((w) => workflowId(w) === id)!.questions.map((q) => [q.id, q.kind, q.required]);
		assert.deepEqual(questions("quick-change"), [["what", "long", true], ["area", "text", false]]);
		assert.deepEqual(questions("new-feature"), [["what", "long", true], ["area", "text", false], ["criteria", "long", false], ["ticket", "text", false]]);
		assert.deepEqual(questions("big-feature"), [["what", "long", true], ["criteria", "long", false], ["ticket", "text", false], ["constraints", "long", false]]);
		assert.deepEqual(questions("ticket"), [["key", "text", true], ["kind", "choice", false], ["text", "long", true], ["design", "text", false], ["size", "choice", false]]);
		assert.deepEqual(questions("team-review"), [["pr", "text", false], ["focus", "choice", false], ["notes", "long", false]]);
		assert.deepEqual(questions("pr-feedback"), [["pr", "text", false], ["which", "choice", false], ["mode", "choice", false]]);
	});

	it("the ticket workflow's choices and labels", () => {
		const ticket = loaded.workflows.find((w) => workflowId(w) === "ticket")!;
		const q = (id: string) => ticket.questions.find((candidate) => candidate.id === id)!;
		assert.equal(q("key").label, "Ticket key, e.g. PROJ-123");
		assert.deepEqual([q("kind").options, q("kind").default], [["Story or task", "Bug"], "Story or task"]);
		assert.equal(q("text").label, "Paste the ticket: title, description, acceptance criteria");
		assert.equal(q("design").label, "Design or other link");
		assert.deepEqual(q("size").options, ["Let the agent decide", "Quick change", "Big feature (plan first)"]);
	});

	it("the two PR workflows word the optional PR input the same way", () => {
		const label = (id: string) => loaded.workflows.find((w) => workflowId(w) === id)!.questions[0].label;
		assert.equal(label("team-review"), "PR number or URL (empty: pick from a list)");
		assert.equal(label("pr-feedback"), "PR number or URL (empty: pick from a list)");
	});

	it("the Big feature constraints label is short, and My PRs: feedback names its two modes by what they do", () => {
		const question = (id: string, q: string) => loaded.workflows.find((w) => workflowId(w) === id)!.questions.find((candidate) => candidate.id === q)!;
		assert.equal(question("big-feature", "constraints").label, "Constraints (deadlines, what not to touch)");
		const mode = question("pr-feedback", "mode");
		assert.deepEqual([mode.options, mode.default], [["Fix and draft replies", "Draft replies only"], "Fix and draft replies"]);
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
		"Quick change": ["Small task", "test first", "one work unit", "never create a feature document"],
		Feature: ["normal ODD flow", "size rules", "L1"],
		"Big feature (plan first)": ["Large", "odd-tracking.md", "verbatim as L1", "stop for the user's approval before the first source write", "brigadev-chained-pr", "~400"],
		"Work on a ticket": ["Refs:", "short-slug", "failing test that reproduces it"],
		"Review a team PR": ["brigadev-review", "brigadev-comment-writer", 'gh pr list --search "review-requested:@me" --state open', "gh pr view", "gh pr diff", "path:line", "Post nothing unless the user asks"],
		"My PRs: feedback": ["brigadev-comment-writer", "gh pr list --author @me --state open", "Draft replies only"],
		"Bug fix": ["regression test"],
		"Review my branch": ["brigadev-review", "feat/x against main"],
		"Open a PR": ["brigadev-branch-pr", "brigadev-review", "Base branch: main"],
		"Create an issue": ["brigadev-issue-creation", "Target repository: origin"],
		"UI change from a design or ticket": ["Verification: Both"],
		"Refactor a component": ["brigadev-work-unit-commits", "contract change", "Risk: item 3"],
		"Upgrade dependencies": ["brigadev-work-unit-commits", "npm run check", "State your grouping", "Risk: item 5"],
	};

	for (const name of SHIPPED) {
		it(`${name}: quotes the required answers and names what it needs`, () => {
			const workflow = loaded.workflows.find((w) => w.name === name)!;
			const answers = Object.fromEntries(workflow.questions.filter((q) => q.required).map((q) => [q.id, `answer for ${q.id} with {{braces}} and $dollars`]));
			const text = composeRequest(workflow, answers, facts);
			for (const answer of Object.values(answers)) assert.ok(text.includes(answer), `${name}: ${answer}`);
			for (const needle of NEEDS[name]) assert.ok(text.includes(needle), `${name}: ${needle}`);
			assert.ok(!/\{\{(?!braces)/.test(text), `${name}: unfilled placeholder`);
		});
	}

	const compose = (id: string, answers: Record<string, string>) => composeRequest(loaded.workflows.find((w) => workflowId(w) === id)!, answers, facts);

	it("Work on a ticket: the request normalizes the key first, then uses it in the branch, the commit footer, and the PR title", () => {
		const text = compose("ticket", { key: "PROJ-123", text: "Title\nAs a user I want X" });
		for (const needle of ["- Ticket key: PROJ-123", "[A-Za-z][A-Za-z0-9]+-[0-9]+", "first match", "uppercase", "ask once for the key and stop", "feat/<KEY>-<short-slug>", "fix/<KEY>-<short-slug>", "Refs: <KEY>", "(<KEY>)", "Kind: Story or task", "overriding this workflow file", "quote it verbatim"]) {
			assert.ok(text.includes(needle), needle);
		}
		assert.match(text, /Ticket text:\n> Title\n> As a user I want X/);
		// The normalization comes before the first use of <KEY>.
		assert.ok(text.indexOf("uppercase") < text.indexOf("feat/<KEY>"));
	});

	it("Work on a ticket: the request defines all three sizes and quotes the chosen one", () => {
		for (const size of ["Let the agent decide", "Quick change", "Big feature (plan first)"]) {
			const text = compose("ticket", { key: "PROJ-1", text: "t", size });
			assert.ok(text.includes(`- Size: ${size}`), size);
			for (const needle of ["Small task", "one work unit", "never a feature document", "Large", "odd-tracking.md", "stop for the user's approval before the first source write", "usual size rules"]) assert.ok(text.includes(needle), `${size}: ${needle}`);
		}
	});

	it("Work on a ticket: Quick change stops with the same text as the Quick change workflow", () => {
		const ticket = compose("ticket", { key: "PROJ-1", text: "t", size: "Quick change" });
		const quick = compose("quick-change", { what: "w" });
		const condition = (text: string) => /\(several work units[^)]*\)/.exec(text)?.[0];
		assert.ok(condition(quick));
		assert.equal(condition(ticket), condition(quick));
		for (const text of [ticket, quick]) assert.ok(text.includes("stop and say so instead of growing it"));
	});

	it("Work on a ticket, Big feature: the whole request (key, kind, ticket text, link) is L1 verbatim", () => {
		const text = compose("ticket", { key: "PROJ-9", text: "Title\nBody", design: "https://figma.example/f", size: "Big feature (plan first)" });
		assert.ok(text.includes("- Size: Big feature (plan first)"));
		assert.ok(text.includes("- Design or other link: https://figma.example/f"));
		assert.ok(text.includes("the whole request above (key, kind, ticket text, and link) as L1 verbatim"));
		assert.ok(text.includes("split delivery with `brigadev-chained-pr`"));
	});

	it("Work on a ticket, Bug + Quick change: a failing test that reproduces it comes first, whatever the size", () => {
		const text = compose("ticket", { key: "PROJ-2", text: "Crash on save", kind: "Bug", size: "Quick change" });
		for (const needle of ["Kind: Bug", "Size: Quick change", "bug-fix flow", "always starts with a failing test that reproduces it, whatever the size", "one work unit", "fix/<KEY>-<short-slug>"]) assert.ok(text.includes(needle), needle);
	});

	it("Review a team PR: with a PR it names it, without one it lists the PRs waiting for review; either way it posts nothing unasked", () => {
		const given = compose("team-review", { pr: "https://github.com/o/r/pull/7" });
		assert.ok(given.includes("- Pull request: https://github.com/o/r/pull/7"));
		const none = compose("team-review", {});
		assert.ok(!none.includes("- Pull request:"));
		for (const text of [given, none]) {
			assert.ok(text.includes('gh pr list --search "review-requested:@me" --state open'));
			assert.ok(text.includes("never change the author's branch"));
			assert.ok(text.includes("Post nothing unless the user asks"));
			assert.ok(text.includes("posting goes through the guard"));
		}
	});

	it("Review a team PR: never checks the PR out in the user's tree; it freezes `gh pr diff`, uses a detached worktree for files, and saves reviews/pr-<number>.md", () => {
		const text = compose("team-review", {});
		for (const needle of [
			"never run `gh pr checkout`",
			'gh pr diff <number> > "$SCRATCH/candidate.patch"',
			"replaces the review skill's `git diff` freeze step",
			"git fetch origin pull/<number>/head",
			"git worktree add --detach .worktrees/review-pr-<number> FETCH_HEAD",
			"add `.worktrees/` to `.git/info/exclude`",
			"remove it after the review",
			"`reviews/pr-<number>.md`",
		]) assert.ok(text.includes(needle), needle);
		assert.ok(!text.includes("or check it out in a separate worktree"));
	});

	it("Review a team PR: any other focus is that lens only, plus the lens a high-risk item needs", () => {
		const text = compose("team-review", { focus: "Reliability" });
		for (const needle of ["Focus: Reliability", "Any other focus means review with that lens only", "unless the change carries a high-risk item", "add the lens that covers it and say so"]) assert.ok(text.includes(needle), needle);
	});

	it("both PR workflows list the same way: 0 PRs ask for a number, 1-5 get ask_user_choice with one option per PR, more than 5 get the 5 most recently updated", () => {
		// The paragraph must read the same in both files except for the list command.
		const listing = (text: string) => /When no pull request is given[^\n]*/.exec(text)?.[0].replace(/`gh pr list[^`]*`/, "`<list>`");
		const team = compose("team-review", {});
		const feedback = compose("pr-feedback", {});
		assert.ok(listing(team));
		assert.equal(listing(team), listing(feedback));
		for (const needle of ["ask for a PR number in your reply, then stop", "`ask_user_choice`", "one option per PR (`#number title`)", "free text for another PR", 'add the option "Another PR"', "more than 5", "5 most recently updated"]) assert.ok(team.includes(needle), needle);
		assert.ok(team.includes('--state open --json number,title,url,updatedAt'));
		assert.ok(feedback.includes('--author @me --state open --json number,title,url,updatedAt,reviewDecision'));
	});

	it("My PRs: feedback: lists the user's own open PRs when none is given, and keeps drafts and posting behind the guard", () => {
		const text = compose("pr-feedback", {});
		assert.ok(text.includes("gh pr list --author @me --state open"));
		assert.ok(text.includes("reviewDecision"));
		assert.ok(text.includes("go through the guard"));
		assert.ok(text.includes("Comments to handle: Unresolved comments only"));
		assert.ok(text.includes("Mode: Fix and draft replies"));
	});

	it("My PRs: feedback: switches to the PR's branch only from a clean tree, stops on a fork, and drafts replies until approved", () => {
		const text = compose("pr-feedback", {});
		for (const needle of [
			"if the chosen PR is not the current branch, switch to its branch only when the working tree is clean (otherwise stop and say so)",
			"stop if the PR's head is in another repository (a fork;",
			"gh pr view <number> --json headRefName,isCrossRepository",
			"\"Fix and draft replies\" means",
			"\"Draft replies only\" means change no code and post nothing",
			"Replies are drafts until the user approves them",
			"pushing and posting replies go through the guard",
		]) assert.ok(text.includes(needle), needle);
		assert.ok(!text.includes("Apply changes and reply"));
	});

	it("Quick change never creates a plan; Big feature always does", () => {
		assert.ok(compose("quick-change", { what: "w" }).includes("never create a feature document or a plan"));
		const big = compose("big-feature", { what: "w" });
		assert.ok(big.includes("create the feature document"));
		assert.ok(!big.includes("never create a feature document"));
	});

	it("no workflow reaches a ticket system or the network by itself: no Jira API, no credentials", () => {
		for (const workflow of loaded.workflows) assert.ok(!/jira|api[_ -]?token|credential/i.test(workflow.body), workflow.name);
	});
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

	it("reads an optional group name, trimmed, and leaves it off when absent", () => {
		assert.equal(ok(file("Ship it", 'group: "ship"\n')).group, "ship");
		assert.equal(ok(file("Ship it", 'group: "  Docs work "\n')).group, "Docs work");
		assert.equal(ok(file("Ship it")).group, undefined);
		assert.ok(!("group" in ok(file("Ship it"))));
	});

	it("rejects a group that is not a non-empty string", () => {
		for (const bad of ['""', '"   "', "5", "true", "[]"]) {
			assert.throws(() => ok(file("Ship it", `group: ${bad}\n`)), /group/, bad);
		}
	});

	it("treats an empty `group:` line (null in real YAML) as no group, not as an invalid file", () => {
		const yamlNull: FrontmatterParser = () => ({ frontmatter: { name: "Ship it", description: "d", group: null }, body: "Do it" });
		const workflow = parseWorkflow("ignored", "/w/x.md", "user", yamlNull);
		assert.equal(workflow.group, undefined);
		assert.ok(!("group" in workflow));
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
		put("pkg", "one.md", file("One", 'order: 1\nkey: "j"\n'));
		put("pkg", "two.md", file("Two", 'order: 2\nkey: "j"\n'));
		put("pkg", "three.md", file("Three", 'order: 3\nkey: "g"\n'));
		put("pkg", "four.md", file("Four", 'order: 4\nkey: "f"\n'));
		put("user", "five.md", file("Five", 'order: 5\nkey: "f"\n'));
		put("user", "six.md", file("Six", "order: 6\n"));
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("reserves the tool letters a c e g h k m o q s t y and n for New feature", () => {
		assert.deepEqual([...RESERVED_KEYS].sort(), ["a", "c", "e", "g", "h", "k", "m", "n", "o", "q", "s", "t", "y"]);
	});

	it("a workflow file claiming n loses the key with the reserved warning", () => {
		put("nkey", "next.md", file("Next", 'order: 1\nkey: "n"\n'));
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "nkey"), parse });
		assert.deepEqual(workflows.map((w) => [w.name, w.key]), [["Next", undefined]]);
		assert.match(warnings[0], /next\.md.*key "n" is reserved by the dashboard; "Next" has no key/);
	});

	it("a workflow file using a newly reserved letter becomes keyless with the reserved warning", () => {
		put("newly", "cost.md", file("Cost report", 'order: 1\nkey: "c"\n'));
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "newly"), parse });
		assert.deepEqual(workflows.map((w) => [w.name, w.key]), [["Cost report", undefined]]);
		assert.equal(warnings.length, 1);
		assert.match(warnings[0], /cost\.md.*key "c" is reserved by the dashboard; "Cost report" has no key/);
	});

	it("within a layer the first workflow in menu order keeps a duplicate key; a reserved key is dropped; a higher layer wins over a lower one (still valid)", () => {
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), parse });
		assert.deepEqual(workflows.map((w) => [w.name, w.key]), [["One", "j"], ["Two", undefined], ["Three", undefined], ["Four", undefined], ["Five", "f"], ["Six", undefined]]);
		assert.equal(warnings.length, 3);
		assert.match(warnings.find((w) => w.includes("two.md"))!, /key "j" is already used by "One"/);
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

describe("workflow group inheritance", () => {
	let scratch: string;
	const put = (dir: string, fileName: string, content: string) => {
		mkdirSync(join(scratch, dir), { recursive: true });
		writeFileSync(join(scratch, dir, fileName), content);
	};
	const groups = (workflows: Workflow[]) => workflows.map((w) => [w.name, w.group, w.source]);
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-workflow-groups-"));
		put("pkg", "review.md", file("Review", 'order: 1\ngroup: "ship"\n'));
		put("pkg", "bug-fix.md", file("Bug fix", 'order: 2\ngroup: "build"\n'));
		put("user", "review.md", file("Review", "order: 1\n", "User review {{what}}"));
		put("user", "bug-fix.md", file("Bug fix", 'order: 2\ngroup: "Quality"\n'));
		put("repo", "review.md", file("review", "order: 1\n", "Repo review {{what}}"));
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("an override without a group inherits the shipped group", () => {
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), parse });
		assert.deepEqual(groups(workflows).find(([name]) => name === "Review"), ["Review", "ship", "user"]);
		assert.deepEqual(warnings, []);
	});

	it("an override with its own group keeps it", () => {
		const { workflows } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), parse });
		assert.deepEqual(groups(workflows).find(([name]) => name === "Bug fix"), ["Bug fix", "Quality", "user"]);
	});

	it("inherits through two layers", () => {
		const { workflows } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), repoDir: join(scratch, "repo"), parse });
		assert.deepEqual(groups(workflows).find(([name]) => name === "review"), ["review", "ship", "repo"]);
	});
});

describe("workflowGroup", () => {
	const make = (group?: string): Workflow => ({ name: "W", description: "d", order: 1, questions: [], body: "b", source: "user", filePath: "/w/w.md", ...(group !== undefined ? { group } : {}) });

	it("no group means Other workflows", () => {
		assert.deepEqual(workflowGroup(make()), { id: "other", label: "Other workflows" });
	});

	it("knows the four shipped groups by id or by label, ignoring case", () => {
		assert.deepEqual(workflowGroup(make("feature")), { id: "feature", label: "New feature" });
		assert.deepEqual(workflowGroup(make("new FEATURE")), { id: "feature", label: "New feature" });
		assert.deepEqual(workflowGroup(make("main")), { id: "main", label: "Top level" });
		assert.deepEqual(workflowGroup(make("other")), { id: "other", label: "Other workflows" });
		assert.deepEqual(workflowGroup(make("Other Workflows")), { id: "other", label: "Other workflows" });
		assert.deepEqual(workflowGroup(make("TOOLS")), { id: "tools", label: "Tools" });
	});

	it("maps the old groups: build and ship to Other workflows, inspect and settings to Tools", () => {
		for (const old of ["build", "Build", "ship", "Review & Ship"]) assert.deepEqual(workflowGroup(make(old)), { id: "other", label: "Other workflows" }, old);
		for (const old of ["inspect", "Inspect", "settings", "SETTINGS"]) assert.deepEqual(workflowGroup(make(old)), { id: "tools", label: "Tools" }, old);
	});

	it("an unknown name is its own category, labelled as written", () => {
		assert.deepEqual(workflowGroup(make("Docs work")), { id: "docs work", label: "Docs work" });
	});

	it("the shipped groups come from one table: New feature n, the main workflows inline, Other 1, then new categories, Tools 2", () => {
		assert.deepEqual(KNOWN_GROUPS, SHIPPED_GROUPS.map(({ id, label }) => ({ id, label })));
		const byOrder = [...SHIPPED_GROUPS].sort((a, b) => a.order - b.order);
		assert.deepEqual(byOrder.map((group) => group.id), ["feature", "main", "other", "tools"]);
		assert.deepEqual(byOrder.map((group) => group.key), ["n", undefined, "1", "2"]);
		assert.deepEqual(byOrder.map((group) => group.inline === true), [false, true, false, false]);
		assert.ok(byOrder[2].order < CUSTOM_GROUP_ORDER && CUSTOM_GROUP_ORDER < byOrder[3].order);
		// Only a group with a row of its own has an icon; the inline group is shown as its workflows.
		assert.deepEqual(byOrder.map((group) => group.icon === undefined), [false, true, false, false]);
		assert.equal(new Set(byOrder.map((group) => group.icon).filter(Boolean)).size, 3);
		assert.ok(RESERVED_KEYS.includes("n"));
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
		assert.equal(resolveWorkflow(workflows, "pr-feedback").name, "My PRs: feedback");
		assert.equal(resolveWorkflow(workflows, "ticket").name, "Work on a ticket");
		assert.equal(workflowId(workflows[0]), "quick-change");
	});

	it("finds a workflow by key", () => {
		assert.equal(resolveWorkflow(workflows, "b").name, "Bug fix");
		assert.equal(resolveWorkflow(workflows, "x").name, "Refactor a component");
		assert.equal(resolveWorkflow(workflows, "j").name, "Work on a ticket");
		assert.equal(resolveWorkflow(workflows, "r").name, "Review a team PR");
		assert.equal(resolveWorkflow(workflows, "v").name, "Review my branch");
		assert.equal(resolveWorkflow(workflows, "f").name, "My PRs: feedback");
		// New feature is the group key now, not a workflow's.
		assert.throws(() => resolveWorkflow(workflows, "n"), /Unknown workflow/);
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
			assert.equal(clean.workflows.length, 13);
			assert.equal(clean.warning, undefined);
			const dirty = loadWorkflows(parse, { packageDir: join(ASSETS_ROOT, "workflows"), userDir: join(scratch, "user") });
			assert.equal(dirty.workflows.length, 13);
			assert.match(dirty.warning!, /^brigadev: workflow file warnings\n.*bad\.md: .*unknown question "missing"/);
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
