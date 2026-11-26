import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { PACKAGE_AGENTS_DIR } from "../lib/runtime.ts";
import { loadOutputSchema, validateAgainstSchema, type JsonSchema } from "../lib/structured-output.ts";

/** The `output:` frontmatter value of a package agent, resolved like lib/agents.ts does. */
function schemaOf(agent: string): JsonSchema {
	const file = join(PACKAGE_AGENTS_DIR, `${agent}.md`);
	const head = readFileSync(file, "utf8").split("---\n")[1] ?? "";
	const match = head.match(/^output:\s*(\S+)\s*$/m);
	assert.ok(match, `${agent} declares no output schema`);
	const loaded = loadOutputSchema(resolve(dirname(file), match[1]));
	assert.ok("schema" in loaded, `${agent}: ${"error" in loaded ? loaded.error : ""}`);
	return loaded.schema;
}

const finding = { id: "R1-001", severity: "BLOCKER", location: "lib/a.ts:3", claim: "c", evidence: "e", cause: "introduced" };

describe("review schema", () => {
	for (const lens of ["review-4r"]) {
		it(`${lens} accepts its findings contract`, () => {
			const schema = schemaOf(lens);
			assert.deepEqual(validateAgainstSchema(schema, { findings: [finding], reviewed: "patch + 3 files" }), []);
			assert.deepEqual(validateAgainstSchema(schema, { findings: [], reviewed: "patch + 3 files" }), []);
		});

		it(`${lens} rejects unknown severities and causes`, () => {
			const errors = validateAgainstSchema(schemaOf(lens), { findings: [{ ...finding, severity: "MAJOR", cause: "maybe" }], reviewed: "x" });
			assert.equal(errors.length, 2);
		});

		it(`${lens} requires evidence of what was reviewed`, () => {
			assert.deepEqual(validateAgainstSchema(schemaOf(lens), { findings: [] }), ["$.reviewed: required"]);
		});
	}
});

describe("review risk ratings (factory lanes S8)", () => {
	const rating = (level: string) => ({ level, reason: "r" });
	const risk = { sideEffect: rating("low"), performance: rating("none"), backcompat: rating("medium") };

	it("review-4r accepts the three ratings, and stays valid without them", () => {
		const schema = schemaOf("review-4r");
		assert.deepEqual(validateAgainstSchema(schema, { findings: [], reviewed: "x", risk }), []);
		assert.deepEqual(validateAgainstSchema(schema, { findings: [], reviewed: "x" }), []);
	});

	it("rejects an unknown level and a rating without its reason", () => {
		const schema = schemaOf("review-4r");
		assert.equal(validateAgainstSchema(schema, { findings: [], reviewed: "x", risk: { ...risk, performance: rating("huge") } }).length, 1);
		assert.equal(validateAgainstSchema(schema, { findings: [], reviewed: "x", risk: { ...risk, sideEffect: { level: "low" } } }).length, 1);
	});

	it("review-4r asks for the ratings", () => {
		const text = readFileSync(join(PACKAGE_AGENTS_DIR, "review-4r.md"), "utf8");
		for (const needle of ["sideEffect", "performance", "backcompat"]) assert.ok(text.includes(needle), needle);
	});
});

describe("brigadev-reproduce (factory lanes S8)", () => {
	const text = readFileSync(join(PACKAGE_AGENTS_DIR, "brigadev-reproduce.md"), "utf8");
	const found = { reproduced: true, command: "node --test tests/a.test.ts", output: "expected 1, got 2", testPath: "tests/a.test.ts", tried: [] };

	it("is a writer limited to tests by its surfaces, and never fixes", () => {
		assert.match(text, /^writer: true$/m);
		assert.match(text, /never (?:edit|change) (?:source|the code under test)/i);
		assert.match(text, /fails because of the bug/);
	});

	it("returns a reproduction, or what was tried", () => {
		const schema = schemaOf("brigadev-reproduce");
		assert.deepEqual(validateAgainstSchema(schema, found), []);
		assert.deepEqual(validateAgainstSchema(schema, { reproduced: false, command: "", output: "", testPath: "", tried: [{ attempt: "npm test", result: "passes" }], unblock: "a redacted log" }), []);
		assert.deepEqual(validateAgainstSchema(schema, { reproduced: true }), ["$.command: required", "$.output: required", "$.testPath: required", "$.tried: required"]);
	});
});

