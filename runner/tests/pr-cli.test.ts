// T6 (A1, A8): the CLI side of the PR loop: `start --no-pr`, `merge <doc>` (and its refusal while a `start` holds the store), the PR lines of `status`,
// and what `start` prints when the PR loop parks for a person.
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireStore, main, startLoop, storePathFor } from "../src/cli.ts";
import { POLL_MS } from "../src/pr.ts";
import { commitFile, docText, fakeClock, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";
import { addRemote, FakeGh, prDepsOf } from "./pr-fixture.ts";

let isolation: Isolation;
let env: Record<string, string | undefined>;
before(() => {
	isolation = isolateEnv();
	env = { BRIGADEV_HOME: process.env.BRIGADEV_HOME };
});
after(() => isolation.restore());

let ws: Workspace;
let gh: FakeGh;
let clock: ReturnType<typeof fakeClock>;
let runner: FixtureRunner | undefined;
beforeEach(() => {
	isolation.settings({ check: { test: "true" } });
	rmSync(isolation.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
	gh = new FakeGh(addRemote(ws));
	clock = fakeClock();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: app deps: none done: `test -f app.js` — pending";

async function cli(args: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, env, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, ws.repo);
	return { code, stdout, stderr };
}

async function openStore() {
	const path = storePathFor(ws.repo, env);
	mkdirSync(dirname(path), { recursive: true });
	return openNodeSqliteStorage(path);
}

const open = async (storage = openStore()) => openFixtureRunner(ws, makeWorker({ T1: commitFile("app.js") }), { storage: await storage, clock, prDeps: prDepsOf(gh) });

/** `startLoop` with the fake clock ticking: a CI wait is a timer of the process, so `start` stays in the foreground for it. */
async function startTicking(r: FixtureRunner, pr: boolean) {
	let out = "";
	const ticker = setInterval(() => clock.advance(POLL_MS), 100);
	try {
		const code = await startLoop(r, ws.docPath, { out: (text) => (out += `${text}\n`), err: () => {} }, { pr });
		return { code, out };
	} finally {
		clearInterval(ticker);
	}
}

describe("start --no-pr (A1, A8)", () => {
	it("the flag is accepted before or after the doc and an unknown flag is a usage error; the usage names merge and --no-pr", async () => {
		writeFileSync(ws.docPath, "# Feature\n\n## Specs\n- S1: x\n");
		for (const args of [["start", ws.docPath, "--no-pr"], ["start", "--no-pr", ws.docPath]]) {
			const result = await cli(args);
			assert.equal(result.code, 1, args.join(" "));
			assert.match(result.stderr, /no tickets under ## Tasks/, "reaches the doc check, like `start`");
		}
		const bad = await cli(["start", ws.docPath, "--bogus"]);
		assert.equal(bad.code, 2);
		assert.match(bad.stderr, /usage: brigadev-runner start <feature-doc> \[--no-pr\]/);
		assert.match(bad.stderr, /brigadev-runner merge <feature-doc>/);
		assert.equal((await cli(["status", ws.docPath, "--no-pr"])).code, 2, "--no-pr belongs to start");
	});

	it("without the PR loop (the default of the loop task, and `--no-pr`) the run ends done after the tickets and touches neither git push nor gh", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await open();
		let out = "";
		const code = await startLoop(runner, ws.docPath, { out: (text) => (out += `${text}\n`), err: () => {} });
		assert.equal(code, 0);
		assert.match(out, /"status": "done"/);
		assert.equal(gh.ghCalls.length, 0);
		assert.equal(gh.pushes().length, 0);
	});
});

describe("the PR loop from the CLI (A8)", () => {
	it("`start` parks at the merge approval and prints the PR and the command; `status` shows the PR lines; `merge` delivers once; `start` again merges and exits 0", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await open();
		const parked = await startTicking(runner, true);
		assert.equal(parked.code, 1);
		assert.match(parked.out, /"status": "waiting"/);
		assert.match(parked.out, /PR loop: wait-merge https:\/\/github\.com\/acme\/repo\/pull\/1/);
		assert.match(parked.out, new RegExp(`Ready to merge\\. Approve with: brigadev-runner merge ${ws.docPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		await runner.close();
		runner = undefined;

		const status = await cli(["status", ws.docPath]);
		assert.equal(status.code, 0);
		assert.match(status.stdout, /pr: wait-merge {2}https:\/\/github\.com\/acme\/repo\/pull\/1/);
		assert.match(status.stdout, /merge: brigadev-runner merge /);

		const merge = await cli(["merge", ws.docPath]);
		assert.equal(merge.code, 0, merge.stderr);
		assert.match(merge.stdout, /delivered: merge approved for https:\/\/github\.com\/acme\/repo\/pull\/1/);
		assert.equal(gh.merges().length, 0, "the command delivers; it merges nothing itself");
		const again = await cli(["merge", ws.docPath]);
		assert.equal(again.code, 1);
		assert.match(again.stderr, /duplicate: the merge was already approved/);

		runner = await open();
		const done = await startTicking(runner, true);
		assert.equal(done.code, 0);
		assert.match(done.out, /"status": "merged"/);
		assert.equal(gh.merges().length, 1);
		const after = await cli(["merge", ws.docPath]);
		assert.equal(after.code, 1);
		assert.match(after.stderr, /closed: the loop ended/);
	});

	it("`merge` refuses while a `start` holds the store, a doc that was never started, a loop not at the approval, and bad usage", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const none = await cli(["merge", ws.docPath]);
		assert.equal(none.code, 1);
		assert.match(none.stderr, /no runner state/);

		// A loop that has not reached the PR loop (no `pr`): there is nothing to approve.
		runner = await open();
		const id = await runner.start(ws.docPath);
		assert.equal((await runner.wait(id)).status, "completed");
		await runner.close();
		runner = undefined;
		const ended = await cli(["merge", ws.docPath]);
		assert.equal(ended.code, 1);
		assert.match(ended.stderr, /closed: the loop ended/);

		const held = acquireStore(storePathFor(ws.repo, env));
		assert.equal(typeof held, "function");
		try {
			const refused = await cli(["merge", ws.docPath]);
			assert.equal(refused.code, 1);
			assert.match(refused.stderr, /`brigadev-runner start` is running on this store/);
		} finally {
			(held as () => void)();
		}
		assert.equal((await cli(["merge"])).code, 2);
		assert.equal((await cli(["merge", ws.docPath, "extra"])).code, 2);
	});
});

describe("start cannot change how a loop was started (B5, R3-002)", () => {
	const message = async (r: FixtureRunner, options: { pr: boolean }) => {
		let err = "";
		const code = await startLoop(r, ws.docPath, { out: () => {}, err: (text) => (err += `${text}\n`) }, options);
		return { code, err };
	};

	it("`start --no-pr` on a loop started with the PR loop exits 1 with how it was started, and pushes, opens, and comments nothing more (the ledger's repro: it pushed 1, created 1, commented 1)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await open();
		const parked = await startTicking(runner, true);
		assert.equal(parked.code, 1);
		await runner.close();
		runner = undefined;
		const before = { pushes: gh.pushes().length, creates: gh.creates().length, comments: gh.comments.length, ghCalls: gh.ghCalls.length };
		assert.deepEqual([before.pushes, before.creates], [1, 1]);

		runner = await open();
		const refused = await message(runner, { pr: false });
		assert.equal(refused.code, 1);
		assert.match(refused.err, /Refusing to start: this loop was started with the PR loop and that cannot change/);
		assert.match(refused.err, new RegExp(`brigadev-runner start ${ws.docPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
		assert.deepEqual({ pushes: gh.pushes().length, creates: gh.creates().length, comments: gh.comments.length, ghCalls: gh.ghCalls.length }, before, "nothing touched git or gh");
	});

	it("starting a loop that began with --no-pr with the PR loop is refused the same way, and the same options continue it", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await open();
		assert.equal((await message(runner, { pr: false })).code, 0, "the first start runs the tickets and ends done");
		await runner.close();
		runner = undefined;

		runner = await open();
		const refused = await message(runner, { pr: true });
		assert.equal(refused.code, 1);
		assert.match(refused.err, /started with --no-pr \(tickets only\) and that cannot change/);
		assert.equal(gh.ghCalls.length, 0);
		assert.equal((await message(runner, { pr: false })).code, 0, "the options it was started with are fine");
	});

	it("starting from another worktree than the loop's is refused, naming both (R3-002)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await open();
		assert.equal((await message(runner, { pr: false })).code, 0);
		await runner.close();
		runner = undefined;

		const elsewhere = join(ws.root, "elsewhere");
		mkdirSync(elsewhere);
		runner = await openFixtureRunner({ ...ws, repo: elsewhere }, makeWorker({ T1: commitFile("app.js") }), { storage: await openStore(), clock, prDeps: prDepsOf(gh) });
		const refused = await message(runner, { pr: false });
		assert.equal(refused.code, 1);
		assert.ok(refused.err.includes(`this loop was started in ${ws.repo}`), refused.err);
		assert.ok(refused.err.includes(`cannot move to ${elsewhere}`), refused.err);
	});
});
