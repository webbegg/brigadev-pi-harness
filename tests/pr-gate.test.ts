// The PR risk gate (S9): pure decision on the branch tier and its evidence.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceRecord, RunRecord, VerifyRecord } from "../lib/evidence.ts";
import { decidePrGate, NO_HEAD_TEST_REASON, opensPrCreate, prCreateDirectory, prGateBlockMessage, type PrGateInput, UNRESOLVED_DIRECTORY_REASON } from "../lib/pr-gate.ts";

const BRANCH = "feat/x";
const T2 = { security: ["lib/guard-rules.ts"] };

const verify = (ts: string, outcome: VerifyRecord["outcome"], blockers: string[] = [], extra: Partial<VerifyRecord> = {}): VerifyRecord => ({ v: 1, type: "verify", ts, branch: BRANCH, scope: "branch", categories: [], blockers, outcome, ...extra });
const run = (ts: string, outcome: RunRecord["outcome"], extra: Partial<RunRecord> = {}): RunRecord => ({ v: 1, type: "run", ts, branch: BRANCH, cwd: "/r", agent: "parent", command: "npm test", kind: "test", outcome, tail: "", ...extra });

function decide(tier: "T0" | "T1" | "T2", records: EvidenceRecord[], options: { ledgerExists?: boolean; categories?: Record<string, string[]>; baseUnknown?: boolean } = {}) {
	return decidePrGate({ tier, categories: options.categories ?? (tier === "T2" ? T2 : {}), records, branch: BRANCH, ledgerExists: options.ledgerExists ?? true, baseUnknown: options.baseUnknown });
}