describe("brigadev-analyze (factory lanes S8)", () => {
	const text = readFileSync(join(PACKAGE_AGENTS_DIR, "brigadev-analyze.md"), "utf8");
	const analysis = {
		probe: { command: "node probe.ts", output: "TypeError: blockedDomains", fails: true },
		specs: [{ id: "S1", text: "accept blockedDomains", check: "node --test tests/a.test.ts" }],
		docsScope: "docs/web-search.md",
		backcompat: "optional field; existing callers unchanged",
	};

	it("is read-only and writes its probe only in a scratch copy", () => {
		assert.doesNotMatch(text, /^writer: true$/m);
		assert.match(text, /^tools: read, grep, find, ls, bash, codemode$/m);
		assert.match(text, /mktemp -d/);
	});

	it("returns the probe, the specs, the docs scope, and backward compatibility", () => {
		const schema = schemaOf("brigadev-analyze");
		assert.deepEqual(validateAgainstSchema(schema, analysis), []);
		assert.deepEqual(validateAgainstSchema(schema, { ...analysis, specs: [] }), ["$.specs: expected at least 1 item"]);
		assert.deepEqual(validateAgainstSchema(schema, { ...analysis, probe: { command: "c", output: "o" } }), ["$.probe.fails: required"]);
	});
});

describe("brigadev-verify agent", () => {
	const text = readFileSync(join(PACKAGE_AGENTS_DIR, "brigadev-verify.md"), "utf8");

	it("works without a feature document: the spec is the document's S# or the task's own numbered criteria (A1..An)", () => {
		assert.match(text, /A1/);
		assert.match(text, /acceptance criteria/i);
		assert.doesNotMatch(text, /Read the whole feature document/);
		assert.match(text, /no feature document|without a feature document|when (?:one is|a feature document is) (?:given|named|passed)/i);
	});

	it("asks for quiet test output and has no run budget field", () => {
		assert.match(text, /summary reporter/i);
		assert.match(text, /tail/i);
		assert.doesNotMatch(text, /budgetMinutes/);
	});
});

describe("brigadev-verify schema", () => {
	const report = {
		verdicts: [{ spec: "S1", verdict: "met", evidence: "probe" }],
		blockers: [{ summary: "s", reproduction: "r" }],
		advisories: [],
		regressionTests: [{ path: "tests/a.test.ts", content: "test", covers: "S1" }],
		scratch: ["/tmp/x"],
		unverified: [],
	};

	it("accepts the verifier's return contract", () => {
		assert.deepEqual(validateAgainstSchema(schemaOf("brigadev-verify"), report), []);
	});

	it("takes verdicts against the task's numbered acceptance criteria (A1..An) as well as S#", () => {
		const schema = schemaOf("brigadev-verify");
		assert.deepEqual(validateAgainstSchema(schema, { ...report, verdicts: [{ spec: "A1", verdict: "met", evidence: "probe" }, { spec: "A2", verdict: "unmet", evidence: "probe" }] }), []);
		const verdicts = ((schema.properties as any).verdicts ?? {}) as { description?: string; items?: { properties?: { spec?: { description?: string } } } };
		assert.match(verdicts.description ?? "", /\bA\d|acceptance criteri/i);
		assert.match(verdicts.items?.properties?.spec?.description ?? "", /A1/);
		assert.doesNotMatch(verdicts.description ?? "", /in the feature document/i);
	});

	it("keeps the result small: a regression test is a path, what it covers, and a short reproduction", () => {
		const schema = schemaOf("brigadev-verify");
		const compact = { ...report, regressionTests: [{ path: "tests/a.test.ts", covers: "A1", reproduction: "node --test tests/a.test.ts fails: expected 1, got 2" }] };
		assert.deepEqual(validateAgainstSchema(schema, compact), []);
	});

	it("allows only the documented verdicts", () => {
		const errors = validateAgainstSchema(schemaOf("brigadev-verify"), { ...report, verdicts: [{ spec: "S1", verdict: "ok", evidence: "e" }] });
		assert.equal(errors.length, 1);
	});
});
