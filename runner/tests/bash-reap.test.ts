// H4: the worker's bash calls (the worker, the verifier, a FIX-n ticket: one tool, one execution environment) do not outlive the call and have no controlling
// terminal. A background process (`sleep 30 &`, `nohup … &`) is killed with the call's process group when the call returns, so a script the agent starts cannot keep
// running next to the runner (read its terminal, send it signals, wait for a link). End to end here, through the guard and the registry; the environment itself is in
// `reaping-env.test.ts`.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { bash, commitFile, docText, goneWithin, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, type FixtureRunner, type Workspace } from "./fixture.ts";

let restoreEnv: () => void;
before(() => {
	restoreEnv = isolateEnv().restore;
});
after(() => restoreEnv());

let ws: Workspace;
let runner: FixtureRunner | undefined;
let pids: number[] = [];
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(async () => {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Already gone: that is the point.
		}
	}
	pids = [];
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: storage deps: none done: `test -f t1.txt` — pending";

describe("a worker's bash call leaves nothing behind (H4)", () => {
	it("`sleep 30 &` and `nohup … &` are dead after the call returns, `tty` says not a tty, the call is a process group leader, and normal output and exit codes are unchanged", async () => {
		writeDoc();
		const worker = makeWorker({
			T1: [
				bash("sleep 30 & echo bg1=$!"),
				bash("nohup sleep 30 >/dev/null 2>&1 & echo bg2=$!"),
				bash("tty; ps -o pgid= -p $$; echo me=$$; ps -o tty= -p $$"),
				bash("echo out; echo err >&2; exit 3"),
				...commitFile("t1.txt"),
			],
		});
		runner = await openFixtureRunner(ws, worker);
		const id = await runner.start(ws.docPath);
		const outcome = await runner.wait(id);
		assert.equal(outcome.status, "completed");

		const texts = worker.results.filter((result) => result.ticketId === "T1").map((result) => result.text);
		const backgrounded = texts.flatMap((text) => [...text.matchAll(/bg\d=(\d+)/g)].map((match) => Number(match[1])));
		assert.equal(backgrounded.length, 2, `two background pids reported: ${texts.join(" | ")}`);
		pids.push(...backgrounded);
		for (const pid of backgrounded) assert.equal(await goneWithin(pid, 5_000), true, `background process ${pid} outlived the bash call that started it`);

		const where = texts.find((text) => /me=\d+/.test(text))!;
		assert.match(where, /not a tty/, "no terminal on stdin");
		const me = /me=(\d+)/.exec(where)![1];
		assert.match(where, new RegExp(`^\\s*${me}\\s*$`, "m"), "its own process group (and session)");
		assert.match(where, /^\s*\?+\s*$/m, "no controlling terminal");

		const exited = texts.find((text) => /^out$/m.test(text))!;
		assert.match(exited, /err/);
		assert.ok(worker.results.some((result) => result.isError && /exited with code 3/.test(result.text)), "a nonzero exit is still an error result with its code");
	});
});

function writeDoc() {
	writeFileSync(ws.docPath, docText([T1]));
}