describe("decidePrGate", () => {
	it("T0 allows, with or without anything recorded", () => {
		assert.deepEqual(decide("T0", [], { ledgerExists: false }), { action: "allow", reasons: [] });
	});

	it("T2 without a verify asks and names the category and path", () => {
		assert.deepEqual(decide("T2", []), { action: "ask", reasons: ["T2 branch (security: lib/guard-rules.ts) has no brigadev-verify run"] });
	});

	it("T2 names only the categories that make it T2", () => {
		const result = decide("T2", [], { categories: { delivery: ["package.json"], data: ["lib/store.ts", "lib/b.ts"], contract: ["bin/x"] } });
		assert.deepEqual(result.reasons, ["T2 branch (data: lib/store.ts, contract: bin/x) has no brigadev-verify run"]);
	});

	it("T2 ignores a failed verify and a verify of another branch", () => {
		const records = [verify("2026-01-01T00:00:00Z", "failed"), verify("2026-01-01T00:00:01Z", "clean", [], { branch: "other" })];
		assert.equal(decide("T2", records).action, "ask");
	});

	it("T2 with a clean verify allows", () => {
		assert.deepEqual(decide("T2", [verify("2026-01-01T00:00:00Z", "clean")]), { action: "allow", reasons: [] });
	});

	it("W2: at T2 a verify counts only with a definite result; an unverified-only history asks", () => {
		assert.deepEqual(decide("T2", [verify("2026-01-01T00:00:00Z", "unverified")]), { action: "ask", reasons: ["latest brigadev-verify was unverified"] });
		assert.deepEqual(decide("T2", [verify("2026-01-01T00:00:00Z", "unverified"), verify("2026-01-01T00:01:00Z", "unverified", [], { scope: "recheck" })]).reasons, ["latest brigadev-verify was unverified"]);
		assert.equal(decide("T2", [verify("2026-01-01T00:00:00Z", "clean"), verify("2026-01-01T00:01:00Z", "unverified")]).action, "allow", "an unverified later run does not undo a definite one");
		assert.equal(decide("T1", [verify("2026-01-01T00:00:00Z", "unverified")]).action, "allow", "T1 never needed a verify");
	});

	describe("verify blockers", () => {
		const blockers = verify("2026-01-01T00:00:00Z", "blockers", ["B1", "B2"]);

		it("ask when no repro test follows", () => {
			assert.deepEqual(decide("T2", [blockers]), { action: "ask", reasons: ["verify blockers B1,B2 have no repro test RED→GREEN after the verify"] });
		});

		it("a pass alone does not resolve them", () => {
			assert.equal(decide("T2", [blockers, run("2026-01-01T00:01:00Z", "pass")]).action, "ask");
		});

		it("a fail alone does not resolve them", () => {
			assert.equal(decide("T2", [blockers, run("2026-01-01T00:01:00Z", "fail")]).action, "ask");
		});

		it("a pass then a fail does not resolve them", () => {
			assert.equal(decide("T2", [blockers, run("2026-01-01T00:01:00Z", "pass"), run("2026-01-01T00:02:00Z", "fail")]).action, "ask");
		});

		it("a fail then a pass after the verify resolves them", () => {
			assert.deepEqual(decide("T2", [blockers, run("2026-01-01T00:01:00Z", "fail"), run("2026-01-01T00:02:00Z", "pass")]), { action: "allow", reasons: [] });
		});

		it("a fail→pass before the verify does not resolve them", () => {
			assert.equal(decide("T2", [run("2025-12-31T00:00:00Z", "fail"), run("2025-12-31T00:01:00Z", "pass"), blockers]).action, "ask");
		});

		it("only test runs of this branch count", () => {
			const records = [blockers, run("2026-01-01T00:01:00Z", "fail", { kind: "check" }), run("2026-01-01T00:02:00Z", "pass", { kind: "check" }), run("2026-01-01T00:03:00Z", "fail", { branch: "other" }), run("2026-01-01T00:04:00Z", "pass", { branch: "other" })];
			assert.equal(decide("T2", records).action, "ask");
		});

		it("a later clean recheck resolves the ids it rechecked", () => {
			assert.equal(decide("T2", [blockers, verify("2026-01-01T00:05:00Z", "clean", [], { scope: "recheck", rechecked: ["B1", "B2"] })]).action, "allow");
		});

		it("W1: a clean recheck of some ids leaves the others needing a RED→GREEN test run after the verify", () => {
			const recheck = verify("2026-01-01T00:05:00Z", "clean", [], { scope: "recheck", rechecked: ["B1"] });
			assert.deepEqual(decide("T2", [blockers, recheck]), { action: "ask", reasons: ["verify blockers B2 have no repro test RED→GREEN after the verify"] });
			const redGreen = [run("2026-01-01T00:01:00Z", "fail"), run("2026-01-01T00:02:00Z", "pass")];
			assert.equal(decide("T2", [blockers, ...redGreen, recheck]).action, "allow");
			assert.equal(decide("T2", [blockers, run("2026-01-01T00:01:00Z", "fail"), recheck]).action, "ask");
		});

		it("W1: a clean recheck that names no ids (or a record without them) resolves nothing", () => {
			assert.deepEqual(decide("T2", [blockers, verify("2026-01-01T00:05:00Z", "clean", [], { scope: "recheck" })]).reasons, ["verify blockers B1,B2 have no repro test RED→GREEN after the verify"]);
		});

		it("a later recheck with blockers asks again, judged from its own time", () => {
			const recheck = verify("2026-01-01T00:05:00Z", "blockers", ["B1"], { scope: "recheck", rechecked: ["B1", "B2"] });
			const redGreen = [run("2026-01-01T00:01:00Z", "fail"), run("2026-01-01T00:02:00Z", "pass")];
			assert.deepEqual(decide("T2", [blockers, ...redGreen, recheck]).reasons, ["verify blockers B1 have no repro test RED→GREEN after the verify"]);
			assert.equal(decide("T2", [blockers, ...redGreen, recheck, run("2026-01-01T00:06:00Z", "fail"), run("2026-01-01T00:07:00Z", "pass")]).action, "allow");
		});

		it("a failed later verify does not hide the blockers", () => {
			assert.equal(decide("T2", [blockers, verify("2026-01-01T00:05:00Z", "failed", [], { scope: "recheck" })]).action, "ask");
		});

		it("a later unverified verify does not hide the blockers", () => {
			assert.deepEqual(decide("T2", [blockers, verify("2026-01-01T00:05:00Z", "unverified", [], { scope: "recheck" })]).reasons, ["verify blockers B1,B2 have no repro test RED→GREEN after the verify"]);
		});

		it("applies to T1 too", () => {
			assert.equal(decide("T1", [blockers]).action, "ask");
		});

		it("not to T0", () => {
			assert.equal(decide("T0", [blockers]).action, "allow");
		});

		it("T2 without a verify reports only the missing verify", () => {
			assert.equal(decide("T2", []).reasons.length, 1);
		});
	});

	describe("unknown base branch (W3)", () => {
		const reason = "risk tier unknown: no base branch found";
		it("asks at any tier below T2 instead of skipping", () => {
			for (const tier of ["T0", "T1"] as const) assert.deepEqual(decide(tier, [], { baseUnknown: true, ledgerExists: true }), { action: "ask", reasons: [reason] }, tier);
		});
		it("keeps the T2 reasons, without the unknown-tier one (T2 is the highest tier already)", () => {
			assert.deepEqual(decide("T2", [], { baseUnknown: true }).reasons, ["T2 branch (security: lib/guard-rules.ts) has no brigadev-verify run"]);
			assert.equal(decide("T2", [verify("2026-01-01T00:00:00Z", "clean")], { baseUnknown: true }).action, "allow");
		});
		it("the block message says how to clear it", () => {
			assert.match(prGateBlockMessage(decide("T0", [], { baseUnknown: true }), []), /base branch/);
		});
	});

	describe("review ledger", () => {
		it("T1 without a ledger allows with a note", () => {
			assert.deepEqual(decide("T1", [], { ledgerExists: false }), { action: "allow", reasons: [], note: "no review ledger for this branch" });
		});

		it("T1 with a ledger allows with no note", () => {
			assert.deepEqual(decide("T1", [], { ledgerExists: true }), { action: "allow", reasons: [] });
		});

		it("T2 does not add the note", () => {
			assert.equal(decide("T2", [verify("2026-01-01T00:00:00Z", "clean")], { ledgerExists: false }).note, undefined);
		});
	});
});

