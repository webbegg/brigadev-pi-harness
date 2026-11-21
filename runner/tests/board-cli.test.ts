// T7 (S6, R3): `brigadev-runner start <doc> --web [--port N]`: the board starts before the loop, its one-time link goes to stdout only, the process stays up while the loop
// waits for a person (so the board's answers reach it), it ends with the loop or on SIGINT/SIGTERM, and a fresh link is one SIGUSR1 or Enter away.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireStore, main, startLoop, storePathFor, watchInterrupt, wireLinkRequests, type WebStart } from "../src/cli.ts";
import { askUser, commitFile, context, docText, git, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, type FixtureRunner, type Workspace } from "./fixture.ts";
import { until } from "./pr-fixture.ts";

let restoreEnv: () => void;
let env: Record<string, string | undefined>;
before(() => {
	restoreEnv = isolateEnv().restore;
	env = { BRIGADEV_HOME: process.env.BRIGADEV_HOME };
});
after(() => restoreEnv());

let ws: Workspace;
let runner: FixtureRunner | undefined;
let dirs: string[] = [];
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
	dirs = [];
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: storage deps: none done: `test -f t1.txt` — pending";
const OPTIONS = [{ label: "SQLite" }, { label: "JSONL" }];
const LINK = /(http:\/\/127\.0\.0\.1:(\d+)\/\?code=([A-Za-z0-9_-]+))/;

async function cli(args: string[]) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, env, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, ws.repo);
	return { code, stdout, stderr };
}

/** `startLoop --web` with its output captured; `links()` are the one-time links printed so far. */
function startWeb(r: FixtureRunner, web: Partial<WebStart> = {}) {
	const out: string[] = [];
	const err: string[] = [];
	const state = { finished: false };
	const done = startLoop(r, ws.docPath, { out: (text) => out.push(text), err: (text) => err.push(text) }, { web: { port: 0, lingerMs: 0, debounceMs: 10, pollMs: 2_000, ...web } }).finally(() => (state.finished = true));
	const links = () => out.flatMap((line) => (LINK.exec(line) ? [LINK.exec(line)!] : []));
	return { out, err, state, done, links };
}

