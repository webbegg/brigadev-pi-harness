// S7: the DSP audit log and the session counter.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { appendDspAudit, dspAuditFile, dspAuditRecord, dspAutoAllowedCount, dspStatusLine, noteDspAllowed, readDspAudit, resetDspCount } from "../lib/dsp-audit.ts";
import { bashWritesEvidence } from "../lib/guard-rules.ts";
import { realTmp } from "./dsp-fixtures.test.ts";

describe("DSP audit", () => {
	const docs = realTmp("dsp-audit-");
	after(() => rmSync(docs, { recursive: true, force: true }));
	beforeEach(() => resetDspCount());

	it("lives in <repo docs>/audit/dsp.jsonl", () => {
		assert.equal(dspAuditFile(docs), join(docs, "audit", "dsp.jsonl"));
	});

	it("appends one JSON line per command with ts, branch, command preview, kind and backup refs", () => {
		const file = dspAuditFile(docs);
		appendDspAudit(file, dspAuditRecord({ ts: "2026-11-16T10:00:00.000Z", branch: "feat/x", command: "git reset --hard HEAD~1", kind: "destructive", backups: ["refs/brigadev/backup/20261116T100000Z-reset-hard"] }));
		appendDspAudit(file, dspAuditRecord({ ts: "2026-11-16T10:01:00.000Z", branch: "feat/x", command: "npm install", kind: "dependency", backups: [] }));
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		assert.equal(lines.length, 2);
		assert.deepEqual(JSON.parse(lines[0]), {
			v: 1,
			ts: "2026-11-16T10:00:00.000Z",
			branch: "feat/x",
			command: "git reset --hard HEAD~1",
			kind: "destructive",
			backups: ["refs/brigadev/backup/20261116T100000Z-reset-hard"],
		});
		assert.deepEqual(readDspAudit(file).map((record) => record.kind), ["destructive", "dependency"]);
		assert.equal(statSync(file).mode & 0o777, 0o600);
	});

	it("keeps only a bounded preview of a long command", () => {
		const long = Array.from({ length: 40 }, (_, i) => `echo line ${i}`).join("\n");
		const record = dspAuditRecord({ ts: "t", branch: null, command: long, kind: "x", backups: [] });
		assert.ok(record.command.split("\n").length < 10);
		assert.equal(record.branch, null);
	});

	it("a torn line does not hide the rest", () => {
		const file = join(docs, "audit", "torn.jsonl");
		mkdirSync(join(docs, "audit"), { recursive: true });
		writeFileSync(file, `${JSON.stringify(dspAuditRecord({ ts: "a", branch: null, command: "x", kind: "k", backups: [] }))}\n{ torn\n`);
		assert.equal(readDspAudit(file).length, 1);
	});

	it("counts the commands auto-allowed this session", () => {
		assert.equal(dspAutoAllowedCount(), 0);
		assert.equal(dspStatusLine(), "DSP: 0 auto-allowed this session");
		noteDspAllowed();
		noteDspAllowed();
		assert.equal(dspAutoAllowedCount(), 2);
		assert.equal(dspStatusLine(), "DSP: 2 auto-allowed this session");
		resetDspCount();
		assert.equal(dspAutoAllowedCount(), 0);
	});

	it("the LLM cannot write the audit log from a shell (same textual protection as evidence/)", () => {
		const dir = join(docs, "audit");
		const home = join(docs, "nohome");
		assert.equal(bashWritesEvidence(`echo '{}' >> ${dspAuditFile(docs)}`, [dir], home), true);
		assert.equal(bashWritesEvidence(`rm ${dspAuditFile(docs)}`, [dir], home), true);
		assert.equal(bashWritesEvidence(`cat ${dspAuditFile(docs)}`, [dir], home), false);
	});
});
