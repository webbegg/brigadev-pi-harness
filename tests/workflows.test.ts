import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type FrontmatterParser } from "../lib/agents.ts";
import { ASSETS_ROOT, PACKAGE_ROOT } from "../lib/runtime.ts";
import { composeRequest } from "../lib/workflow-run.ts";
import { discoverWorkflows, loadWorkflows, parseWorkflow, resolveWorkflow, workflowDirs, workflowId, type Workflow } from "../lib/workflows.ts";

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

const SHIPPED = ["Feature", "Work on a ticket", "Review a team PR", "My PRs: feedback", "Bug fix", "Refactor a component"];

describe("package workflows", () => {
	const loaded = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });

	it("ships exactly the six workflows, in menu order, with no warnings", () => {
		assert.deepEqual(loaded.warnings, []);
		assert.deepEqual(loaded.workflows.map((w) => w.name), SHIPPED);
		assert.deepEqual(loaded.workflows.map(workflowId), ["feature", "ticket", "team-review", "pr-feedback", "bug-fix", "refactor"]);
		assert.ok(loaded.workflows.every((w) => w.source === "package" && w.description.length > 0 && w.body.length > 0));
	});

	it("keeps no dashboard frontmatter: no key and no group in any shipped file", () => {
		for (const name of readdirSync(join(ASSETS_ROOT, "workflows"))) {
			const head = readFileSync(join(ASSETS_ROOT, "workflows", name), "utf8").split(/\n---\n/)[0];
			assert.ok(!/^(key|group):/m.test(head), name);
		}
	});

	it("asks the questions of each workflow", () => {
		const questions = (id: string) => loaded.workflows.find((w) => workflowId(w) === id)!.questions.map((q) => [q.id, q.kind, q.required]);
		assert.deepEqual(questions("feature"), [["what", "long", true], ["area", "text", false], ["criteria", "long", false], ["ticket", "text", false], ["size", "choice", false]]);
		assert.deepEqual(questions("ticket"), [["key", "text", true], ["kind", "choice", false], ["text", "long", true], ["design", "text", false], ["size", "choice", false]]);
		assert.deepEqual(questions("team-review"), [["pr", "text", false], ["focus", "choice", false], ["notes", "long", false]]);
		assert.deepEqual(questions("pr-feedback"), [["pr", "text", false], ["which", "choice", false], ["mode", "choice", false]]);
	});

	it("the feature and ticket workflows offer the same three sizes, defaulting to the agent's choice", () => {
		for (const id of ["feature", "ticket"]) {
			const size = loaded.workflows.find((w) => workflowId(w) === id)!.questions.find((q) => q.id === "size")!;
			assert.deepEqual([size.options, size.default], [["Let the agent decide", "Quick change", "Plan first"], "Let the agent decide"], id);
		}
	});

	it("the ticket workflow's choices and labels", () => {
		const ticket = loaded.workflows.find((w) => workflowId(w) === "ticket")!;
		const q = (id: string) => ticket.questions.find((candidate) => candidate.id === id)!;
		assert.equal(q("key").label, "Ticket key, e.g. PROJ-123");
		assert.deepEqual([q("kind").options, q("kind").default], [["Story or task", "Bug"], "Story or task"]);
		assert.equal(q("text").label, "Paste the ticket: title, description, acceptance criteria");
		assert.equal(q("design").label, "Design or other link");
	});

	it("the two PR workflows word the optional PR input the same way", () => {
		const label = (id: string) => loaded.workflows.find((w) => workflowId(w) === id)!.questions[0].label;
		assert.equal(label("team-review"), "PR number or URL (empty: pick from a list)");
		assert.equal(label("pr-feedback"), "PR number or URL (empty: pick from a list)");
	});

	it("My PRs: feedback names its two modes by what they do", () => {
		const mode = loaded.workflows.find((w) => workflowId(w) === "pr-feedback")!.questions.find((q) => q.id === "mode")!;
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

	it("asks the frontend context question of Bug fix as optional text, after the question it extends", () => {
		const bug = loaded.workflows.find((w) => w.name === "Bug fix")!.questions;
		const environment = bug.find((q) => q.id === "environment")!;
		assert.equal(environment.label, "Environment: browser, device, app version, or feature flag");
		assert.deepEqual([environment.kind, environment.required], ["text", false]);
		assert.equal(bug.findIndex((q) => q.id === "environment"), bug.findIndex((q) => q.id === "where") + 1);
	});
});

