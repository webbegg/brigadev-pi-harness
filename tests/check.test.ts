// S13: lib/check.ts: command detection, count parsing, and result shaping for the `check` tool.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { configuredTestCommand, detectTestCommand, evidenceOutcome, formatCounts, parseCounts, resolveCommand, shapeResult, withFocus } from "../lib/check.ts";

const root = mkdtempSync(join(tmpdir(), "check-lib-"));
after(() => rmSync(root, { recursive: true, force: true }));

const project = (name: string, files: Record<string, string>): string => {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	for (const [file, content] of Object.entries(files)) writeFileSync(join(dir, file), content);
	return dir;
};

describe("detectTestCommand", () => {
	it("uses `npm test` when package.json has a test script", () => {
		assert.deepEqual(detectTestCommand(project("npm", { "package.json": JSON.stringify({ scripts: { test: "node --test" } }) })), { command: "npm test" });
	});

	it("ignores the npm init placeholder test script and a package.json without scripts", () => {
		const placeholder = { scripts: { test: 'echo "Error: no test specified" && exit 1' } };
		assert.ok("error" in detectTestCommand(project("npm-placeholder", { "package.json": JSON.stringify(placeholder) })));
		assert.ok("error" in detectTestCommand(project("npm-bare", { "package.json": "{}" })));
		assert.ok("error" in detectTestCommand(project("npm-broken", { "package.json": "{not json" })));
	});

	it("falls through to pytest, cargo, and go", () => {
		assert.deepEqual(detectTestCommand(project("py", { "pyproject.toml": "[project]\n" })), { command: "pytest -q" });
		assert.deepEqual(detectTestCommand(project("py-ini", { "pytest.ini": "[pytest]\n" })), { command: "pytest -q" });
		assert.deepEqual(detectTestCommand(project("rs", { "Cargo.toml": "[package]\n" })), { command: "cargo test" });
		assert.deepEqual(detectTestCommand(project("go", { "go.mod": "module x\n" })), { command: "go test ./..." });
	});

	it("prefers package.json over the other markers", () => {
		const dir = project("both", { "package.json": JSON.stringify({ scripts: { test: "x" } }), "Cargo.toml": "" });
		assert.deepEqual(detectTestCommand(dir), { command: "npm test" });
	});

	it("asks for `command` when nothing is detected", () => {
		const result = detectTestCommand(project("empty", {}));
		assert.ok("error" in result);
		assert.match(result.error, /`command`/);
	});
});

describe("configuredTestCommand", () => {
	it("reads check.test from the settings and ignores anything else", () => {
		assert.equal(configuredTestCommand({ check: { test: " make test " } }), "make test");
		assert.equal(configuredTestCommand({}), undefined);
		assert.equal(configuredTestCommand({ check: {} }), undefined);
		assert.equal(configuredTestCommand({ check: { test: 5 } }), undefined);
		assert.equal(configuredTestCommand({ check: { test: "  " } }), undefined);
		assert.equal(configuredTestCommand(undefined), undefined);
	});
});

describe("resolveCommand", () => {
	const dir = project("resolve", { "package.json": JSON.stringify({ scripts: { test: "x" } }) });

	it("prefers the given command, then the configured one, then detection", () => {
		assert.deepEqual(resolveCommand({ command: "pytest -x", cwd: dir, settings: { check: { test: "make test" } } }), { command: "pytest -x" });
		assert.deepEqual(resolveCommand({ cwd: dir, settings: { check: { test: "make test" } } }), { command: "make test" });
		assert.deepEqual(resolveCommand({ cwd: dir, settings: {} }), { command: "npm test" });
		assert.deepEqual(resolveCommand({ command: "  ", cwd: dir, settings: {} }), { command: "npm test" });
	});

	it("appends the focus after the command", () => {
		assert.deepEqual(resolveCommand({ cwd: dir, settings: {}, focus: "tests/a.test.ts" }), { command: "npm test tests/a.test.ts" });
	});

	it("passes the detection error through", () => {
		assert.ok("error" in resolveCommand({ cwd: project("resolve-empty", {}), settings: {} }));
	});
});

describe("withFocus", () => {
	it("appends plain paths as they are and quotes anything the shell would interpret", () => {
		assert.equal(withFocus("npm test", "tests/a.test.ts"), "npm test tests/a.test.ts");
		assert.equal(withFocus("npm test", "my tests/a b.ts"), "npm test 'my tests/a b.ts'");
		assert.equal(withFocus("npm test", "a;rm -rf x"), "npm test 'a;rm -rf x'");
		assert.equal(withFocus("npm test", "it's"), `npm test 'it'\\''s'`);
		assert.equal(withFocus("npm test", "  "), "npm test");
		assert.equal(withFocus("npm test", undefined), "npm test");
	});
});

