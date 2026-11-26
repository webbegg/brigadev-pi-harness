import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import retroExtension from "../extensions/retro.ts";
import { parseCase } from "../lib/evals.ts";
import { blockedLine, draftEvalCase, readRun, runIdProblem, taskSection } from "../lib/retro.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const FIXTURE = join(import.meta.dirname, "fixtures", "retro");
const REPRODUCE = "20261126T101500Z-brigadev-reproduce-a1b2c3";
const REVIEW = "20261126T102000Z-review-4r-d4e5f6";

describe("runIdProblem", () => {
	it("accepts a plain folder name and refuses paths", () => {
		assert.equal(runIdProblem(REPRODUCE), undefined);
		for (const bad of ["", "a/b", "..", "../x", "a..b", "/abs", ".hidden", "a\\b"]) assert.ok(runIdProblem(bad), bad);
	});
});

describe("taskSection", () => {
	it("keeps a multi-line task whole, up to the next section or the end", () => {
		assert.equal(taskSection("## Task\nline one\nline two\n\n## Allowed edit surfaces\n- a\n"), "line one\nline two");
		assert.equal(taskSection("## Task\nline one\nline two\n"), "line one\nline two");
		assert.equal(taskSection("no sections\nat all"), "no sections\nat all");
	});
});

describe("readRun", () => {
	it("reads the task, reason, edit surfaces, and structured result of a run folder", () => {
		const read = readRun(FIXTURE, REPRODUCE);
		assert.ok(read.ok);
		assert.equal(read.run.agent, "brigadev-reproduce");
		assert.equal(read.run.task, 'Bug report. Where: src/slugify.js. Expected "hello-world", actual "hello---world".');
		assert.equal(read.run.reason, "Bug lane: reproduce first");
		assert.deepEqual(read.run.allowedEditSurfaces, ["tests/**", "test/fixtures/"]);
		assert.equal((read.run.structured as { reproduced: boolean }).reproduced, false);
	});

	it("names a missing run and refuses an id that is a path", () => {
		assert.deepEqual(readRun(FIXTURE, "20261126T000000Z-x-000000"), { ok: false, error: `no run folder ${join(FIXTURE, "runs", "20261126T000000Z-x-000000")}` });
		assert.equal(readRun(FIXTURE, "../retro").ok, false);
	});
});

describe("draftEvalCase", () => {
	it("drafts a valid case under evals/<agent>/<runId>/ with an expect skeleton from the result's shape", () => {
		const read = readRun(FIXTURE, REPRODUCE);
		assert.ok(read.ok);
		const draft = draftEvalCase(read.run);
		assert.equal(draft.path, `evals/brigadev-reproduce/${REPRODUCE}/case.json`);
		assert.deepEqual(draft.spec, {
			task: read.run.task,
			reason: "Bug lane: reproduce first",
			allowedEditSurfaces: ["tests/**", "test/fixtures/"],
			expect: [
				{ path: "$.reproduced", equals: false },
				{ path: "$.command", exists: true },
				{ path: "$.output", exists: true },
				{ path: "$.testPath", exists: true },
				{ path: "$.tried", minItems: 1 },
				{ path: "$.unblock", exists: true },
			],
		});
		assert.equal(draft.text, `${JSON.stringify(draft.spec, null, "\t")}\n`);
		assert.ok(parseCase(JSON.parse(draft.text)).ok);
	});

	it("drafts a `$ exists` skeleton for a run without a structured result", () => {
		const read = readRun(FIXTURE, REVIEW);
		assert.ok(read.ok);
		assert.deepEqual(draftEvalCase(read.run).spec.expect, [{ path: "$", exists: true }]);
	});
});

describe("blockedLine", () => {
	it("names what was missing from the result, the error, or leaves it to fill in", () => {
		const reproduce = readRun(FIXTURE, REPRODUCE);
		const review = readRun(FIXTURE, REVIEW);
		assert.ok(reproduce.ok && review.ok);
		assert.equal(blockedLine(reproduce.run), `Outcome: blocked (brigadev-reproduce ${REPRODUCE}). What was missing: the production locale settings`);
		assert.equal(blockedLine(review.run), `Outcome: blocked (review-4r ${REVIEW}). What was missing: model quota exceeded`);
		assert.equal(blockedLine({ ...review.run, errorMessage: undefined }), `Outcome: blocked (review-4r ${REVIEW}). What was missing: `);
	});
});

