import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { appendLogLine, changedSpecs, ownedLineConflicts, parseTicketList, readyTickets, setTicketStatus, ticketsLinkedTo, validateForRun, writeFileAtomic } from "../lib/ticket-list.ts";

const DOC = `# Feature
Objective: x. Branch: \`feat/x\`. Delivery: one PR. Tests: \`npm test\`.

## Specs
- S1: Parse the list. Check: parser tests.
- S2: Pick ready tickets. Check: loop tests.

## Tasks
- T1 [S1] inline: parser deps: none done: \`npm test -- tests/a.test.ts\` — done abc123 (RED→GREEN)
- T2 [S2] inline: loop — Risk: contract — careful deps: T1 done: \`npm test -- tests/b.test.ts\` — pending
- T3 [S1,S2] delegated (parallel writers): board deps: T1, T2 done: the board shows ticket cards — pending
- Follow-up (not in the prototype): parallel tickets.

## Log
- L1 (2026-11-20): "original request"
- L2 (2026-11-20): analysis
`;

describe("ticket list: parse", () => {
	it("reads ID, specs, title, deps, done check, and status from the ## Tasks section only", () => {
		const { tickets } = parseTicketList(DOC);
		assert.deepEqual(
			tickets.map((t) => [t.id, t.specs, t.deps, t.done, t.status]),
			[
				["T1", ["S1"], [], "npm test -- tests/a.test.ts", "done"],
				["T2", ["S2"], ["T1"], "npm test -- tests/b.test.ts", "pending"],
				["T3", ["S1", "S2"], ["T1", "T2"], "the board shows ticket cards", "pending"],
			],
		);
		assert.equal(tickets[0].note, "abc123 (RED→GREEN)");
		assert.equal(tickets[1].title, "inline: loop — Risk: contract — careful");
	});

	it("expands spec ranges (S1–S3) and keeps [all] linked to every spec", () => {
		const list = parseTicketList("## Tasks\n- T1 [S1–S3] a done: `x` — pending\n- T2 [all] b done: `x` — pending\n- T3 [S4] c done: `x` — pending\n");
		assert.deepEqual(list.tickets[0].specs, ["S1", "S2", "S3"]);
		assert.deepEqual(ticketsLinkedTo(list, ["S2"]).map((t) => t.id), ["T1", "T2"]);
	});

	it("reads a ticket with no title (`- T10 [S12] — done ab1a472`)", () => {
		const [ticket] = parseTicketList("## Tasks\n- T10 [S12] — done ab1a472\n").tickets;
		assert.deepEqual([ticket.id, ticket.title, ticket.status, ticket.note], ["T10", "", "done", "ab1a472"]);
		assert.equal(setTicketStatus("## Tasks\n- T10 [S12] — pending\n", "T10", "done", "x"), "## Tasks\n- T10 [S12] — done x\n");
	});

	it("keeps today's lines without deps or done (both absent, nothing invented)", () => {
		const { tickets } = parseTicketList("## Tasks\n- T1 [S1] inline — pending\n- T2 [S1,S2] inline: docs — done f52f882\n");
		assert.deepEqual(tickets.map((t) => [t.id, t.deps, t.done, t.status, t.note]), [["T1", [], undefined, "pending", ""], ["T2", [], undefined, "done", "f52f882"]]);
	});
});

describe("ticket list: validate before a run", () => {
	it("accepts a complete list", () => {
		assert.deepEqual(validateForRun(parseTicketList(DOC)), []);
	});

	it("refuses unfinished tickets without a done check, naming them; finished ones may lack it", () => {
		const errors = validateForRun(parseTicketList("## Tasks\n- T1 [S1] inline — done x\n- T2 [S1] inline: a — pending\n- T3 [S1] inline: b deps: T2 — blocked waits\n"));
		assert.deepEqual(errors, ["T2 has no done: check", "T3 has no done: check"]);
	});

	it("refuses unknown deps, duplicate IDs, and dependency cycles", () => {
		const doc = "## Tasks\n- T1 [S1] a deps: T2 done: `x` — pending\n- T2 [S1] b deps: T1 done: `x` — pending\n- T3 [S1] c deps: T9 done: `x` — pending\n- T3 [S1] d done: `x` — pending\n";
		const errors = validateForRun(parseTicketList(doc));
		assert.ok(errors.includes("T3 depends on unknown T9"), errors.join("\n"));
		assert.ok(errors.includes("T3 appears twice"), errors.join("\n"));
		assert.ok(errors.some((e) => /cycle/.test(e) && e.includes("T1") && e.includes("T2")), errors.join("\n"));
	});

	it("refuses a doc with no ticket list", () => {
		assert.deepEqual(validateForRun(parseTicketList("# Feature\n\n## Specs\n- S1: x\n")), ["no tickets under ## Tasks"]);
	});
});

