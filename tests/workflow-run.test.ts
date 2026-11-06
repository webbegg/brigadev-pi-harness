import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { askQuestions, composeRequest, gatherFacts, missingRequired, questionDefault, readTestScript, type QuestionUi } from "../lib/workflow-run.ts";
import type { Workflow, WorkflowQuestion } from "../lib/workflows.ts";

const question = (id: string, extra: Partial<WorkflowQuestion> = {}): WorkflowQuestion => ({ id, label: `Label ${id}`, kind: "text", required: false, ...extra });

const workflow = (body: string, questions: WorkflowQuestion[], name = "Sample"): Workflow => ({ name, description: "d", order: 1, questions, body, source: "package", filePath: "/w.md" });

describe("questionDefault", () => {
	it("fills fact placeholders and drops the default when a fact is missing", () => {
		const q = question("target", { default: "{{currentBranch}} against {{defaultBranch}}" });
		assert.equal(questionDefault(q, { currentBranch: "feat/x", defaultBranch: "main" }), "feat/x against main");
		assert.equal(questionDefault(q, { currentBranch: "feat/x", defaultBranch: null }), undefined);
		assert.equal(questionDefault(question("n", { default: "origin" }), {}), "origin");
		assert.equal(questionDefault(question("n"), {}), undefined);
	});
});

describe("composeRequest", () => {
	const w = workflow("Plan the work.\n- What: {{what}}\n- Area: {{area}}\n- Ticket: {{ticket}}", [question("what", { required: true }), question("area"), question("ticket")]);

	it("quotes every answer verbatim", () => {
		const text = composeRequest(w, { what: 'Add a {{ticket}} thing "quoted" & $HOME', area: "src/a.ts", ticket: "ABC-1" }, {});
		assert.match(text, /- What: Add a \{\{ticket\}\} thing "quoted" & \$HOME/);
		assert.match(text, /- Area: src\/a\.ts/);
		assert.match(text, /- Ticket: ABC-1/);
	});

	it("block-quotes a multi-line answer line by line", () => {
		const text = composeRequest(w, { what: "line one\n\nline three", area: "a" }, {});
		assert.match(text, /- What:\n> line one\n> \n> line three\n- Area: a/);
	});

	it("omits the lines of skipped optional answers", () => {
		assert.equal(composeRequest(w, { what: "x", area: "  " }, {}), "Plan the work.\n- What: x");
	});

	it("keeps the provided answers of a line when only some of its placeholders are skipped", () => {
		const two = workflow("Start\nWhere: {{a}} / Ticket: {{b}}\nOther: {{c}}", [question("a"), question("b"), question("c")]);
		assert.equal(composeRequest(two, { a: "x" }, {}), "Start\nWhere: x / Ticket:");
		assert.equal(composeRequest(two, { b: "T-1" }, {}), "Start\nWhere: / Ticket: T-1");
		assert.equal(composeRequest(two, { a: "x", b: "T-1" }, {}), "Start\nWhere: x / Ticket: T-1");
		// Only a line whose placeholders are all skipped is left out.
		assert.equal(composeRequest(two, {}, {}), "Start");
	});

	it("puts a multi-line answer on its own quoted lines and the trailing text after the quote", () => {
		const t = workflow("- What: {{what}} (required)\n  - Nested: {{what}} done\n- Plain: {{what}}", [question("what")]);
		assert.equal(
			composeRequest(t, { what: "a\nb" }, {}),
			"- What:\n> a\n> b\n(required)\n  - Nested:\n  > a\n  > b\n  done\n- Plain:\n> a\n> b",
		);
		assert.equal(composeRequest(t, { what: "one" }, {}), "- What: one (required)\n  - Nested: one done\n- Plain: one");
	});

	it("falls back to the default built from the facts", () => {
		const d = workflow("Start\nBase: {{base}}", [question("base", { default: "{{defaultBranch}}" })]);
		assert.equal(composeRequest(d, {}, { defaultBranch: "main" }), "Start\nBase: main");
		assert.equal(composeRequest(d, { base: "develop" }, { defaultBranch: "main" }), "Start\nBase: develop");
		assert.equal(composeRequest(d, {}, {}), "Start");
	});

	it("refuses a request with an empty required answer, naming the question", () => {
		assert.deepEqual(missingRequired(w, { what: "  ", area: "a" }, {}).map((q) => q.id), ["what"]);
		assert.throws(() => composeRequest(w, { area: "a" }, {}), /required.*what/);
	});

	it("a required question with a default is satisfied by the default", () => {
		const d = workflow("{{v}}", [question("v", { required: true, default: "{{testScript}}" })]);
		assert.deepEqual(missingRequired(d, {}, { testScript: "npm test" }), []);
		assert.deepEqual(missingRequired(d, {}, {}).map((q) => q.id), ["v"]);
	});
});