describe("package workflows composed", () => {
	const loaded = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });
	const facts = { currentBranch: "feat/x", defaultBranch: "main", testScript: "package.json test script: npm run check" };
	// Names the skill or command each workflow must hand to the orchestrator.
	const NEEDS: Record<string, string[]> = {
		Feature: ["Quick change", "no feature document", "odd-tracking.md", "verbatim as L1", "stop for the user's approval before the first source write", "usual tracking rule"],
		"Work on a ticket": ["Refs:", "short-slug", "failing test that reproduces it"],
		"Review a team PR": ["brigadev-review", "brigadev-comment-writer", 'gh pr list --search "review-requested:@me" --state open', "gh pr view", "gh pr diff", "path:line", "Post nothing unless the user asks"],
		"My PRs: feedback": ["brigadev-comment-writer", "brigadev-branch-pr", "gh pr list --author @me --state open", "Draft replies only"],
		"Bug fix": ["regression test", "`diagnosis.md`"],
		"Refactor a component": ["brigadev-branch-pr", "contract change", "Risk: contract (public API change)"],
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

	it("rules owned elsewhere are pointed at, not restated: no removed skills, no numbered risk items, no slicing or push policy", () => {
		const shipped = [...readdirSync(join(PACKAGE_ROOT, "skills")), ...readdirSync(join(ASSETS_ROOT, "agents")).map((name) => name.replace(/\.md$/, ""))];
		for (const workflow of loaded.workflows) {
			assert.ok(!/brigadev-(work-unit-commits|chained-pr|skill-creator)/.test(workflow.body), `${workflow.name}: removed skill`);
			assert.ok(!/Risk: item|\bitem [0-9]/.test(workflow.body), `${workflow.name}: numbered risk item`);
			assert.ok(!/~400|Conventional Commits/.test(workflow.body), `${workflow.name}: rule owned by brigadev-branch-pr`);
			for (const [skill] of workflow.body.matchAll(/brigadev-[a-z-]+/g)) assert.ok(shipped.includes(skill), `${workflow.name}: ${skill} is not a shipped skill or agent`);
		}
	});

	it("Feature: Quick change is inline and test first with no feature document; Plan first tracks with the request as L1 and waits for approval", () => {
		for (const size of ["Let the agent decide", "Quick change", "Plan first"]) {
			const text = compose("feature", { what: "w", size });
			assert.ok(text.includes(`- Size: ${size}`), size);
			for (const needle of ["inline, test first", "one work unit and its commit", "stop and say so instead of growing it", "odd-tracking.md", "verbatim as L1", "stop for the user's approval before the first source write", "usual tracking rule"]) assert.ok(text.includes(needle), `${size}: ${needle}`);
		}
		assert.ok(!compose("feature", { what: "w" }).includes("never create a plan"));
	});

	it("Work on a ticket: the request normalizes the key first, then uses it in the branch, the commit footer, and the PR title", () => {
		const text = compose("ticket", { key: "PROJ-123", text: "Title\nAs a user I want X" });
		for (const needle of ["- Ticket key: PROJ-123", "[A-Za-z][A-Za-z0-9]+-[0-9]+", "first match", "uppercase", "ask once for the key and stop", "feat/<KEY>-<short-slug>", "fix/<KEY>-<short-slug>", "Refs: <KEY>", "(<KEY>)", "Kind: Story or task", "overriding this workflow file", "quote it verbatim"]) {
			assert.ok(text.includes(needle), needle);
		}
		assert.match(text, /Ticket text:\n> Title\n> As a user I want X/);
		// The normalization comes before the first use of <KEY>.
		assert.ok(text.indexOf("uppercase") < text.indexOf("feat/<KEY>"));
	});

	it("Bug fix and the Bug path of a ticket point at the lazily read diagnosis loop, which exists and stays short", () => {
		const path = join(ASSETS_ROOT, "diagnosis.md");
		assert.ok(existsSync(path), "assets/diagnosis.md");
		const loop = readFileSync(path, "utf8");
		assert.ok(loop.split("\n").length <= 70, "diagnosis.md stays short");
		for (const needle of ["failing test", "RED", "GREEN", "[DEBUG-", "evidence log"]) assert.ok(loop.includes(needle), `diagnosis.md: ${needle}`);
		const bug = compose("bug-fix", { where: "w", steps: "s", expected: "e", actual: "a" });
		const ticket = compose("ticket", { key: "PROJ-1", text: "t", kind: "Bug" });
		for (const [name, text] of [["Bug fix", bug], ["Work on a ticket", ticket]]) assert.ok(text.includes("`diagnosis.md`"), name);
	});

	it("Work on a ticket: the request defines all three sizes and quotes the chosen one", () => {
		for (const size of ["Let the agent decide", "Quick change", "Plan first"]) {
			const text = compose("ticket", { key: "PROJ-1", text: "t", size });
			assert.ok(text.includes(`- Size: ${size}`), size);
			for (const needle of ["one work unit", "no feature document", "odd-tracking.md", "stop for the user's approval before the first source write", "usual tracking rule"]) assert.ok(text.includes(needle), `${size}: ${needle}`);
		}
	});

	it("Work on a ticket: Quick change stops with the same text as the Feature workflow", () => {
		const ticket = compose("ticket", { key: "PROJ-1", text: "t", size: "Quick change" });
		const feature = compose("feature", { what: "w", size: "Quick change" });
		const quick = (text: string) => /"Quick change" means[^"]*?stop and say so instead of growing it\./.exec(text)?.[0];
		assert.ok(quick(feature));
		assert.equal(quick(ticket), quick(feature));
	});

	it("Work on a ticket, Plan first: the whole request (key, kind, ticket text, link) is L1 verbatim", () => {
		const text = compose("ticket", { key: "PROJ-9", text: "Title\nBody", design: "https://figma.example/f", size: "Plan first" });
		assert.ok(text.includes("- Size: Plan first"));
		assert.ok(text.includes("- Design or other link: https://figma.example/f"));
		assert.ok(text.includes("the whole request above (key, kind, ticket text, and link) as L1 verbatim"));
	});

	it("Work on a ticket, Bug + Quick change: a failing test that reproduces it comes first, whatever the size", () => {
		const text = compose("ticket", { key: "PROJ-2", text: "Crash on save", kind: "Bug", size: "Quick change" });
		for (const needle of ["Kind: Bug", "Size: Quick change", "bug-fix flow", "failing test that reproduces it comes first, whatever the size", "one work unit", "fix/<KEY>-<short-slug>"]) assert.ok(text.includes(needle), needle);
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

	it("Review a team PR: any other focus names that lens first, plus the lens a high-risk category needs", () => {
		const text = compose("team-review", { focus: "Reliability" });
		for (const needle of ["Focus: Reliability", "Any other focus: name the chosen lens first", "add the lens that covers any high-risk category the change carries", "and say so"]) assert.ok(text.includes(needle), needle);
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

	it("Refactor: a public API change is named as a contract change and ends with a category risk line, never a numbered item", () => {
		const text = compose("refactor", { component: "c", goal: "g" });
		assert.ok(text.includes("`Risk: contract (public API change)`"));
		assert.ok(!/Risk: item/.test(text));
	});

	it("Refactor: the verify runs before the PR, never per unit", () => {
		const text = compose("refactor", { component: "c", goal: "g" });
		assert.ok(text.includes("`brigadev-verify` runs before the PR"));
		assert.ok(!text.includes("after the change's own checks"));
		for (const workflow of loaded.workflows) assert.ok(!/brigadev-verify[^.]*(?<!not )(per|each|every) (work )?unit/i.test(workflow.body), workflow.name);
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

describe("legacy key: and group: frontmatter", () => {
	let scratch: string;
	const put = (dir: string, fileName: string, content: string) => {
		mkdirSync(join(scratch, dir), { recursive: true });
		writeFileSync(join(scratch, dir, fileName), content);
	};
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-workflow-legacy-"));
		put("pkg", "one.md", file("One", 'order: 2\nkey: "j"\ngroup: "ship"\n'));
		put("pkg", "two.md", file("Two", 'order: 1\nkey: "j"\n'));
		put("user", "three.md", file("Three", 'order: 3\nkey: "g"\ngroup: "Docs work"\n'));
		put("user", "four.md", file("Four", 'order: 3\nkey: "nn"\ngroup: ""\n'));
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("loads files with a key or a group silently: duplicate, reserved, or malformed values warn about nothing, and menu order is order then name", () => {
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "user"), parse });
		assert.deepEqual(warnings, []);
		assert.deepEqual(workflows.map((w) => w.name), ["Two", "One", "Four", "Three"]);
		for (const workflow of workflows) assert.ok(!("key" in workflow) && !("group" in workflow), workflow.name);
	});

	it("an override keeps working when it carries a key or a group", () => {
		put("override", "one.md", file("one", 'order: 2\nkey: "z"\ngroup: "x"\n', "Override {{what}}"));
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(scratch, "pkg"), userDir: join(scratch, "override"), parse });
		assert.deepEqual(warnings, []);
		assert.deepEqual(workflows.map((w) => [w.name, w.source]), [["Two", "package"], ["one", "user"]]);
	});

	it("a YAML-null key or group (an empty line) is not an error either", () => {
		const yamlNull: FrontmatterParser = () => ({ frontmatter: { name: "Ship it", description: "d", key: null, group: null }, body: "Do it" });
		const workflow = parseWorkflow("ignored", "/w/x.md", "user", yamlNull);
		assert.ok(!("key" in workflow) && !("group" in workflow));
	});
});

describe("resolveWorkflow", () => {
	const { workflows } = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), parse });

	it("finds a workflow by name, ignoring case", () => {
		assert.equal(resolveWorkflow(workflows, "Bug fix").name, "Bug fix");
		assert.equal(resolveWorkflow(workflows, "  REFACTOR a component ").name, "Refactor a component");
	});

	it("finds a workflow by file id", () => {
		assert.equal(resolveWorkflow(workflows, "bug-fix").name, "Bug fix");
		assert.equal(resolveWorkflow(workflows, "pr-feedback").name, "My PRs: feedback");
		assert.equal(resolveWorkflow(workflows, "ticket").name, "Work on a ticket");
		assert.equal(resolveWorkflow(workflows, "feature").name, "Feature");
		assert.equal(workflowId(workflows[0]), "feature");
	});

	it("does not resolve a one-letter key; the dashboard shortcuts are gone", () => {
		for (const letter of ["b", "j", "r", "f", "x"]) assert.throws(() => resolveWorkflow(workflows, letter), /Unknown workflow/, letter);
	});

	it("prefers an exact name over a file id, so two workflows sharing a file id each resolve by name", () => {
		const make = (name: string, id: string): Workflow => ({ name, description: "d", order: 1, questions: [], body: "b", source: "user", filePath: `/w/${id}.md` });
		const shared = [make("Bug fix", "bug-fix"), make("Defect triage", "bug-fix")];
		assert.equal(resolveWorkflow(shared, "Defect triage"), shared[1]);
		assert.equal(resolveWorkflow(shared, "Bug fix"), shared[0]);
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
	});
});

describe("loadWorkflows", () => {
	it("returns the workflows with one ready-to-show warning text, or none", () => {
		const scratch = mkdtempSync(join(tmpdir(), "brigadev-load-workflows-"));
		try {
			mkdirSync(join(scratch, "user"));
			writeFileSync(join(scratch, "user", "bad.md"), file("Bad", "", "Uses {{missing}}"));
			const clean = loadWorkflows(parse, { packageDir: join(ASSETS_ROOT, "workflows") });
			assert.equal(clean.workflows.length, SHIPPED.length);
			assert.equal(clean.warning, undefined);
			const dirty = loadWorkflows(parse, { packageDir: join(ASSETS_ROOT, "workflows"), userDir: join(scratch, "user") });
			assert.equal(dirty.workflows.length, SHIPPED.length);
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