describe("ticket list: ready tickets", () => {
	it("are pending tickets whose deps are all done, in doc order", () => {
		assert.deepEqual(readyTickets(parseTicketList(DOC)).map((t) => t.id), ["T2"]);
	});

	it("a blocked or dropped dependency does not count as done", () => {
		const doc = "## Tasks\n- T1 [S1] a done: `x` — blocked needs you\n- T2 [S1] b done: `x` — dropped obsolete\n- T3 [S1] c deps: T1 done: `x` — pending\n- T4 [S1] d deps: T2 done: `x` — pending\n- T5 [S1] e done: `x` — pending\n";
		assert.deepEqual(readyTickets(parseTicketList(doc)).map((t) => t.id), ["T5"]);
	});
});

describe("ticket list: write-back", () => {
	it("setTicketStatus replaces only that ticket's status and note", () => {
		const next = setTicketStatus(DOC, "T2", "done", "def456 (RED→GREEN, suite 12 pass)");
		assert.match(next, /^- T2 \[S2\] inline: loop — Risk: contract — careful deps: T1 done: `npm test -- tests\/b.test.ts` — done def456 \(RED→GREEN, suite 12 pass\)$/m);
		assert.equal(next.replace(/^- T2 .*$/m, ""), DOC.replace(/^- T2 .*$/m, ""));
	});

	it("setTicketStatus throws for an unknown ticket", () => {
		assert.throws(() => setTicketStatus(DOC, "T9", "done", ""), /T9/);
	});

	it("appendLogLine adds the next L number at the end of ## Log", () => {
		const next = appendLogLine(DOC, "2026-11-21", "T2 done def456");
		assert.ok(next.endsWith("- L2 (2026-11-20): analysis\n- L3 (2026-11-21): T2 done def456\n"), next);
	});

	it("appendLogLine keeps a later section after ## Log intact", () => {
		const next = appendLogLine(`${DOC}\n## Notes\nkeep\n`, "2026-11-21", "x");
		assert.match(next, /- L2 \(2026-11-20\): analysis\n- L3 \(2026-11-21\): x\n\n## Notes\nkeep\n$/);
	});
});

describe("ticket list: ownership while running", () => {
	const owned = (doc: string, ids: string[]) => Object.fromEntries(parseTicketList(doc).tickets.filter((t) => ids.includes(t.id)).map((t) => [t.id, t.raw]));

	it("a user edit to a pending ticket is not a conflict, and is read at the next pick", () => {
		const edited = DOC.replace("): board deps", "): board with cards deps");
		assert.notEqual(edited, DOC);
		assert.deepEqual(ownedLineConflicts(edited, owned(DOC, ["T1", "T2"])), []);
		assert.equal(parseTicketList(edited).tickets[2].title, "delegated (parallel writers): board with cards");
	});

	it("a user edit to a runner-owned line (running or finished) is a conflict", () => {
		const edited = DOC.replace("tests/b.test.ts` — pending", "tests/c.test.ts` — pending");
		assert.deepEqual(ownedLineConflicts(edited, owned(DOC, ["T1", "T2"])), ["T2"]);
	});

	it("a removed runner-owned line is a conflict", () => {
		const edited = DOC.replace(/^- T1 .*\n/m, "");
		assert.deepEqual(ownedLineConflicts(edited, owned(DOC, ["T1"])), ["T1"]);
	});

	it("changedSpecs names edited, added, and removed specs; ticketsLinkedTo finds their tickets", () => {
		const edited = DOC.replace("- S2: Pick ready tickets.", "- S2: Pick ready tickets by priority.").replace("- S1: Parse the list. Check: parser tests.\n", "- S1: Parse the list. Check: parser tests.\n- S3: New.\n");
		const specs = changedSpecs(DOC, edited);
		assert.deepEqual(specs, ["S2", "S3"]);
		assert.deepEqual(ticketsLinkedTo(parseTicketList(edited), specs).map((t) => t.id), ["T2", "T3"]);
		assert.deepEqual(changedSpecs(DOC, DOC.replace(/^- S1: .*\n/m, "")), ["S1"]);
	});
});

describe("ticket list: atomic write", () => {
	const dir = mkdtempSync(join(tmpdir(), "ticket-list-"));
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("replaces the file and leaves no temp file behind", () => {
		const file = join(dir, "doc.md");
		writeFileSync(file, "old");
		writeFileAtomic(file, "new");
		assert.equal(readFileSync(file, "utf8"), "new");
		assert.deepEqual(readdirSync(dir), ["doc.md"]);
	});

	it("a failure before the rename keeps the old file and removes the temp file", () => {
		const file = join(dir, "keep.md");
		writeFileSync(file, "old");
		assert.throws(() => writeFileAtomic(file, "new", { rename: () => { throw new Error("crash"); } }), /crash/);
		assert.equal(readFileSync(file, "utf8"), "old");
		assert.ok(readdirSync(dir).every((name) => !name.includes(".tmp")), readdirSync(dir).join(","));
		assert.ok(existsSync(file));
	});
});