describe("decidePrGate: a passing test on the committed HEAD (the evidence check moved from commit to PR)", () => {
	const HEAD = { tree: "H", sourceTree: "HS", root: "/r" };
	const withHead = (tier: "T0" | "T1" | "T2", records: EvidenceRecord[], extra: Partial<PrGateInput> = {}) =>
		decidePrGate({ tier, categories: tier === "T2" ? T2 : {}, records, branch: BRANCH, ledgerExists: true, sourceChanged: true, head: HEAD, ...extra });
	const clean = verify("2026-01-01T00:00:00Z", "clean");

	it("asks at every tier when no passing test is recorded for HEAD's tree", () => {
		for (const tier of ["T0", "T1"] as const) assert.deepEqual(withHead(tier, []), { action: "ask", reasons: [`${NO_HEAD_TEST_REASON} (no test ran on it)`] }, tier);
		assert.deepEqual(withHead("T2", [clean]).reasons, [`${NO_HEAD_TEST_REASON} (no test ran on it)`]);
	});

	it("a passing test on HEAD's tree, or on its source tree (docs edited after), allows", () => {
		assert.deepEqual(withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "H", root: "/r" })]), { action: "allow", reasons: [] });
		assert.equal(withHead("T1", [run("2026-01-01T00:01:00Z", "pass", { tree: "OTHER", srcTree: "HS" })]).action, "allow");
	});

	it("a pass on another tree, another repository, or of another kind does not count", () => {
		assert.equal(withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "OLD", srcTree: "OLDS" })]).action, "ask");
		assert.equal(withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "H", root: "/other" })]).action, "ask");
		assert.equal(withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "H", kind: "check" })]).action, "ask");
	});

	it("names the last run on HEAD's tree when it failed or had no trustworthy exit code", () => {
		assert.deepEqual(withHead("T0", [run("2026-01-01T00:01:00Z", "fail", { tree: "H", exitCode: 1 })]).reasons, [`${NO_HEAD_TEST_REASON} (the last run failed: \`npm test\`, exit 1)`]);
		assert.deepEqual(withHead("T0", [run("2026-01-01T00:01:00Z", "unknown", { tree: "H", command: "npm test || true" })]).reasons, [`${NO_HEAD_TEST_REASON} (the last run has no trustworthy exit code: \`npm test || true\`)`]);
	});

	it("with a known suite command only a full-suite run counts, not a focused one", () => {
		const suite = { suiteCommand: "npm test" };
		assert.equal(withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "H" })], suite).action, "allow");
		const focused = withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "H", command: "npm test -- tests/a.test.ts" })], suite);
		assert.deepEqual(focused.reasons, [`${NO_HEAD_TEST_REASON} (only other test commands passed on it; the full suite is \`npm test\`)`]);
		assert.equal(withHead("T0", [run("2026-01-01T00:01:00Z", "pass", { tree: "H", command: "  npm test " })], suite).action, "allow", "whitespace around the command does not matter");
	});

	it("the latest run of the suite on HEAD's tree decides: a later failure revokes an earlier pass", () => {
		const passThenFail = [run("2026-01-01T00:01:00Z", "pass", { tree: "H" }), run("2026-01-01T00:02:00Z", "fail", { tree: "H", exitCode: 1 })];
		assert.deepEqual(withHead("T0", passThenFail).reasons, [`${NO_HEAD_TEST_REASON} (the last run failed: \`npm test\`, exit 1)`]);
		assert.equal(withHead("T0", [...passThenFail, run("2026-01-01T00:03:00Z", "pass", { tree: "H" })]).action, "allow", "a pass after it counts again");
		const suite = { suiteCommand: "npm test" };
		const focusedFailAfter = [run("2026-01-01T00:01:00Z", "pass", { tree: "H" }), run("2026-01-01T00:02:00Z", "fail", { tree: "H", command: "npm test -- a.test.ts" })];
		assert.equal(withHead("T0", focusedFailAfter, suite).action, "allow", "with a known suite only suite runs are compared");
	});

	it("the block message for a git error says retry once", () => {
		const message = prGateBlockMessage(withHead("T0", [], { head: { error: "git failed" } }), []);
		assert.doesNotMatch(message, /retry; then retry/);
	});

	it("a branch that commits only docs needs no test", () => {
		assert.deepEqual(withHead("T0", [], { sourceChanged: false }), { action: "allow", reasons: [] });
	});

	it("asks, naming the reason, when HEAD's tree could not be computed", () => {
		assert.deepEqual(withHead("T0", [], { head: { error: "git failed" } }).reasons, ["test evidence unknown: HEAD's tree could not be computed (git failed)"]);
	});

	it("without head facts (an older caller) nothing about tests is decided", () => {
		assert.deepEqual(withHead("T0", [], { head: undefined }), { action: "allow", reasons: [] });
	});

	it("the block message tells the agent to test the committed tree", () => {
		const message = prGateBlockMessage(withHead("T0", []), []);
		assert.match(message, /commit .*then run the tests with `check` on the clean working tree/);
		assert.match(prGateBlockMessage(withHead("T0", [], { head: { error: "git failed" } }), []), /fix the git problem/);
	});
});

