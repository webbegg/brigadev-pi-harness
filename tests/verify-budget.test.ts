import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseRecheck, riskCategories, verifyBudget } from "../lib/delegation.ts";
import type { EvidenceRecord, VerifyRecord } from "../lib/evidence.ts";

const verifyRecord = (over: Partial<VerifyRecord> = {}): VerifyRecord => ({
	v: 1,
	type: "verify",
	ts: "2026-11-19T10:00:00.000Z",
	branch: "feat/x",
	tree: "t1",
	srcTree: "s1",
	root: "/repo",
	runId: "run-1",
	scope: "branch",
	categories: ["security"],
	blockers: [],
	outcome: "clean",
	...over,
});
const branchRequest = (reason = "Risk: security (guard)") => ({ reason, branch: "feat/x" });

describe("parseRecheck", () => {
	it("reads the blocker ids after `recheck`, case-insensitively", () => {
		assert.deepEqual(parseRecheck("Risk: security (x); recheck B1,B2"), ["B1", "B2"]);
		assert.deepEqual(parseRecheck("RECHECK b3 , b4 Risk: data"), ["B3", "B4"]);
		assert.deepEqual(parseRecheck("recheck B1"), ["B1"]);
	});
	it("is undefined for a reason that does not name ids", () => {
		assert.equal(parseRecheck("Risk: security (x)"), undefined);
		assert.equal(parseRecheck("recheck everything"), undefined);
		assert.equal(parseRecheck("rechecked B1"), undefined);
	});
});

describe("riskCategories", () => {
	it("lists the named categories in order, lowercased, without duplicates", () => {
		assert.deepEqual(riskCategories("Risk: Security (a); Risk: data (b); risk: security"), ["security", "data"]);
		assert.deepEqual(riskCategories("Risk: item 2 (x)"), []);
		assert.deepEqual(riskCategories("no risk: security"), []);
	});
});

describe("verifyBudget: branch verify", () => {
	it("admits the first branch verify", () => {
		assert.deepEqual(verifyBudget([], branchRequest(), "s1"), { ok: true });
	});

	it("rejects a second branch verify on the same srcTree and says what to do instead", () => {
		const result = verifyBudget([verifyRecord()], branchRequest(), "s1");
		assert.equal(result.ok, false);
		assert.ok(!result.ok && !result.ask);
		assert.match((result as { message: string }).message, /already verified this source tree/);
		assert.match((result as { message: string }).message, /repro test RED→GREEN/);
	});

	it("asks on a new srcTree after an earlier branch verify", () => {
		const result = verifyBudget([verifyRecord()], branchRequest(), "s2");
		assert.equal(result.ok, false);
		assert.equal(!result.ok && result.ask, true);
		assert.match((result as { message: string }).message, /another branch verify/);
	});

	it("asks when the current srcTree is unknown but a branch verify exists", () => {
		const result = verifyBudget([verifyRecord()], branchRequest(), undefined);
		assert.equal(!result.ok && result.ask, true);
	});

	it("ignores other branches, rechecks, and failed runs", () => {
		const records: EvidenceRecord[] = [
			verifyRecord({ branch: "other", srcTree: "s1" }),
			verifyRecord({ scope: "recheck", srcTree: "s1" }),
			verifyRecord({ outcome: "failed", srcTree: "s1" }),
		];
		assert.deepEqual(verifyBudget(records, branchRequest(), "s1"), { ok: true });
	});

	it("counts a verify that ended with blockers or unverified checks", () => {
		for (const outcome of ["blockers", "unverified"] as const) {
			const result = verifyBudget([verifyRecord({ outcome, blockers: outcome === "blockers" ? ["B1"] : [] })], branchRequest(), "s1");
			assert.equal(result.ok, false, outcome);
		}
	});
});

describe("verifyBudget: recheck", () => {
	const blocked = verifyRecord({ outcome: "blockers", blockers: ["B1", "B2"] });
	const recheck = (reason = "Risk: security (fix); recheck B1,B2") => ({ reason, branch: "feat/x" });

	it("admits one recheck of the last verify's blockers for security or data", () => {
		assert.deepEqual(verifyBudget([blocked], recheck(), "s2"), { ok: true });
		assert.deepEqual(verifyBudget([blocked], recheck("Risk: data (fix); recheck B2"), "s2"), { ok: true });
		assert.deepEqual(verifyBudget([blocked], recheck("risk: SECURITY (fix); RECHECK b1"), "s2"), { ok: true });
	});

	it("rejects a recheck with no earlier branch verify on this branch", () => {
		for (const records of [[], [verifyRecord({ branch: "other", outcome: "blockers", blockers: ["B1"] })]]) {
			const result = verifyBudget(records, recheck(), "s2");
			assert.equal(result.ok, false);
			assert.match((result as { message: string }).message, /no earlier branch verify/);
		}
	});

	it("rejects a second recheck after the same branch verify", () => {
		const records = [blocked, verifyRecord({ scope: "recheck", ts: "2026-11-19T11:00:00.000Z" })];
		const result = verifyBudget(records, recheck(), "s3");
		assert.equal(result.ok, false);
		assert.ok(!result.ok && !result.ask);
		assert.match((result as { message: string }).message, /one recheck per branch verify/);
		assert.match((result as { message: string }).message, /repro test RED→GREEN/);
	});

	it("allows a recheck after a newer branch verify even when an older one was rechecked", () => {
		const records = [blocked, verifyRecord({ scope: "recheck" }), verifyRecord({ outcome: "blockers", blockers: ["B1"], srcTree: "s9" })];
		assert.deepEqual(verifyBudget(records, recheck("Risk: security (x); recheck B1"), "s10"), { ok: true });
	});

	it("rejects ids that are not all blockers of the last branch verify", () => {
		for (const reason of ["Risk: security (x); recheck B3", "Risk: security (x); recheck B1,B3"]) {
			const result = verifyBudget([blocked], recheck(reason), "s2");
			assert.equal(result.ok, false, reason);
			assert.match((result as { message: string }).message, /blockers of the last branch verify: B1, B2/);
		}
		const none = verifyBudget([verifyRecord()], recheck("Risk: security (x); recheck B1"), "s2");
		assert.match((none as { message: string }).message, /reported no blockers/);
	});

	it("rejects a category other than security or data", () => {
		for (const reason of ["Risk: contract (x); recheck B1", "Risk: item 2 (x); recheck B1", "recheck B1"]) {
			const result = verifyBudget([blocked], recheck(reason), "s2");
			assert.equal(result.ok, false, reason);
			assert.match((result as { message: string }).message, /security or data/);
		}
	});

	it("does not count a failed recheck, and never asks", () => {
		const records = [blocked, verifyRecord({ scope: "recheck", outcome: "failed" })];
		assert.deepEqual(verifyBudget(records, recheck(), "s2"), { ok: true });
	});

	it("does not depend on the tree the recheck runs on", () => {
		assert.deepEqual(verifyBudget([blocked], recheck(), undefined), { ok: true });
		assert.deepEqual(verifyBudget([blocked], recheck(), "s1"), { ok: true });
	});
});
