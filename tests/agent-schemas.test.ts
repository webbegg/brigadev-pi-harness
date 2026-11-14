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

describe("review lens schemas", () => {
	for (const lens of ["review-risk", "review-readability", "review-reliability", "review-resilience"]) {
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

describe("Judgment Day judge schemas", () => {
	for (const judge of ["jd-judge-a", "jd-judge-b"]) {
		it(`${judge} accepts discovery and re-judgment payloads`, () => {
			const schema = schemaOf(judge);
			assert.deepEqual(validateAgainstSchema(schema, { findings: [{ id: "JD-A-001", severity: "CRITICAL", location: "a.ts:1", claim: "c", evidence: "e" }] }), []);
			assert.deepEqual(validateAgainstSchema(schema, { resolutions: [{ id: "JD-A-001", outcome: "verified", evidence: "e" }] }), []);
		});

		it(`${judge} rejects an unknown outcome`, () => {
			assert.equal(validateAgainstSchema(schemaOf(judge), { resolutions: [{ id: "x", outcome: "fixed", evidence: "e" }] }).length, 1);
		});
	}
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

	it("allows only the documented verdicts", () => {
		const errors = validateAgainstSchema(schemaOf("brigadev-verify"), { ...report, verdicts: [{ spec: "S1", verdict: "ok", evidence: "e" }] });
		assert.equal(errors.length, 1);
	});
});
