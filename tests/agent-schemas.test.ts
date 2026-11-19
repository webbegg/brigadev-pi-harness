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
