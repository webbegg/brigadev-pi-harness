import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMPACT_MAX_CHARS, compactResult, compactStructured, compactText } from "../lib/result-compaction.ts";

const big = (n: number, ch = "x") => ch.repeat(n);

describe("compactText: head and tail with an omitted marker", () => {
	it("returns short text unchanged", () => {
		assert.equal(compactText("short"), "short");
		assert.equal(compactText(big(COMPACT_MAX_CHARS)), big(COMPACT_MAX_CHARS));
	});

	it("keeps the start and the end of a long text, states how much was omitted, and stays near the cap", () => {
		const text = `HEAD-${big(30_000)}-TAIL`;
		const out = compactText(text);
		assert.ok(out.startsWith("HEAD-"));
		assert.ok(out.endsWith("-TAIL"));
		assert.match(out, /\[\.\.\. \d[\d,]* chars omitted \.\.\.\]/);
		assert.ok(out.length <= COMPACT_MAX_CHARS + 100, `length ${out.length}`);
	});
});

describe("compactStructured: a verify result", () => {
	const verify = {
		verdicts: [
			{ spec: "S12", verdict: "met", evidence: "argv test green" },
			{ spec: "S13", verdict: "unverified", evidence: "no runner" },
		],
		blockers: [{ summary: "guard bypass", reproduction: "run X then Y", spec: "S12" }],
		advisories: [{ summary: `first line\nsecond line ${big(2000)}`, reproduction: big(5000) }],
		regressionTests: [{ path: "tests/regression.test.ts", covers: "S12", reproduction: "node --test", content: big(40_000, "t") }],
		scratch: ["/tmp/brigadev-scratch-1"],
		unverified: ["S13: needs the network (curl https://x)"],
	};

	it("keeps verdicts, blockers and unverified; regression tests are path and covers only", () => {
		const out = compactStructured(verify);
		assert.match(out, /S12/);
		assert.match(out, /met/);
		assert.match(out, /argv test green/);
		assert.match(out, /unverified/);
		assert.match(out, /guard bypass/);
		assert.match(out, /run X then Y/);
		assert.match(out, /S13: needs the network/);
		assert.match(out, /tests\/regression\.test\.ts/);
		assert.ok(!out.includes("ttttttttt"), "regression test content is dropped");
		assert.ok(out.length < COMPACT_MAX_CHARS, `length ${out.length}`);
	});

	it("shows only the first lines of an advisory, capped", () => {
		const out = compactStructured(verify);
		assert.match(out, /first line/);
		assert.ok(!out.includes("x".repeat(1000)), "advisory bodies are capped");
	});

	it("is much smaller than the raw result", () => {
		assert.ok(JSON.stringify(verify).length > 40_000);
		assert.ok(compactStructured(verify).length < 3000);
	});
});

describe("compactStructured: a review result", () => {
	const finding = (id: string, severity: string) => ({ id, severity, location: "lib/a.ts:10", claim: `claim ${id}`, evidence: `evidence ${id}`, cause: "introduced" });
	const review = {
		findings: [finding("R-001", "BLOCKER"), finding("R-002", "CRITICAL"), finding("R-003", "WARNING"), finding("R-004", "SUGGESTION"), finding("R-005", "SUGGESTION")],
		reviewed: "patch of 3 files, ran the suite",
	};

	it("keeps BLOCKER, CRITICAL and WARNING findings in full and only counts suggestions", () => {
		const out = compactStructured(review);
		for (const id of ["R-001", "R-002", "R-003"]) {
			assert.match(out, new RegExp(id));
			assert.match(out, new RegExp(`evidence ${id}`));
		}
		assert.match(out, /lib\/a\.ts:10/);
		assert.ok(!out.includes("R-004") && !out.includes("R-005"), "suggestions are not listed");
		assert.match(out, /2 SUGGESTION/);
		assert.match(out, /patch of 3 files, ran the suite/);
	});

	it("a clean review says so and keeps `reviewed`", () => {
		const out = compactStructured({ findings: [], reviewed: "all of it" });
		assert.match(out, /no findings/i);
		assert.match(out, /all of it/);
	});
});

describe("compactStructured: an unknown payload", () => {
	it("falls back to compact JSON, head and tail when huge", () => {
		const out = compactStructured({ custom: big(30_000) });
		assert.ok(out.length <= COMPACT_MAX_CHARS + 100);
	});
});

describe("compactResult: the path of the full result is always last", () => {
	it("appends the path for text, structured, and short results", () => {
		const dir = "/docs/runs/20261118T000000Z-brigadev-verify-abc123";
		const suffix = `\n\nFull result: ${dir}/result.json`;
		assert.equal(compactResult({ text: "hi", artifactsDir: dir }), `hi${suffix}`);
		assert.ok(compactResult({ text: big(20_000), artifactsDir: dir }).endsWith(suffix));
		assert.ok(compactResult({ structured: { findings: [], reviewed: "x" }, artifactsDir: dir }).endsWith(suffix));
	});

	it("adds nothing when the run saved no folder", () => {
		assert.equal(compactResult({ text: "hi" }), "hi");
	});
});