/** A scripted UI: each call takes the next reply; titles and prefills are recorded. */
function scripted(replies: Array<string | undefined>) {
	const calls: Array<{ kind: string; title: string; arg?: string | string[] }> = [];
	const next = (kind: string, title: string, arg?: string | string[]) => {
		calls.push({ kind, title, arg });
		if (!replies.length) throw new Error(`unexpected ${kind} "${title}"`);
		return Promise.resolve(replies.shift());
	};
	const ui: QuestionUi = { select: (title, options) => next("select", title, options), input: (title, placeholder) => next("input", title, placeholder), editor: (title, prefill) => next("editor", title, prefill) };
	return { ui, calls };
}

describe("askQuestions", () => {
	const w = workflow("{{a}}{{b}}{{c}}{{d}}", [
		question("a", { required: true }),
		question("b", { kind: "long" }),
		question("c", { kind: "choice", options: ["one", "two", "three"], default: "two" }),
		question("d", { default: "{{defaultBranch}}" }),
	]);

	it("asks in order with the right control for each kind and returns the answers", async () => {
		const { ui, calls } = scripted(["answer a", "long\nanswer", "three", "develop"]);
		const answers = await askQuestions(w, { defaultBranch: "main" }, ui);
		assert.deepEqual(answers, { a: "answer a", b: "long\nanswer", c: "three", d: "develop" });
		assert.deepEqual(calls.map((c) => c.kind), ["input", "editor", "select", "input"]);
		assert.match(calls[0].title, /Sample.*Label a/);
		assert.match(calls[1].title, /optional/);
	});

	it("offers the default first in a choice and as the placeholder of a text question", async () => {
		const { ui, calls } = scripted(["a", "", "two", ""]);
		const answers = await askQuestions(w, { defaultBranch: "main" }, ui);
		assert.deepEqual(calls[2].arg, ["two", "one", "three"]);
		assert.equal(calls[3].arg, "main");
		assert.deepEqual(answers, { a: "a", c: "two", d: "main" });
	});

	it("passes current answers as the defaults when editing", async () => {
		const { ui, calls } = scripted(["", "", "one", ""]);
		const answers = await askQuestions(w, { defaultBranch: "main" }, ui, { a: "first", b: "was long", c: "one", d: "x" });
		assert.equal(calls[0].arg, "first");
		assert.equal(calls[1].arg, "was long");
		assert.equal(calls[2].arg?.[0], "one");
		assert.equal(calls[3].arg, "x");
		// Clearing the editor prefill of an optional long question drops the answer.
		assert.deepEqual(answers, { a: "first", c: "one", d: "x" });
	});

	it("lets an optional text answer be cleared with a literal dash when editing", async () => {
		const { ui, calls } = scripted(["-", "-", "one", "-"]);
		const answers = await askQuestions(w, {}, ui, { a: "first", b: "was long", c: "one", d: "x" });
		// Required a: the dash is an ordinary answer. Optional text d: cleared. Long b: no dash rule.
		assert.equal(answers?.a, "-");
		assert.equal(answers?.b, "-");
		assert.equal("d" in (answers ?? {}), false);
		assert.doesNotMatch(calls[0].title, /clears/);
		assert.match(calls[3].title, /\(optional, "-" clears\)/);

		// Without a previous answer there is nothing to clear and the title does not mention it.
		const first = scripted(["a", "", "two", "-"]);
		const fresh = await askQuestions(w, {}, first.ui);
		assert.match(first.calls[3].title, /\(optional\)$/);
		assert.equal(fresh?.d, "-");
	});

	it("offers (no answer) last on an optional choice that has a previous answer, and only then", async () => {
		const opt = workflow("{{c}}", [question("c", { kind: "choice", options: ["one", "two"] })]);
		const clear = scripted(["(no answer)"]);
		assert.deepEqual(await askQuestions(opt, {}, clear.ui, { c: "two" }), {});
		assert.deepEqual(clear.calls[0].arg, ["two", "one", "(no answer)"]);

		const keep = scripted(["one"]);
		assert.deepEqual(await askQuestions(opt, {}, keep.ui, { c: "two" }), { c: "one" });

		const fresh = scripted(["one"]);
		await askQuestions(opt, {}, fresh.ui);
		assert.deepEqual(fresh.calls[0].arg, ["one", "two"]);

		const required = workflow("{{c}}", [question("c", { kind: "choice", required: true, options: ["one", "two"] })]);
		const req = scripted(["two"]);
		await askQuestions(required, {}, req.ui, { c: "one" });
		assert.deepEqual(req.calls[0].arg, ["one", "two"]);
	});

	it("cancels everything when any question is escaped", async () => {
		const { ui } = scripted(["a", undefined]);
		assert.equal(await askQuestions(w, {}, ui), undefined);
	});

	it("re-asks an empty required answer once with a hint, then cancels", async () => {
		const retry = scripted(["  ", "now filled", "", "one", ""]);
		const answers = await askQuestions(w, {}, retry.ui);
		assert.equal(answers?.a, "now filled");
		assert.match(retry.calls[1].title, /required/);
		assert.equal(retry.calls[0].title === retry.calls[1].title, false);

		const giveUp = scripted(["", " "]);
		assert.equal(await askQuestions(w, {}, giveUp.ui), undefined);
		assert.equal(giveUp.calls.length, 2);
	});
});

