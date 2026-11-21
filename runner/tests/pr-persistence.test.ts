// T6 (S3, A6): killing the runner at a PR loop phase and starting it again resumes at the last checkpoint: exactly one `gh pr create`, one push per sha, no repeated
// fix attempt, merge called at most once. "Kill" is closing the Harness while the phase's outside call hangs (as persistence.test.ts does), then reopening the same
// storage with the same clock and the same fake GitHub. Phases: final-check, push, open (between `gh pr create` and the checkpoint), wait-ci, fix, wait-merge (also
// right after `gh pr merge`, and an approval that expired meanwhile), on JSONL and SQLite. Also A5: `duplicate` and `closed` results of the `merge` command.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Storage } from "@earendil-works/pi-durable";
import { mergeLoop, resumeLoop } from "../src/control.ts";
import { POLL_MS, type PrDeps } from "../src/pr.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";
import { commitFile, context, docText, fakeClock, FEATURE_BRANCH, git, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";
import { addRemote, drivers, FakeGh, FAIL, hangOnce, PASS, PENDING, prDepsOf, until } from "./pr-fixture.ts";

let env: Isolation;
before(() => {
	env = isolateEnv();
});
after(() => env.restore());

const T1 = "- T1 [S1] inline: app deps: none done: `test -f app.js` — pending";
const HOUR = 60 * 60 * 1000;

const backends: Array<[string, (dir: string) => Promise<Storage>]> = [
	["JSONL", (dir) => openNodeJsonlStorage(join(dir, "jsonl"), context)],
	["SQLite", (dir) => openNodeSqliteStorage(join(dir, "runner.sqlite"))],
];

for (const [name, open] of backends) {
	describe(`PR loop persistence on ${name} storage (S3)`, () => {
		let ws: Workspace;
		let gh: FakeGh;
		let clock: ReturnType<typeof fakeClock>;
		let store: string;
		let current: FixtureRunner;
		let opened: FixtureRunner[];
		let worker: ReturnType<typeof makeWorker>;
		let prDeps: PrDeps;
		let deps: TicketDeps | undefined;
		let at: ReturnType<typeof drivers>;

		beforeEach(() => {
			env.settings({ check: { test: "true" } });
			rmSync(env.brigadevHome, { recursive: true, force: true });
			ws = makeWorkspace();
			gh = new FakeGh(addRemote(ws));
			clock = fakeClock();
			store = mkdtempSync(join(tmpdir(), "brigadev-runner-store-"));
			opened = [];
			prDeps = prDepsOf(gh);
			deps = undefined;
			worker = makeWorker({ T1: commitFile("app.js"), "FIX-1": commitFile("fix1.js"), "FIX-2": commitFile("fix2.js") });
			at = drivers(() => current, gh, clock, POLL_MS);
			writeFileSync(ws.docPath, docText([T1]));
		});
		afterEach(async () => {
			for (const runner of opened) await runner.close();
			ws.cleanup();
			rmSync(store, { recursive: true, force: true });
		});

		/** Open the runner on the same storage, clock, and fake GitHub (a new process). */
		const reopen = async (): Promise<FixtureRunner> => {
			current = await openFixtureRunner(ws, worker, { storage: await open(store), clock, prDeps, deps });
			opened.push(current);
			return current;
		};
		const kill = async () => {
			await current.close();
			assert.deepEqual(current.reports.map((report) => report.kind), [], "closing mid-phase is not a fault");
		};
		type LoopId = Awaited<ReturnType<FixtureRunner["start"]>>;
		const startFirst = async () => (await reopen()).start(ws.docPath, { pr: true });
		const outcomeStatus = async (runner: FixtureRunner, id: LoopId) => ((await runner.wait(id)) as { result: { status: string } }).result.status;

		/** After the restart: the loop is found again (not started twice), runs on to a merge approval, and the approval merges once. */
		async function finish(first: LoopId) {
			const second = await reopen();
			assert.equal(await second.start(ws.docPath, { pr: true }), first, "the same loop task");
			await at.atMerge(first);
			assert.equal((await mergeLoop(second, ws.docPath)).result, "delivered");
			assert.equal(await outcomeStatus(second, first), "merged");
			assert.equal(gh.merges().length, 1, "merged once");
			assert.equal(gh.creates().length, 1, "one `gh pr create`");
			assert.deepEqual(second.reports, [], "no fault reports after the reopen");
			return second;
		}

		it("killed during final-check: the suite runs again, nothing else is repeated", async () => {
			let calls = 0;
			let reached!: () => void;
			const hit = new Promise<void>((resolve) => (reached = resolve));
			const real = prDeps;
			prDeps = {
				...real,
				suite: async (cwd, signal) => {
					if (++calls === 1) {
						reached();
						await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted by close")), { once: true }));
					}
					return real.suite(cwd, signal);
				},
			};
			const first = await startFirst();
			await hit;
			assert.equal(gh.pushes().length, 0);
			await kill();
			await finish(first);
			assert.equal(calls, 2, "the interrupted suite ran again");
			assert.equal(gh.pushes().length, 1);
			assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "no ticket ran again");
		});

		it("killed right after `git push`: the remote already has the sha, so the push is not repeated", async () => {
			const hit = hangOnce(gh, "after", (command, args) => command === "git" && args[0] === "push");
			const first = await startFirst();
			await hit;
			assert.equal(gh.pushes().length, 1);
			await kill();
			await finish(first);
			assert.equal(gh.pushes().length, 1, "one push for one sha");
			assert.equal(gh.remoteSha(FEATURE_BRANCH), git(ws.repo, "rev-parse", "HEAD"));
		});

		it("killed between `gh pr create` and the checkpoint: the PR is found again, never created twice", async () => {
			const hit = hangOnce(gh, "after", (command, args) => command === "gh" && args[0] === "pr" && args[1] === "create");
			const first = await startFirst();
			await hit;
			assert.equal(gh.prs.length, 1);
			await kill();
			await finish(first);
			assert.equal(gh.prs.length, 1);
			assert.equal(gh.pushes().length, 1);
		});

		it("killed while waiting for CI: the poll resumes on the reopened clock, with no second push or PR", async () => {
			gh.checks = () => [PENDING];
			const first = await startFirst();
			await at.asleepAt(first, "wait-ci");
			const before = at.polls();
			clock.advance(POLL_MS);
			await until(() => at.polls() > before || undefined, "a poll");
			await at.asleepAt(first, "wait-ci");
			await kill();
			gh.checks = () => [PASS];
			await finish(first);
			assert.equal(gh.pushes().length, 1);
			assert.equal(gh.comments.length, 1, "one merge-ready comment");
		});

		it("killed while a fix ticket's done check runs: the fix is not attempted again, and its commit is pushed once", async () => {
			gh.checks = () => (gh.pushes().length >= 2 ? [PASS] : [FAIL]);
			let runs = 0;
			let reached = false;
			deps = {
				head: defaultDeps.head,
				// The 1st done check is T1's; the 2nd is FIX-1's, which hangs until the close.
				run: async (command, cwd, signal) => {
					if (++runs === 2) {
						reached = true;
						await new Promise<void>((_, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted by close")), { once: true }));
					}
					return defaultDeps.run(command, cwd, signal);
				},
			};
			const first = await startFirst();
			await at.driveTo(first, () => reached);
			assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1"]);
			await kill();
			await finish(first);
			assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1"], "FIX-1's worker did not run again, and there is no FIX-2");
			assert.equal(gh.pushes().length, 2, "one push per sha: T1's commit, FIX-1's commit");
			assert.equal(git(ws.repo, "rev-list", "--count", "main..HEAD"), "2");
			assert.equal(gh.remoteSha(FEATURE_BRANCH), git(ws.repo, "rev-parse", "HEAD"));
		});

		it("killed while parked for the merge approval: the approval is delivered to the reopened store without scheduling (a second is `duplicate`), then the merge happens once", async () => {
			const first = await startFirst();
			await at.atMerge(first);
			await kill();

			const second = await reopen(); // not started: delivering must run nothing
			const calls = gh.ghCalls.length;
			const delivered = await mergeLoop(second, ws.docPath);
			assert.deepEqual([delivered.code, delivered.result], [0, "delivered"], delivered.text);
			const again = await mergeLoop(second, ws.docPath);
			assert.deepEqual([again.code, again.result], [1, "duplicate"]);
			assert.equal((await second.harness.inspect(context)).scheduling, "paused", "delivering does not schedule");
			assert.equal(gh.ghCalls.length, calls, "no gh call");
			assert.equal(gh.merges().length, 0);

			assert.equal(await second.start(ws.docPath, { pr: true }), first);
			assert.equal(await outcomeStatus(second, first), "merged");
			assert.equal(gh.merges().length, 1);
			assert.equal(gh.comments.length, 1, "the merge-ready comment was not posted again");
			assert.equal(gh.creates().length, 1);
			assert.equal(gh.pushes().length, 1);
		});

		it("killed at the merge approval and reopened after its 24 h: the approval is `closed`, and the loop stops with `merge approval expired`", async () => {
			const first = await startFirst();
			await at.atMerge(first);
			await kill();
			clock.advance(24 * HOUR + 1000);

			const second = await reopen();
			const late = await mergeLoop(second, ws.docPath);
			assert.deepEqual([late.code, late.result], [1, "closed"], late.text);
			assert.equal((await second.harness.inspect(context)).scheduling, "paused");

			await second.start(ws.docPath, { pr: true });
			const stopped = await at.atStop(first);
			assert.equal(stopped.reason, "merge approval expired");
			assert.equal(gh.merges().length, 0, "the late approval merged nothing");
			assert.match(readDoc(ws), /PR loop needs you \(1\): merge approval expired/);
			assert.equal((await resumeLoop(second, ws.docPath)).result, "delivered");
			assert.equal((await at.atMerge(first)).mergeKey, "merge-2");
			assert.equal((await mergeLoop(second, ws.docPath)).result, "delivered");
			assert.equal(await outcomeStatus(second, first), "merged");
			assert.equal(gh.merges().length, 1);
		});

		it("killed right after `gh pr merge` ran: the reopened loop sees the PR merged and does not merge again", async () => {
			const first = await startFirst();
			await at.atMerge(first);
			const hit = hangOnce(gh, "after", (command, args) => command === "gh" && args[0] === "pr" && args[1] === "merge");
			assert.equal((await mergeLoop(current, ws.docPath)).result, "delivered");
			await hit;
			assert.equal(gh.merges().length, 1);
			await kill();

			const second = await reopen();
			assert.equal(await second.start(ws.docPath, { pr: true }), first);
			assert.equal(await outcomeStatus(second, first), "merged");
			assert.equal(gh.merges().length, 1, "merge was called at most once");
			assert.match(readDoc(ws), /PR #1 merged/);
		});
	});
}
