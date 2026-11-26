import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { discoverAgents } from "../lib/agents.ts";
import { evaluate, loadCases, parseCase, parseEvalArgs, parseFlatFrontmatter, selectPath } from "../lib/evals.ts";
import { PACKAGE_AGENTS_DIR, PACKAGE_ROOT } from "../lib/runtime.ts";

const valid = { task: "Review the patch", expect: [{ path: "$.findings", minItems: 1 }] };

describe("parseCase", () => {
	it("accepts a minimal case and every optional field", () => {
		assert.deepEqual(parseCase(valid), { ok: true, spec: valid });
		const full = { ...valid, reason: "eval", fixture: "fixture", allowedEditSurfaces: ["tests/**"], expect: [{ path: "$.a", equals: 1 }, { path: "$.b[*].c", matches: "^x" }, { path: "$.d", exists: true }, { file: "a.txt", exists: true }, { file: "$.testPath", contains: "it(" }] };
		assert.equal(parseCase(full).ok, true);
	});

	it("names every problem with its field", () => {
		const result = parseCase({ task: "", reason: 3, fixture: "../up", allowedEditSurfaces: "x", expect: [{ path: "findings", exists: true }, { path: "$.a", equals: 1, exists: true }, { path: "$.a", matches: "(" }, { path: "$.a", minItems: -1 }, { path: "$.a", exists: false }, { file: "/etc/passwd", exists: true }, { file: "a", contains: 1 }, {}], extra: 1 });
		assert.equal(result.ok, false);
		assert.deepEqual(!result.ok && result.errors, [
			"unknown field: extra",
			"task: required, a non-empty string",
			"reason: must be a string",
			"fixture: must be a relative directory inside the case",
			"allowedEditSurfaces: must be an array of strings",
			"expect[0].path: invalid path findings (use $, .name, [n], [*])",
			"expect[1]: a path assertion needs exactly one of equals, matches, minItems, exists",
			"expect[2].matches: invalid regex (",
			"expect[3].minItems: must be a non-negative integer",
			"expect[4].exists: must be true",
			"expect[5].file: must be a relative path inside the fixture, or a $ path of the result",
			"expect[6].contains: must be a string",
			"expect[7]: needs path or file",
		]);
	});

	it("needs a non-empty expect list and an object", () => {
		assert.deepEqual(parseCase({ task: "t", expect: [] }), { ok: false, errors: ["expect: required, a non-empty array of assertions"] });
		assert.deepEqual(parseCase([]), { ok: false, errors: ["case.json must be a JSON object"] });
	});
});

describe("selectPath", () => {
	const value = { findings: [{ severity: "WARNING" }, { severity: "BLOCKER" }], probe: { fails: true } };

	it("walks names, indexes, and wildcards", () => {
		assert.deepEqual(selectPath(value, "$"), [value]);
		assert.deepEqual(selectPath(value, "$.probe.fails"), [true]);
		assert.deepEqual(selectPath(value, "$.findings[1].severity"), ["BLOCKER"]);
		assert.deepEqual(selectPath(value, "$.findings[*].severity"), ["WARNING", "BLOCKER"]);
		assert.deepEqual(selectPath(value, "$.findings[5].severity"), []);
		assert.deepEqual(selectPath(value, "$.missing.deeper"), []);
	});
});

describe("evaluate", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-evals-"));
		mkdirSync(join(dir, "tests"));
		writeFileSync(join(dir, "tests", "slug.test.js"), "it('keeps dashes')");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	const result = { reproduced: true, testPath: "tests/slug.test.js", findings: [{ severity: "WARNING" }, { severity: "CRITICAL" }], specs: [], escape: "../outside" };
	const one = (assertion: Record<string, unknown>, value: unknown = result) => evaluate([assertion as never], value, dir)[0];
	const none = (assertion: Record<string, unknown>) => evaluate([assertion as never], undefined, dir)[0];

	it("passes and fails each path assertion with its reason", () => {
		assert.deepEqual(one({ path: "$.reproduced", equals: true }), { assertion: { path: "$.reproduced", equals: true }, pass: true, reason: "$.reproduced equals true" });
		assert.equal(one({ path: "$.reproduced", equals: false }).reason, "$.reproduced is true, expected false");
		assert.equal(one({ path: "$.findings[*].severity", matches: "^(BLOCKER|CRITICAL)$" }).pass, true);
		assert.equal(one({ path: "$.findings[0].severity", matches: "^(BLOCKER|CRITICAL)$" }).reason, '$.findings[0].severity is "WARNING", expected to match /^(BLOCKER|CRITICAL)$/');
		assert.equal(one({ path: "$.findings", minItems: 2 }).pass, true);
		assert.equal(one({ path: "$.specs", minItems: 1 }).reason, "$.specs has 0 items, expected at least 1");
		assert.equal(one({ path: "$.reproduced", minItems: 1 }).reason, "$.reproduced is not an array");
		assert.equal(one({ path: "$.testPath", exists: true }).pass, true);
		assert.equal(one({ path: "$.unblock", exists: true }).reason, "$.unblock: not found");
	});

	it("fails every path assertion when there is no structured result", () => {
		assert.deepEqual(none({ path: "$.reproduced", exists: true }), { assertion: { path: "$.reproduced", exists: true }, pass: false, reason: "no structured result" });
	});

	it("checks files in the run's directory, by literal path or a $ path of the result", () => {
		assert.equal(one({ file: "tests/slug.test.js", exists: true }).pass, true);
		assert.equal(one({ file: "$.testPath", contains: "keeps dashes" }).pass, true);
		assert.equal(one({ file: "$.testPath", contains: "nope" }).reason, 'tests/slug.test.js does not contain "nope"');
		assert.equal(one({ file: "missing.txt", exists: true }).reason, "missing.txt: not found");
		assert.equal(one({ file: "$.unblock", exists: true }).reason, "$.unblock: not a single string");
		assert.equal(one({ file: "$.escape", exists: true }).reason, "../outside: outside the run's directory");
	});
});