describe("prCreateDirectory", () => {
	it("is the session directory for a plain gh pr create", () => {
		assert.equal(prCreateDirectory("gh pr create --fill", "/r"), "/r");
	});

	it("knows `gh pr new`, gh's alias of `gh pr create`", () => {
		assert.equal(prCreateDirectory("gh pr new --fill", "/r"), "/r");
	});

	it("knows gh's --repo flag before the action", () => {
		for (const command of ["gh pr --repo o/r create --fill", "gh pr -R o/r new", "gh pr --repo=o/r create", "gh pr -Ro/r create"]) {
			assert.equal(prCreateDirectory(command, "/r"), "/r", command);
			assert.equal(opensPrCreate(command), true, command);
		}
	});

	it("follows a leading cd", () => {
		assert.equal(prCreateDirectory("cd sub && gh pr create", "/r"), "/r/sub");
	});

	it("is the directory of the gh pr create segment after a push", () => {
		assert.equal(prCreateDirectory("git push -u origin x && gh pr create --fill", "/r"), "/r");
	});

	it("is undefined when the command opens no PR", () => {
		assert.equal(prCreateDirectory("gh pr view", "/r"), undefined);
		assert.equal(prCreateDirectory("echo gh pr create", "/r"), undefined);
	});

	it("is undefined when the directory cannot be resolved", () => {
		assert.equal(prCreateDirectory("cd $X && gh pr create", "/r"), undefined);
	});
});

describe("opensPrCreate (W4)", () => {
	it("is true for every shape the classifier reads as gh pr create, resolvable or not", () => {
		for (const command of ["gh pr create --fill", "gh pr new --fill", "cd sub && gh pr create", "(cd . && gh pr create --fill)", "cd x; gh pr create", 'cd "$PWD" && gh pr create', "bash -c 'gh pr create --fill'", "eval 'gh pr create'"]) assert.equal(opensPrCreate(command), true, command);
	});
	it("is false for the rest", () => {
		for (const command of ["gh pr view", "echo gh pr create", "git push"]) assert.equal(opensPrCreate(command), false, command);
	});
	it("the unresolved-directory reason names the gate", () => {
		assert.equal(UNRESOLVED_DIRECTORY_REASON, "PR risk gate could not resolve the directory of gh pr create");
	});
});