describe("facts", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-facts-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("reads scripts.test from package.json and nothing when it is missing or unreadable", () => {
		assert.equal(readTestScript(dir), undefined);
		writeFileSync(join(dir, "package.json"), "{ not json");
		assert.equal(readTestScript(dir), undefined);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { build: "tsc" } }));
		assert.equal(readTestScript(dir), undefined);
		writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "node --test" } }));
		assert.equal(readTestScript(dir), "package.json test script: node --test");
	});

	it("combines local git branch facts with the test script", async () => {
		const exec = async (_command: string, args: string[]) => {
			const key = args.join(" ");
			const reply = (stdout: string, code = 0) => ({ stdout, stderr: "", code });
			if (key === "symbolic-ref --short -q HEAD") return reply("feat/x\n");
			if (key === "symbolic-ref --short refs/remotes/origin/HEAD") return reply("origin/main\n");
			return reply("", key.endsWith("refs/heads/master") ? 1 : 0);
		};
		assert.deepEqual(await gatherFacts(exec, dir), { currentBranch: "feat/x", defaultBranch: "main", testScript: "package.json test script: node --test" });
	});

	it("leaves facts out when git cannot answer", async () => {
		const exec = async () => {
			throw new Error("no git");
		};
		const facts = await gatherFacts(exec, join(dir, "missing"));
		assert.equal(facts.currentBranch ?? null, null);
		assert.equal(facts.defaultBranch ?? null, null);
		assert.equal(facts.testScript, undefined);
	});
});
