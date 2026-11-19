// The PR risk gate (S9): pure decision on the branch tier and its evidence.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EvidenceRecord, RunRecord, VerifyRecord } from "../lib/evidence.ts";
import { decidePrGate, prCreateDirectory } from "../lib/pr-gate.ts";

const BRANCH = "feat/x";
const T2 = { security: ["lib/guard-rules.ts"] };

const verify = (ts: string, outcome: VerifyRecord["outcome"], blockers: string[] = [], extra: Partial<VerifyRecord> = {}): VerifyRecord => ({ v: 1, type: "verify", ts, branch: BRANCH, scope: "branch", categories: [], blockers, outcome, ...extra });
const run = (ts: string, outcome: RunRecord["outcome"], extra: Partial<RunRecord> = {}): RunRecord => ({ v: 1, type: "run", ts, branch: BRANCH, cwd: "/r", agent: "parent", command: "npm test", kind: "test", outcome, tail: "", ...extra });

function decide(tier: "T0" | "T1" | "T2", records: EvidenceRecord[], options: { ledgerExists?: boolean; categories?: Record<string, string[]> } = {}) {
	return decidePrGate({ tier, categories: options.categories ?? (tier === "T2" ? T2 : {}), records, branch: BRANCH, ledgerExists: options.ledgerExists ?? true });
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

	it("an unverified (non-failed) verify counts as a verify run", () => {
		assert.equal(decide("T2", [verify("2026-01-01T00:00:00Z", "unverified")]).action, "allow");
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

		it("a later clean recheck resolves them", () => {
			assert.equal(decide("T2", [blockers, verify("2026-01-01T00:05:00Z", "clean", [], { scope: "recheck" })]).action, "allow");
		});

		it("a later recheck with blockers asks again, judged from its own time", () => {
			const recheck = verify("2026-01-01T00:05:00Z", "blockers", ["B1"], { scope: "recheck" });
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

describe("prCreateDirectory", () => {
	it("is the session directory for a plain gh pr create", () => {
		assert.equal(prCreateDirectory("gh pr create --fill", "/r"), "/r");
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
