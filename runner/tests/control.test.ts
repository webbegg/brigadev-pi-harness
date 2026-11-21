// T5 (A5, A6 e): the CLI's `status`, `answer`, `pause`, `resume`: output and exit codes, and that they never run a worker.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireStore, lockHolder, main, startLoop, storePathFor } from "../src/cli.ts";
import { askUser, commitFile, docText, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, type FixtureRunner, type Workspace } from "./fixture.ts";

let restoreEnv: () => void;
let env: Record<string, string | undefined>;
before(() => {
	restoreEnv = isolateEnv().restore;
	env = { BRIGADEV_HOME: process.env.BRIGADEV_HOME };
});
after(() => restoreEnv());

let ws: Workspace;
let runner: FixtureRunner | undefined;
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

async function cli(args: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, env, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, ws.repo);
	return { code, stdout, stderr };
}

/** The runner the CLI would use: SQLite at the repo's store path. */
async function openStore() {
	const path = storePathFor(ws.repo, env);
	mkdirSync(dirname(path), { recursive: true });
	return openNodeSqliteStorage(path);
}

const T1 = "- T1 [S1] inline: storage deps: none done: `test -f t1.txt` — pending";
const T2 = "- T2 [S2] inline: after deps: T1 done: `test -f t2.txt` — pending";
const T3 = "- T3 [S2] inline: independent deps: none done: `test -f t3.txt` — pending";
const FAILS = (id: string) => `- ${id} [S1] inline: fails deps: none done: \`cat never.txt\` — pending`;