describe("parseCounts", () => {
	it("reads node --test", () => {
		const out = "ℹ tests 7\nℹ suites 2\nℹ pass 5\nℹ fail 1\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\nℹ duration_ms 120.5";
		assert.deepEqual(parseCounts(out), { pass: 5, fail: 1, skipped: 1 });
	});

	it("reads jest and vitest", () => {
		assert.deepEqual(parseCounts("Test Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 4 passed, 5 total\nSnapshots:   0 total"), { pass: 4, fail: 1 });
		assert.deepEqual(parseCounts(" Test Files  1 passed (1)\n      Tests  2 failed | 3 passed | 1 skipped (6)\n   Duration  1s"), { pass: 3, fail: 2, skipped: 1 });
	});

	it("reads pytest, with and without the banner", () => {
		assert.deepEqual(parseCounts("===== 1 failed, 4 passed, 2 skipped in 0.12s ====="), { pass: 4, fail: 1, skipped: 2 });
		assert.deepEqual(parseCounts("..F\n1 failed, 2 passed in 0.03s"), { pass: 2, fail: 1 });
		assert.deepEqual(parseCounts("12 passed in 1.00s"), { pass: 12, fail: 0 });
		assert.deepEqual(parseCounts("1 failed, 1 error in 0.1s"), { pass: 0, fail: 2 });
	});

	it("sums cargo test results across targets", () => {
		const out = "test result: ok. 3 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s\ntest result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s";
		assert.deepEqual(parseCounts(out), { pass: 5, fail: 1, skipped: 1 });
	});

	it("counts go packages", () => {
		const out = "ok  \texample.com/a\t0.012s\nFAIL\texample.com/b\t0.003s\nok  \texample.com/c\t(cached)\nFAIL";
		assert.deepEqual(parseCounts(out), { pass: 2, fail: 1, unit: "packages" });
	});

	it("ignores colors and finds nothing in unrelated output", () => {
		assert.deepEqual(parseCounts("\u001b[32mℹ pass 2\u001b[0m\nℹ fail 0"), { pass: 2, fail: 0 });
		assert.equal(parseCounts("hello\nworld"), undefined);
		assert.equal(parseCounts(""), undefined);
	});
});

describe("formatCounts", () => {
	it("lists passed, failed, and skipped", () => {
		assert.equal(formatCounts({ pass: 5, fail: 1, skipped: 2 }), "5 passed, 1 failed, 2 skipped");
		assert.equal(formatCounts({ pass: 5, fail: 0 }), "5 passed, 0 failed");
		assert.equal(formatCounts({ pass: 2, fail: 1, unit: "packages" }), "2 packages ok, 1 failed");
	});
});

describe("shapeResult", () => {
	const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");
	const base = { command: "npm test", exitCode: 0, durationMs: 1234, outputFile: "/tmp/x/output.log" };

	it("starts with PASS, the exit code, the duration, and the command", () => {
		const text = shapeResult({ ...base, output: "ℹ pass 3\nℹ fail 0" });
		assert.equal(text.split("\n")[0], "PASS exit=0 1.2s: npm test");
		assert.match(text, /3 passed, 0 failed/);
		assert.match(text, /full output: \/tmp\/x\/output\.log/);
	});

	it("shows only the counts on a pass whose counts were read", () => {
		const text = shapeResult({ ...base, output: `${lines(30)}\nℹ pass 3\nℹ fail 0` });
		assert.doesNotMatch(text, /line 30/);
	});

	it("shows at most the last 10 lines on a pass without counts", () => {
		const text = shapeResult({ ...base, output: lines(50) });
		assert.match(text, /line 50/);
		assert.match(text, /line 41/);
		assert.doesNotMatch(text, /line 40\b/);
	});

	it("shows the last 60 lines on a failure, with the counts", () => {
		const text = shapeResult({ ...base, exitCode: 1, output: `${lines(200)}\nℹ pass 3\nℹ fail 2` });
		assert.equal(text.split("\n")[0], "FAIL exit=1 1.2s: npm test");
		assert.match(text, /3 passed, 2 failed/);
		assert.match(text, /line 200/);
		assert.match(text, /line 143/);
		assert.doesNotMatch(text, /line 142\b/);
	});

	it("bounds long lines and the whole tail", () => {
		const text = shapeResult({ ...base, exitCode: 1, output: `${"x".repeat(5000)}\n`.repeat(100) });
		assert.ok(text.length < 10_000, `${text.length}`);
	});

	it("says what happened on a timeout, an abort, or a missing exit code", () => {
		assert.equal(shapeResult({ ...base, exitCode: undefined, timedOut: true, output: "" }).split("\n")[0], "FAIL exit=timeout 1.2s: npm test");
		assert.equal(shapeResult({ ...base, exitCode: undefined, aborted: true, output: "" }).split("\n")[0], "FAIL exit=aborted 1.2s: npm test");
		assert.equal(shapeResult({ ...base, exitCode: undefined, output: "" }).split("\n")[0], "FAIL exit=none 1.2s: npm test");
	});

	it("handles empty output", () => {
		assert.doesNotThrow(() => shapeResult({ ...base, output: "" }));
	});
});

describe("evidenceOutcome", () => {
	it("is the real exit code for a plain command", () => {
		assert.equal(evidenceOutcome("npm test", 0), "pass");
		assert.equal(evidenceOutcome("npm test", 2), "fail");
		assert.equal(evidenceOutcome("make verify", 0), "pass");
		assert.equal(evidenceOutcome("make verify && node --test", 1), "fail");
		assert.equal(evidenceOutcome("node --test | tail -20", 0), "pass");
	});

	it("is unknown without an exit code or when the code is not the runner's", () => {
		assert.equal(evidenceOutcome("npm test", undefined), "unknown");
		assert.equal(evidenceOutcome("npm test; echo done", 0), "unknown");
		assert.equal(evidenceOutcome("npm test || true", 0), "unknown");
		assert.equal(evidenceOutcome("npm test &", 0), "unknown");
		assert.equal(evidenceOutcome("npm test\necho done", 0), "unknown");
		assert.equal(evidenceOutcome("echo $(npm test)", 0), "unknown");
	});

	it("is unknown for a run that lists tests or prints help instead of running them", () => {
		assert.equal(evidenceOutcome("npm test -- --help", 0), "unknown");
		assert.equal(evidenceOutcome("pytest --collect-only", 0), "unknown");
	});
});
