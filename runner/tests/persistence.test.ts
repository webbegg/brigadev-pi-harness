// S3: closing the Harness mid-ticket and reopening the same storage resumes at the last checkpoint.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { commitFile, context, docText, git, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc } from "./fixture.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";

let restoreEnv: () => void;
before(() => {
	restoreEnv = isolateEnv().restore;
});
after(() => restoreEnv());

const T1 = "- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending";
const T2 = "- T2 [S2] inline: second deps: T1 done: `test -f t2.txt` — pending";

const backends: Array<[string, (dir: string) => Promise<Storage>]> = [
	["JSONL", (dir) => openNodeJsonlStorage(join(dir, "jsonl"), context)],
	["SQLite", (dir) => openNodeSqliteStorage(join(dir, "runner.sqlite"))],
];

for (const [name, open] of backends) {
	describe(`persistence on ${name} storage (S3)`, () => {
		it("close while ticket 1's done check is running; reopen + resume: T1's worker is not run again, both tickets end done", async () => {
			const ws = makeWorkspace();
			const store = mkdtempSync(join(tmpdir(), "brigadev-runner-store-"));
			try {
				writeFileSync(ws.docPath, docText([T1, T2]));
				const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") });

				// Checkpoint hit: the worker has answered (its commit exists) and T1's `check` phase is inside its done command.
				let checks = 0;
				let reached!: () => void;
				const inCheck = new Promise<void>((resolve) => (reached = resolve));
				const hung: TicketDeps = {
					head: defaultDeps.head,
					run: async (command, cwd, signal) => {
						checks += 1;
						if (checks > 1) return defaultDeps.run(command, cwd, signal);
						reached();
						await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted by close")), { once: true }));
						throw new Error("unreachable");
					},
				};

				const first = await openFixtureRunner(ws, worker, { storage: await open(store), deps: hung });
				const taskId = await first.start(ws.docPath);
				await inCheck;
				assert.equal(worker.faux.state.callCount, 4, "T1's worker answered: three tool calls (write, check, commit) + final text");
				const headBeforeClose = git(ws.repo, "rev-parse", "HEAD");
				await first.close();

				const second = await openFixtureRunner(ws, worker, { storage: await open(store) });
				try {
					second.harness.resume();
					assert.equal(await second.start(ws.docPath), taskId, "the same loop task is found again");
					const outcome = await second.wait(taskId);
					assert.deepEqual(outcome, { status: "completed", result: { status: "done", tickets: [{ id: "T1", status: "done" }, { id: "T2", status: "done" }] } });
				} finally {
					await second.close();
					assert.deepEqual(second.reports.map((r) => r.kind), [], "no fault reports after reopen");
				}
				assert.deepEqual(first.reports.map((r) => r.kind), [], "closing mid-check is not a fault");

				assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T2"], "one attempt per ticket");
				assert.equal(worker.faux.state.callCount, 8, "four model calls per ticket, none repeated");
				assert.equal(git(ws.repo, "rev-list", "--count", "HEAD"), "3", "initial + one commit per ticket");
				assert.ok(git(ws.repo, "rev-parse", "HEAD~1") === headBeforeClose, "T1's commit survived and is not replaced");
				assert.deepEqual(parseTicketList(readDoc(ws)).tickets.map((t) => t.status), ["done", "done"]);
				assert.equal(readDoc(ws).split("\n").filter((l) => /\): T1 done /.test(l)).length, 1, "one Log line for T1");
			} finally {
				ws.cleanup();
				rmSync(store, { recursive: true, force: true });
			}
		});
	});
}