describe("brigadev-runner status / answer / pause / resume", () => {
	it("status of a doc that was never started: exit 1, and no store is created", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const result = await cli(["status", ws.docPath]);
		assert.equal(result.code, 1);
		assert.match(result.stderr, /no runner state/);
		assert.equal(existsSync(storePathFor(ws.repo, env)), false, "a read-only command creates nothing");
		for (const command of ["answer", "pause", "resume"]) {
			const control = await cli(command === "answer" ? [command, ws.docPath, "T1", "1"] : [command, ws.docPath]);
			assert.equal(control.code, 1, command);
			assert.match(control.stderr, /no runner state/);
		}
		assert.equal(existsSync(storePathFor(ws.repo, env)), false);
	});

	it("answer, pause, and resume refuse while a `start` holds the store (a second Harness would mark its running tasks crashed); status still reads", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: [askUser("Which?", ["a", "b"])] });
		runner = await openFixtureRunner(ws, worker, { storage: await openStore() });
		assert.equal((await runner.settle(await runner.start(ws.docPath))).status, "waiting");
		await runner.close();
		runner = undefined;

		const held = acquireStore(storePathFor(ws.repo, env));
		assert.equal(typeof held, "function");
		try {
			assert.equal(lockHolder(storePathFor(ws.repo, env)), process.pid);
			for (const args of [["answer", ws.docPath, "T1", "1"], ["pause", ws.docPath], ["resume", ws.docPath]]) {
				const result = await cli(args);
				assert.equal(result.code, 1, args[0]);
				assert.match(result.stderr, /`brigadev-runner start` is running on this store/);
			}
			assert.equal((await cli(["status", ws.docPath])).code, 0);
		} finally {
			(held as () => void)();
		}
		assert.equal(lockHolder(storePathFor(ws.repo, env)), undefined, "released");
		assert.equal((await cli(["pause", ws.docPath])).code, 0, "free again");
		// The lock is the OS's, not a file's: a pid file left by a dead process holds nothing.
		writeFileSync(`${storePathFor(ws.repo, env)}.lock.pid`, "999999999");
		assert.equal(lockHolder(storePathFor(ws.repo, env)), undefined);
		const again = acquireStore(storePathFor(ws.repo, env));
		assert.equal(typeof again, "function", "taken again over the stale pid file");
		(again as () => void)();
	});

	it("shows the open decision with its options, the recommended mark, and the exact answer command; answer maps every signal result to an exit code", async () => {
		writeFileSync(ws.docPath, docText([T1, T2, T3]));
		const worker = makeWorker({
			T1: (run) => (run === 1 ? [askUser("Which storage?", [{ label: "SQLite", description: "one file" }, { label: "JSONL" }], { recommended: 1 })] : commitFile("t1.txt")),
			T2: commitFile("t2.txt"),
			T3: commitFile("t3.txt"),
		});
		runner = await openFixtureRunner(ws, worker, { storage: await openStore() });
		const id = await runner.start(ws.docPath);
		assert.equal((await runner.settle(id)).status, "waiting");
		await runner.close();
		runner = undefined;
		const calls = worker.faux.state.callCount;
		const docBefore = readDoc(ws);

		const status = await cli(["status", ws.docPath]);
		assert.equal(status.code, 0, status.stderr);
		assert.match(status.stdout, /^loop: sleeping \(waiting for 1 decision\)/m);
		assert.match(status.stdout, /T1 blocked/);
		assert.match(status.stdout, /T2 pending/);
		assert.match(status.stdout, /T3 done/);
		assert.match(status.stdout, /decision T1: Which storage\?/);
		assert.match(status.stdout, /^\s+1\. SQLite \(recommended\) — one file$/m);
		assert.match(status.stdout, /^\s+2\. JSONL$/m);
		assert.ok(status.stdout.includes(`brigadev-runner answer ${ws.docPath} T1 <1..2|text>`), status.stdout);
		assert.equal(readDoc(ws), docBefore, "status is read-only");

		const invalid = await cli(["answer", ws.docPath, "T1", "7"]);
		assert.equal(invalid.code, 2);
		assert.match(invalid.stderr, /7 is not an option \(1-2\)/);
		const unknown = await cli(["answer", ws.docPath, "T9", "1"]);
		assert.equal(unknown.code, 1);
		assert.match(unknown.stderr, /not_found: no decision for T9/);

		const delivered = await cli(["answer", ws.docPath, "T1", "2"]);
		assert.equal(delivered.code, 0, delivered.stderr);
		assert.match(delivered.stdout, /delivered: T1 answered 2\. JSONL/);
		const duplicate = await cli(["answer", ws.docPath, "T1", "1"]);
		assert.equal(duplicate.code, 1);
		assert.match(duplicate.stderr, /duplicate: T1 already has an answer/);

		assert.equal(worker.faux.state.callCount, calls, "answer ran no worker");
		assert.equal(readDoc(ws), docBefore, "and wrote nothing to the doc");
		assert.doesNotMatch(delivered.stderr + duplicate.stderr, /report:/);

		// The same store, reopened by `start`: the loop wakes, reruns T1 with the answer, and finishes.
		runner = await openFixtureRunner(ws, worker, { storage: await openStore() });
		const outcome = await runner.settle(await runner.start(ws.docPath));
		assert.equal((outcome as { result: { status: string } }).result.status, "done");
		assert.match(worker.prompts.find((p) => p.ticketId === "T1" && p.run === 2)!.system, /answer: JSONL/i);
		assert.match(ticketLine(readDoc(ws), "T1"), /— done/);
	});

	it("pause is delivered once (the second is a duplicate); resume refuses a loop that is not paused, and a paused one takes it once", async () => {
		writeFileSync(ws.docPath, docText([FAILS("T1"), FAILS("T2"), T3]));
		const worker = makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt"), T3: commitFile("t3.txt") });
		runner = await openFixtureRunner(ws, worker, { storage: await openStore() });
		const id = await runner.start(ws.docPath, { maxAttempts: 1 });
		assert.equal((await runner.settle(id)).status, "waiting");
		await runner.close();
		runner = undefined;

		const status = await cli(["status", ws.docPath]);
		assert.match(status.stdout, /^loop: paused: two consecutive tickets failed: T1, T2$/m);

		const pause = await cli(["pause", ws.docPath]);
		assert.equal(pause.code, 1, "already paused");
		assert.match(pause.stderr, /already paused/);

		const resume = await cli(["resume", ws.docPath]);
		assert.equal(resume.code, 0, resume.stderr);
		assert.match(resume.stdout, /delivered: resume requested/);
		const again = await cli(["resume", ws.docPath]);
		assert.equal(again.code, 1);
		assert.match(again.stderr, /duplicate: resume already requested/);

		runner = await openFixtureRunner(ws, worker, { storage: await openStore() });
		const outcome = await runner.settle(await runner.start(ws.docPath));
		assert.equal((outcome as { result: { status: string } }).result.status, "stalled");

		// The loop ended: every control command gets a final `closed`.
		const closedAnswer = await cli(["answer", ws.docPath, "T1", "1"]);
		assert.equal(closedAnswer.code, 1);
		assert.match(closedAnswer.stderr, /closed: the loop ended/);
		assert.equal((await cli(["resume", ws.docPath])).code, 1);
		assert.equal((await cli(["pause", ws.docPath])).code, 1);
		const ended = await cli(["status", ws.docPath]);
		assert.match(ended.stdout, /^loop: stalled \(waiting: T1, T2\)$/m);
	});

	it("pause while tickets run is delivered early; usage and doc errors exit 2 and 1", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: [askUser("Which?", ["a", "b"])] });
		runner = await openFixtureRunner(ws, worker, { storage: await openStore() });
		assert.equal((await runner.settle(await runner.start(ws.docPath))).status, "waiting");
		await runner.close();
		runner = undefined;

		const pause = await cli(["pause", ws.docPath]);
		assert.equal(pause.code, 0, pause.stderr);
		assert.match(pause.stdout, /delivered: pause requested/);
		assert.equal((await cli(["pause", ws.docPath])).code, 1);

		assert.equal((await cli(["answer", ws.docPath, "T1"])).code, 2, "choice missing");
		assert.equal((await cli(["answer", ws.docPath])).code, 2);
		assert.equal((await cli(["pause"])).code, 2);
		assert.equal((await cli(["status"])).code, 2);
		const missing = await cli(["resume", `${ws.docPath}.missing`]);
		assert.equal(missing.code, 1);
		assert.match(missing.stderr, /cannot read/);
	});
});

describe("start parks instead of hanging", () => {
	it("returns 1 with the open decisions and the answer command when the loop waits for a person", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: [askUser("Which?", ["a", "b"])] });
		runner = await openFixtureRunner(ws, worker);
		let out = "";
		const code = await startLoop(runner, ws.docPath, { out: (text) => (out += `${text}\n`), err: () => {} });
		assert.equal(code, 1);
		assert.match(out, /"status": "waiting"/);
		assert.match(out, /brigadev-runner answer/);
		assert.match(out, /then run `brigadev-runner start/);
	});
});