/** Sign in with a printed link's code and return an action poster. */
async function actor(link: RegExpExecArray) {
	const base = `http://127.0.0.1:${link[2]}/`;
	const session = await fetch(`${base}session`, { method: "POST", headers: { "x-brigadev-code": link[3] } });
	assert.equal(session.status, 200);
	const { secret } = (await session.json()) as { secret: string };
	return {
		base,
		async act(body: unknown) {
			const res = await fetch(`${base}action`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${secret}` }, body: JSON.stringify(body) });
			return res.status;
		},
	};
}

describe("`start --web`", () => {
	it("prints the one-time link before the loop runs, stays up while a decision waits, takes the answer from the board, and exits 0 when the loop ends, closing the server", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser("Which storage?", OPTIONS)] : commitFile("t1.txt")) });
		runner = await openFixtureRunner(ws, worker);
		// The loop is scheduled by `runner.start`: the link must be out before it is called.
		let linkBeforeStart: boolean | undefined;
		const realStart = runner.start.bind(runner);
		runner.start = async (...args) => {
			linkBeforeStart = web.links().length > 0;
			return realStart(...args);
		};
		const web = startWeb(runner);
		const link = await until(() => web.links()[0], "the printed link");
		await until(async () => (await runner!.find(ws.docPath)) ?? undefined, "the loop");
		assert.equal(linkBeforeStart, true, "the link is printed before the loop is scheduled");
		assert.match(web.out[0], /^brigadev board: http:\/\/127\.0\.0\.1:\d+\/\?code=\S+ \(one-time link, valid 60 s/, "the first line of stdout");

		const { act, base } = await actor(link);
		const id = await until(async () => runner!.find(ws.docPath), "the loop");
		const decision = await until(async () => (await runner!.status(id)).decisions[0], "the parked decision");
		await new Promise((resolve) => setTimeout(resolve, 150));
		assert.equal(web.state.finished, false, "start does not return while the loop waits for a person: the board is how it is answered");

		assert.equal(await act({ action: "answer", id: decision.key, value: "SQLite" }), 202);
		assert.equal(await web.done, 0);
		assert.match(ticketLine(readDoc(ws), "T1"), /— done /);
		assert.ok(web.out.some((line) => /"status": "completed"/.test(line)), "the outcome is printed as without --web");
		await assert.rejects(fetch(base), "the server is closed once the loop ended");
	});

	it("the code goes to stdout only: not to stderr, the doc, the commits, or the outcome", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: commitFile("t1.txt") });
		runner = await openFixtureRunner(ws, worker);
		const web = startWeb(runner);
		const link = await until(() => web.links()[0], "the printed link");
		assert.equal(await web.done, 0);
		const code = link[3];
		assert.equal(web.out.filter((line) => line.includes(code)).length, 1, "printed once, on one line");
		assert.ok(!web.err.some((line) => line.includes(code)), "stderr");
		assert.ok(!readDoc(ws).includes(code), "the doc and its Log");
		assert.ok(!git(ws.repo, "log", "--all", "-p").includes(code), "the commits");
		for (const line of web.out) if (!LINK.test(line)) assert.ok(!line.includes(code), line);
	});

	it("SIGINT/SIGTERM (an aborted signal) closes the board and returns while the loop waits; the decision is still there when the next start opens the store", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brigadev-runner-store-"));
		dirs.push(dir);
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser("Which storage?", OPTIONS)] : commitFile("t1.txt")) });
		runner = await openFixtureRunner(ws, worker, { storage: await openNodeJsonlStorage(dir, context) });
		const stop = new AbortController();
		const web = startWeb(runner, { signal: stop.signal });
		const link = await until(() => web.links()[0], "the printed link");
		const id = await until(async () => runner!.find(ws.docPath), "the loop");
		await until(async () => (await runner!.status(id)).decisions[0], "the parked decision");

		stop.abort();
		assert.equal(await web.done, 1);
		assert.ok(web.err.some((line) => /interrupted/.test(line) && line.includes(`start ${ws.docPath}`)), "says how to continue");
		await assert.rejects(fetch(`http://127.0.0.1:${link[2]}/`), "the server is closed");
		await runner.close();
		runner = undefined;

		runner = await openFixtureRunner(ws, worker, { storage: await openNodeJsonlStorage(dir, context) });
		const again = await runner.start(ws.docPath);
		assert.equal(again, id, "the same loop");
		assert.equal((await runner.status(id)).decisions[0].ticketId, "T1", "still waiting for the answer");
		assert.match(ticketLine(readDoc(ws), "T1"), /— blocked /);
	});

	it("a fresh link on request: each is a new one-time code, and the wiring is released when the loop ends", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const worker = makeWorker({ T1: (run) => (run === 1 ? [askUser("Which storage?", OPTIONS)] : commitFile("t1.txt")) });
		runner = await openFixtureRunner(ws, worker);
		let request: (() => void) | undefined;
		let released = false;
		const web = startWeb(runner, {
			wire: (newLink) => {
				request = newLink;
				return () => (released = true);
			},
		});
		const first = await until(() => web.links()[0], "the first link");
		assert.ok(request, "the process wiring got the new-link function");
		request!();
		const second = await until(() => web.links()[1], "the second link");
		assert.notEqual(second[3], first[3]);
		assert.equal(second[2], first[2], "the same server");

		const id = await until(async () => runner!.find(ws.docPath), "the loop");
		const decision = await until(async () => (await runner!.status(id)).decisions[0], "the parked decision");
		const { act } = await actor(second);
		assert.equal(await act({ action: "answer", id: decision.key, value: "SQLite" }), 202);
		assert.equal(await web.done, 0);
		assert.equal(released, true);
	});

	it("a loop that is not startable the way it was started is refused with the board closed", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		runner = await openFixtureRunner(ws, makeWorker({ T1: commitFile("t1.txt") }));
		const id = await runner.start(ws.docPath, { pr: false });
		assert.equal((await runner.wait(id)).status, "completed");
		const out: string[] = [];
		const err: string[] = [];
		const code = await startLoop(runner, ws.docPath, { out: (t) => out.push(t), err: (t) => err.push(t) }, { pr: true, web: { port: 0, lingerMs: 0 } });
		assert.equal(code, 1);
		assert.ok(err.some((line) => /Refusing to start/.test(line)));
		const link = out.map((line) => LINK.exec(line)).find(Boolean);
		if (link) await assert.rejects(fetch(`http://127.0.0.1:${link[2]}/`), "no server is left behind");
	});
});