describe("/brigadev:retro", () => {
	const saved = process.env.BRIGADEV_HOME;
	const savedChild = process.env.BRIGADEV_CHILD;
	let root: string;
	let cwd: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "brigadev-retro-"));
		cwd = join(root, "demo");
		mkdirSync(cwd);
		cpSync(join(FIXTURE, "runs"), join(root, "home", "demo", "runs"), { recursive: true });
		process.env.BRIGADEV_HOME = join(root, "home");
		delete process.env.BRIGADEV_CHILD; // the suite may itself run inside a brigadev child
	});
	after(() => {
		if (saved === undefined) delete process.env.BRIGADEV_HOME;
		else process.env.BRIGADEV_HOME = saved;
		if (savedChild !== undefined) process.env.BRIGADEV_CHILD = savedChild;
		rmSync(root, { recursive: true, force: true });
	});
	beforeEach(() => rmSync(join(cwd, "evals"), { recursive: true, force: true }));

	const run = async (args: string, options: { hasUI?: boolean; outcome?: string; confirm?: boolean } = {}) => {
		const pi = createFakePi();
		retroExtension(pi as never);
		const ctx = createFakeCtx({ cwd, hasUI: options.hasUI ?? true });
		const asked: Array<{ kind: string; title: string; body?: unknown }> = [];
		let editor: string | undefined;
		Object.assign(ctx.ui as object, {
			select: async (title: string, choices: string[]) => (asked.push({ kind: "select", title, body: choices }), options.outcome),
			confirm: async (title: string, body: string) => (asked.push({ kind: "confirm", title, body }), options.confirm ?? false),
			setEditorText: (text: string) => void (editor = text),
		});
		await pi.commands.get("brigadev:retro").handler(args, ctx);
		return { pi, asked, editor, text: ctx.notifications.map((n) => n.message).join("\n") };
	};
	const target = () => join(cwd, "evals", "brigadev-reproduce", REPRODUCE, "case.json");

	it("registers only the command", async () => {
		const { pi } = await run("");
		assert.equal(pi.tools.size, 0);
		assert.equal(pi.handlers.size, 0);
		assert.deepEqual([...pi.commands.keys()], ["brigadev:retro"]);
	});

	it("refuses an id that is not a plain folder name", async () => {
		const { text, asked } = await run("../../etc");
		assert.match(text, /Usage: \/brigadev:retro <runId>/);
		assert.equal(asked.length, 0);
	});

	it("asks the outcome; flawed writes the eval case only after a confirm that shows the path and content", async () => {
		const declined = await run(REPRODUCE, { outcome: "flawed", confirm: false });
		assert.deepEqual(declined.asked[0], { kind: "select", title: `Outcome of brigadev-reproduce run ${REPRODUCE}`, body: ["success", "flawed", "blocked", "manual"] });
		assert.equal(declined.asked[1].kind, "confirm");
		assert.match(String(declined.asked[1].body), new RegExp(`evals/brigadev-reproduce/${REPRODUCE}/case\\.json`));
		assert.match(String(declined.asked[1].body), /"\$\.reproduced"/);
		assert.equal(existsSync(target()), false);

		const accepted = await run(REPRODUCE, { outcome: "flawed", confirm: true });
		assert.ok(parseCase(JSON.parse(readFileSync(target(), "utf8"))).ok);
		assert.match(accepted.text, /Wrote/);
	});

	it("blocked drafts the missing line into the editor; manual and success write nothing", async () => {
		const blocked = await run(REPRODUCE, { outcome: "blocked" });
		assert.equal(blocked.editor, `Outcome: blocked (brigadev-reproduce ${REPRODUCE}). What was missing: the production locale settings`);
		for (const outcome of ["manual", "success"]) {
			const { asked } = await run(REPRODUCE, { outcome });
			assert.equal(asked.length, 1);
		}
		assert.equal(existsSync(join(cwd, "evals")), false);
	});

	it("without a UI prints the draft and writes nothing", async () => {
		const { text, asked } = await run(REPRODUCE, { hasUI: false });
		assert.equal(asked.length, 0);
		assert.match(text, new RegExp(`evals/brigadev-reproduce/${REPRODUCE}/case\\.json`));
		assert.match(text, /"\$\.tried"/);
		assert.equal(existsSync(join(cwd, "evals")), false);
	});
});
