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
		assert.match(out, /Met \(1\): S12/);
		assert.ok(!out.includes("argv test green"), "a met verdict is its id only");
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

	it("lists at most 5 WARNING findings and counts the rest, with a SUGGESTION count instead of suggestions", () => {
		const many = { findings: [...Array.from({ length: 7 }, (_, i) => finding(`W-${i + 1}`, "WARNING")), finding("S-1", "SUGGESTION"), finding("S-2", "SUGGESTION"), finding("S-3", "SUGGESTION")], reviewed: "x" };
		const out = compactStructured(many);
		for (let i = 1; i <= 5; i++) assert.match(out, new RegExp(`W-${i} WARNING`));
		assert.ok(!out.includes("W-6") && !out.includes("W-7"), "the sixth and seventh warnings are not listed");
		assert.match(out, /2 more WARNING findings in the full result/);
		assert.ok(!out.includes("S-1"), "suggestions are not listed");
		assert.match(out, /3 SUGGESTION/);
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

describe("compactStructured: status first, blockers never cut (LOOP R3-001, R3-002)", () => {
	const PATH = "/docs/runs/r1/result.json";
	const heavyVerify = () => ({
		verdicts: Array.from({ length: 18 }, (_, i) => ({ spec: `S${i + 1}`, verdict: i < 6 ? "met" : i < 9 ? "unmet" : i < 12 ? "unverified" : "met", evidence: `E${i + 1}-${big(600, "e")}` })),
		blockers: [1, 2, 3].map((n) => ({ summary: `blocker-summary-${n}`, reproduction: `REPRO${n}-${big(3000, "r")}-END${n}`, spec: `S${n}` })),
		advisories: Array.from({ length: 12 }, (_, i) => ({ summary: `advisory ${i} ${big(300, "a")}`, reproduction: big(300, "p") })),
		regressionTests: Array.from({ length: 10 }, (_, i) => ({ path: `tests/regression-${i}.test.ts`, covers: `S${i + 1}` })),
		scratch: ["/tmp/scratch-1"],
		unverified: Array.from({ length: 6 }, (_, i) => `U${i}: ${big(500, "u")}`),
	});

	it("starts with a status line that counts blockers, unmet, and unverified", () => {
		const out = compactStructured(heavyVerify(), COMPACT_MAX_CHARS, PATH);
		assert.match(out.split("\n")[0], /^Status: BLOCKERS \(3\) \| UNMET \(3\) \| UNVERIFIED \(9\)$/);
	});

	it("keeps every blocker and every unmet or unverified verdict when the payload is far over the cap", () => {
		const out = compactStructured(heavyVerify(), COMPACT_MAX_CHARS, PATH);
		for (const n of [1, 2, 3]) assert.ok(out.includes(`blocker-summary-${n}`) && out.includes(`REPRO${n}-`), `blocker ${n}`);
		for (const n of [7, 8, 9, 10, 11, 12]) assert.match(out, new RegExp(`S${n}: (unmet|unverified)`), `verdict S${n}`);
		assert.match(out, /Met \(\d+\): S1, S2, S3, S4, S5, S6, S13/);
		assert.ok(out.indexOf("Status:") < out.indexOf("blocker-summary-1") && out.indexOf("blocker-summary-3") < out.indexOf("S7: "), "status, blockers, then verdicts");
		assert.ok(!out.includes(big(1000, "r")), "a reproduction is capped per item");
	});

	it("truncates only the tail sections, names how many items it left out and the full-result path", () => {
		const out = compactStructured(heavyVerify(), COMPACT_MAX_CHARS, PATH);
		assert.ok(out.length < COMPACT_MAX_CHARS * 2, `length ${out.length}`);
		assert.match(out, /\[… \d+ items? omitted[^\]]*full result: \/docs\/runs\/r1\/result\.json\]/);
	});

	it("never prints `Blockers: none` or `Unverified: none` next to unmet or unverified verdicts", () => {
		const out = compactStructured({ verdicts: [{ spec: "S1", verdict: "unverified", evidence: "no runner" }], blockers: [], advisories: [], regressionTests: [], scratch: [], unverified: [] });
		assert.match(out.split("\n")[0], /^Status: UNVERIFIED \(1\)$/);
		assert.doesNotMatch(out, /Blockers: none|Unverified: none|CLEAN/);
	});

	it("a verify result with only met verdicts is CLEAN and lists the ids", () => {
		const out = compactStructured({ verdicts: [{ spec: "S1", verdict: "met", evidence: "ok" }, { spec: "S2", verdict: "out of scope", evidence: "later" }], blockers: [], advisories: [], regressionTests: [], scratch: [], unverified: [] });
		assert.equal(out.split("\n")[0], "Status: CLEAN");
		assert.match(out, /Met \(1\): S1/);
		assert.match(out, /S2/);
	});

	it("a review with many large findings keeps every BLOCKER and CRITICAL id and a correct status", () => {
		const finding = (id: string, severity: string) => ({ id, severity, location: "lib/a.ts:10", claim: `claim ${id} ${big(1500, "c")}`, evidence: `evidence ${id} ${big(3000, "v")}`, cause: "introduced" });
		const review = {
			findings: [finding("R-001", "BLOCKER"), finding("R-002", "CRITICAL"), finding("R-003", "CRITICAL"), finding("R-004", "WARNING"), finding("R-005", "WARNING"), finding("R-006", "CRITICAL"), finding("R-007", "BLOCKER"), finding("R-008", "SUGGESTION")],
			reviewed: "everything",
		};
		const out = compactStructured(review, COMPACT_MAX_CHARS, PATH);
		assert.match(out.split("\n")[0], /^Status: BLOCKERS \(2\) \| CRITICAL \(3\) \| WARNING \(2\)$/);
		for (const id of ["R-001", "R-002", "R-003", "R-006", "R-007"]) assert.ok(out.includes(id), id);
		assert.ok(!out.includes("R-008"));
		assert.match(out, /everything/);
		assert.ok(!out.includes(big(1500, "v")), "evidence is capped per item");
	});

	it("a review with only suggestions is CLEAN", () => {
		const out = compactStructured({ findings: [{ id: "R-1", severity: "SUGGESTION", location: "a:1", claim: "c", evidence: "e", cause: "introduced" }], reviewed: "x" });
		assert.equal(out.split("\n")[0], "Status: CLEAN");
	});

	it("compactResult passes the full-result path to the omission marker", () => {
		const out = compactResult({ structured: heavyVerify(), artifactsDir: "/docs/runs/r9" });
		assert.match(out, /full result: \/docs\/runs\/r9\/result\.json\]/);
		assert.ok(out.endsWith("Full result: /docs/runs/r9/result.json"));
	});
});

describe("compactResult: a failed run keeps its error first", () => {
	it("an over-cap error text starts with the error line", () => {
		const out = compactResult({ text: `Structured output missing: no tool call\n${big(30_000)}` });
		assert.ok(out.startsWith("Structured output missing"));
	});
});