describe("loadCases", () => {
	let root: string;
	before(() => {
		root = mkdtempSync(join(tmpdir(), "brigadev-evals-load-"));
		const write = (rel: string, text: string) => {
			mkdirSync(join(root, rel, ".."), { recursive: true });
			writeFileSync(join(root, rel), text);
		};
		write("review-4r/bug/case.json", JSON.stringify({ ...valid, fixture: "fixture" }));
		mkdirSync(join(root, "review-4r", "bug", "fixture"));
		write("review-4r/broken/case.json", "{ not json");
		write("review-4r/no-fixture/case.json", JSON.stringify({ ...valid, fixture: "fixture" }));
		mkdirSync(join(root, "review-4r", "empty"));
		write("brigadev-analyze/probe/case.json", JSON.stringify(valid));
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	it("loads every case, sorted, with the fixture resolved, and reports the bad ones", () => {
		const { cases, errors } = loadCases(root);
		assert.deepEqual(
			cases.map((c) => [c.agent, c.name, c.fixture]),
			[
				["brigadev-analyze", "probe", undefined],
				["review-4r", "bug", join(root, "review-4r", "bug", "fixture")],
			],
		);
		assert.equal(errors.length, 3);
		assert.match(errors[0], /^review-4r\/broken: case\.json is not valid JSON/);
		assert.equal(errors[1], "review-4r/empty: missing case.json");
		assert.equal(errors[2], "review-4r/no-fixture: fixture: no such directory fixture");
	});

	it("keeps one agent's cases, and reports a missing folder", () => {
		assert.deepEqual(loadCases(root, "brigadev-analyze").cases.map((c) => c.name), ["probe"]);
		assert.deepEqual(loadCases(join(root, "nope")), { cases: [], errors: [`no evals folder at ${join(root, "nope")}`] });
	});
});

describe("the shipped eval cases", () => {
	it("are valid and target package agents with an output schema", () => {
		const { cases, errors } = loadCases(join(PACKAGE_ROOT, "evals"));
		assert.deepEqual(errors, []);
		const agents = discoverAgents({ packageAgentsDir: PACKAGE_AGENTS_DIR, userAgentsDir: "", cwd: PACKAGE_ROOT, includeProject: false, parse: parseFlatFrontmatter });
		assert.deepEqual([...new Set(cases.map((c) => c.agent))], ["brigadev-analyze", "brigadev-reproduce", "review-4r"]);
		for (const c of cases) assert.ok(agents.find((a) => a.name === c.agent)?.outputSchema, `${c.agent} has an output schema`);
	});
});

describe("parseEvalArgs", () => {
	it("takes an optional agent and --model, and names anything else", () => {
		assert.deepEqual(parseEvalArgs([]), { ok: true, args: {} });
		assert.deepEqual(parseEvalArgs(["review-4r", "--model", "anthropic/claude-haiku-5-5"]), { ok: true, args: { agent: "review-4r", model: "anthropic/claude-haiku-5-5" } });
		assert.deepEqual(parseEvalArgs(["--model=a/b"]), { ok: true, args: { model: "a/b" } });
		assert.deepEqual(parseEvalArgs(["--model"]), { ok: false, error: "--model needs provider/id" });
		assert.deepEqual(parseEvalArgs(["a", "b"]), { ok: false, error: "unexpected argument b" });
		assert.deepEqual(parseEvalArgs(["--fast"]), { ok: false, error: "unknown option --fast" });
	});
});

describe("parseFlatFrontmatter", () => {
	it("reads flat key: value lines with booleans and quotes, and the body", () => {
		assert.deepEqual(parseFlatFrontmatter('---\nname: review-4r\ndescription: "a: b"\nwriter: true\n---\n\nBody'), { frontmatter: { name: "review-4r", description: "a: b", writer: true }, body: "\nBody" });
		assert.deepEqual(parseFlatFrontmatter("no frontmatter"), { frontmatter: {}, body: "no frontmatter" });
	});
});