describe("the process wiring", () => {
	const hostOf = (isTTY: boolean) => {
		const stdin = Object.assign(new EventEmitter(), { isTTY, paused: false, resume() { this.paused = false; }, pause() { this.paused = true; } });
		return Object.assign(new EventEmitter(), { stdin });
	};

	it("SIGUSR1 and Enter on a terminal ask for a new link; a pipe does not; releasing removes both", () => {
		let asked = 0;
		const tty = hostOf(true);
		const release = wireLinkRequests(() => asked++, tty as never);
		tty.emit("SIGUSR1");
		tty.stdin.emit("data", "\n");
		assert.equal(asked, 2);
		release();
		tty.emit("SIGUSR1");
		tty.stdin.emit("data", "\n");
		assert.equal(asked, 2, "released");
		assert.equal(tty.listenerCount("SIGUSR1") + tty.stdin.listenerCount("data"), 0);
		assert.equal(tty.stdin.paused, true, "stdin no longer keeps the terminal open");

		const pipe = hostOf(false);
		const releasePipe = wireLinkRequests(() => asked++, pipe as never);
		pipe.stdin.emit("data", "x\n");
		assert.equal(asked, 2, "stdin is only read when it is a terminal");
		assert.equal(pipe.stdin.listenerCount("data"), 0);
		pipe.emit("SIGUSR1");
		assert.equal(asked, 3);
		releasePipe();
	});

	it("a platform without SIGUSR1 still runs: Enter is enough", () => {
		const host = hostOf(true);
		host.on = () => {
			throw new Error("SIGUSR1 is not supported");
		};
		let asked = 0;
		const release = wireLinkRequests(() => asked++, host as never);
		host.stdin.emit("data", "\n");
		assert.equal(asked, 1);
		release();
	});

	it("SIGINT and SIGTERM abort the signal once, and a second one is left to the default (it kills)", () => {
		const host = new EventEmitter();
		const watch = watchInterrupt(host as never);
		assert.equal(watch.signal.aborted, false);
		host.emit("SIGTERM");
		assert.equal(watch.signal.aborted, true);
		assert.equal(host.listenerCount("SIGINT") + host.listenerCount("SIGTERM"), 0, "after the first, the default handler is back");
		watch.dispose();
	});
});

describe("CLI arguments and messages", () => {
	it("--port needs --web; the port is 0-65535 from --port or BRIGADEV_WEB_PORT; the usage names the board", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		for (const args of [["start", ws.docPath, "--port", "8123"], ["start", ws.docPath, "--web", "--port"], ["start", ws.docPath, "--web", "--port", "70000"], ["start", ws.docPath, "--web", "--port=abc"], ["start", ws.docPath, "--web", "--bogus"]]) {
			const result = await cli(args);
			assert.equal(result.code, 2, args.join(" "));
			assert.match(result.stderr, /usage: brigadev-runner start <feature-doc> \[--no-pr\] \[--web \[--port N\]\]/, args.join(" "));
		}
		let stderr = "";
		const bad = await main(["start", ws.docPath, "--web"], { ...env, BRIGADEV_WEB_PORT: "99999" }, { out: () => {}, err: (text) => (stderr += `${text}\n`) }, ws.repo);
		assert.equal(bad, 2);
		assert.match(stderr, /BRIGADEV_WEB_PORT/);
	});

	it("the refusals of start (doc, worktree) come before any board: nothing is served", async () => {
		const missing = await cli(["start", join(ws.root, "nope.md"), "--web"]);
		assert.equal(missing.code, 1);
		assert.ok(!LINK.test(missing.stdout));
		writeFileSync(ws.docPath, "# no tickets\n");
		const invalid = await cli(["start", ws.docPath, "--web"]);
		assert.equal(invalid.code, 1);
		assert.match(invalid.stderr, /cannot run unattended/);
		assert.ok(!LINK.test(invalid.stdout));
	});

	it("answer, pause, resume and merge refuse while a start holds the store, and the message points at the board and its new-link signal", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const path = storePathFor(ws.repo, env);
		mkdirSync(dirname(path), { recursive: true });
		runner = await openFixtureRunner(ws, makeWorker({ T1: [askUser("Which?", OPTIONS)] }), { storage: await openNodeSqliteStorage(path) });
		assert.equal((await runner.settle(await runner.start(ws.docPath))).status, "waiting");
		await runner.close();
		runner = undefined;
		const held = acquireStore(storePathFor(ws.repo, env));
		assert.equal(typeof held, "function");
		try {
			for (const args of [["answer", ws.docPath, "T1", "1"], ["pause", ws.docPath], ["resume", ws.docPath], ["merge", ws.docPath]]) {
				const result = await cli(args);
				assert.equal(result.code, 1, args[0]);
				assert.match(result.stderr, /`brigadev-runner start` is running on this store/);
				assert.match(result.stderr, /--web/, "names the flag");
				assert.match(result.stderr, /board/);
				assert.match(result.stderr, new RegExp(`kill -USR1 ${process.pid}`), "and the signal for a new link, with the holder's pid");
			}
		} finally {
			(held as () => void)();
		}
	});
});
