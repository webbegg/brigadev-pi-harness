// T7 (S6, R3): `brigadev-runner start <doc> --web [--port N]`: the board starts before the loop, its one-time link goes to stdout only, the process stays up while the loop
// waits for a person (so the board's answers reach it), it ends with the loop or on SIGINT/SIGTERM, and a fresh link is one Enter on the runner's own terminal away
// (never a signal, H1; only on a terminal, H2; not inside a terminal multiplexer, H3).
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { acquireStore, exitCodeOf, main, startLoop, storePathFor, watchInterrupt, wireLinkRequests, type WebStart } from "../src/cli.ts";
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

const TERMINAL = { stdinIsTTY: true, stdoutIsTTY: true };

async function cli(args: string[], extraEnv: Record<string, string | undefined> = {}, terminal = TERMINAL) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, { ...env, ...extraEnv }, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, ws.repo, terminal);
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
		assert.match(web.out[0], /press Enter in this terminal for a new one/);
		assert.ok(!/USR1|kill /.test(web.out[0]), "the link line suggests no signal");

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

describe("`start --web` exit codes and failures (R3-001)", () => {
	it("exitCodeOf: 0 for a loop that is done or merged; 1 for stalled, a PR loop that failed (needs you, then failed), a failed or aborted loop", () => {
		const completed = (result: object) => ({ status: "completed" as const, result: result as never });
		assert.equal(exitCodeOf(completed({ status: "done", tickets: [] })), 0);
		assert.equal(exitCodeOf(completed({ status: "merged", url: "u", number: 1, tickets: [] })), 0);
		assert.equal(exitCodeOf(completed({ status: "stalled", waiting: ["T2"] })), 1);
		assert.equal(exitCodeOf(completed({ status: "pr-failed", reason: "the PR loop needs a branch", tickets: [] })), 1);
		assert.equal(exitCodeOf({ status: "failed", error: { message: "boom" } }), 1);
		assert.equal(exitCodeOf({ status: "aborted" }), 1);
		assert.equal(exitCodeOf({ status: "orphaned" }), 1);
	});

	it("a stalled loop (a ticket out of attempts, its dependant waiting) ends the web start with exit 1, the outcome printed, and the board closed", async () => {
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: broken deps: none done: `exit 1` — pending", "- T2 [S2] inline: after deps: T1 done: `test -f t2.txt` — pending"]));
		runner = await openFixtureRunner(ws, makeWorker({ T1: commitFile("t1.txt"), T2: commitFile("t2.txt") }));
		const realStart = runner.start.bind(runner);
		runner.start = (docPath, options) => realStart(docPath, { ...options, maxAttempts: 1 });
		const web = startWeb(runner);
		const link = await until(() => web.links()[0], "the printed link");
		assert.equal(await web.done, 1);
		assert.ok(web.out.some((line) => /"status": "stalled"/.test(line)), "the outcome is printed");
		await assert.rejects(fetch(`http://127.0.0.1:${link[2]}/`), "the server is closed");
	});

	it("--port taken: exit 1 with a clear message, nothing started (no loop, no server of ours)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const busy = createServer();
		await new Promise<void>((resolve) => busy.listen(0, "127.0.0.1", resolve));
		const port = (busy.address() as { port: number }).port;
		try {
			runner = await openFixtureRunner(ws, makeWorker({ T1: commitFile("t1.txt") }));
			const out: string[] = [];
			const err: string[] = [];
			const code = await startLoop(runner, ws.docPath, { out: (t) => out.push(t), err: (t) => err.push(t) }, { web: { port, lingerMs: 0 } });
			assert.equal(code, 1);
			assert.match(err.join("\n"), new RegExp(`cannot start the board: port ${port} is already in use`));
			assert.match(err.join("\n"), /--port/, "says what to do");
			assert.deepEqual(out, [], "no link was printed");
			assert.equal(await runner.find(ws.docPath), undefined, "the loop was not started");
		} finally {
			await new Promise<void>((resolve) => busy.close(() => resolve()));
		}
	});
});

describe("the process wiring", () => {
	const hostOf = (isTTY: boolean) => {
		const stdin = Object.assign(new EventEmitter(), { isTTY, paused: false, resume() { this.paused = false; }, pause() { this.paused = true; } });
		return Object.assign(new EventEmitter(), { stdin });
	};

	it("Enter on a terminal asks for a new link; SIGUSR1 never does (the injected host's signal, and the real process's); a pipe does not; releasing removes the wiring", async () => {
		let asked = 0;
		const tty = hostOf(true);
		const release = wireLinkRequests(() => asked++, tty as never);
		assert.equal(tty.listenerCount("SIGUSR1"), 0, "nothing is listening for the signal");
		tty.emit("SIGUSR1");
		assert.equal(asked, 0, "a signal prints no link");
		tty.stdin.emit("data", "\n");
		assert.equal(asked, 1);
		release();
		tty.stdin.emit("data", "\n");
		assert.equal(asked, 1, "released");
		assert.equal(tty.stdin.listenerCount("data"), 0);
		assert.equal(tty.stdin.paused, true, "stdin no longer keeps the terminal open");

		const pipe = hostOf(false);
		const releasePipe = wireLinkRequests(() => asked++, pipe as never);
		pipe.stdin.emit("data", "x\n");
		assert.equal(asked, 1, "stdin is only read when it is a terminal");
		assert.equal(pipe.stdin.listenerCount("data"), 0);
		pipe.emit("SIGUSR1");
		assert.equal(asked, 1);
		releasePipe();

		// The real process, wired as `start --web` wires it: a SIGUSR1 sent to it (what `kill -USR1 $PPID` from a worker does) prints no link. The module's own
		// listener stays, so the signal still does not open Node's inspector (tests/inspector.test.ts) and does not kill the runner.
		const before = process.listenerCount("SIGUSR1");
		assert.ok(before >= 1, "the runner's no-op SIGUSR1 listener is installed");
		const real = wireLinkRequests(() => asked++);
		try {
			assert.equal(process.listenerCount("SIGUSR1"), before, "wiring adds no signal listener");
			process.kill(process.pid, "SIGUSR1");
			await new Promise((resolve) => setTimeout(resolve, 100));
			assert.equal(asked, 1, "no link for a real SIGUSR1");
		} finally {
			real();
		}
		assert.equal(process.listenerCount("SIGUSR1"), before, "and the runner's listener is still there afterwards");
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

describe("`--web` only on a terminal, and not inside a multiplexer (H2, H3)", () => {
	const storeExists = () => existsSync(storePathFor(ws.repo, env));
	const START = () => ["start", ws.docPath, "--web"];

	it("refuses with exit 2 before anything starts when stdin is not a terminal, when stdout is not, and when neither is: no link, no store, no server", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		for (const [terminal, says] of [
			[{ stdinIsTTY: false, stdoutIsTTY: true }, /stdin/],
			[{ stdinIsTTY: true, stdoutIsTTY: false }, /stdout/],
			[{ stdinIsTTY: false, stdoutIsTTY: false }, /stdin and stdout/],
		] as const) {
			const result = await cli(START(), {}, terminal);
			assert.equal(result.code, 2, JSON.stringify(terminal));
			assert.match(result.stderr, says);
			assert.match(result.stderr, /--web needs a terminal/);
			assert.match(result.stderr, /one-time link/, "says why: the link is written only to the terminal");
			assert.equal(result.stdout, "", "nothing printed, least of all a link");
			assert.equal(storeExists(), false, "no store opened");
		}
	});

	it("a terminal on both is accepted (it gets on to the checks that come after), and without --web a pipe is fine, as it always was", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const accepted = await cli(START());
		assert.equal(accepted.code, 1);
		assert.match(accepted.stderr, /not a linked git worktree/, "refused later, by the worktree rule: the terminal check passed");
		assert.ok(!/terminal/.test(accepted.stderr));
		const piped = await cli(["start", ws.docPath], {}, { stdinIsTTY: false, stdoutIsTTY: false });
		assert.equal(piped.code, 1);
		assert.match(piped.stderr, /not a linked git worktree/);
	});

	it("inside tmux, screen or zellij it refuses with exit 2 and says why (a pane can be read with capture-pane and typed into with send-keys by any process of yours, the worker included)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		for (const variable of ["TMUX", "STY", "ZELLIJ"]) {
			const result = await cli(START(), { [variable]: variable === "ZELLIJ" ? "0" : "/tmp/mux/default,123,0" });
			assert.equal(result.code, 2, variable);
			assert.match(result.stderr, new RegExp(`${variable}`), "names what it saw");
			assert.match(result.stderr, /capture-pane/);
			assert.match(result.stderr, /send-keys/);
			assert.match(result.stderr, /--web-in-multiplexer/, "and the override");
			assert.equal(result.stdout, "");
			assert.equal(storeExists(), false, `${variable}: nothing started`);
		}
		const empty = await cli(START(), { TMUX: "", STY: "" });
		assert.equal(empty.code, 1, "an empty variable is not a multiplexer");
		assert.match(empty.stderr, /not a linked git worktree/);
	});

	it("--web-in-multiplexer overrides it with a warning on stderr; it means nothing without --web", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const result = await cli([...START(), "--web-in-multiplexer"], { TMUX: "/tmp/mux/default,1,0" });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /warning: .*tmux.*capture-pane/i);
		assert.match(result.stderr, /not a linked git worktree/, "went on to the checks that come after");
		const quiet = await cli([...START(), "--web-in-multiplexer"]);
		assert.ok(!/warning/.test(quiet.stderr), "no warning outside a multiplexer");
		const alone = await cli(["start", ws.docPath, "--web-in-multiplexer"]);
		assert.equal(alone.code, 2);
		assert.match(alone.stderr, /usage: brigadev-runner start/);
	});
});

describe("CLI arguments and messages", () => {
	it("--port needs --web; the port is 0-65535 from --port or BRIGADEV_WEB_PORT; the usage names the board", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		for (const args of [["start", ws.docPath, "--port", "8123"], ["start", ws.docPath, "--web", "--port"], ["start", ws.docPath, "--web", "--port", "70000"], ["start", ws.docPath, "--web", "--port=abc"], ["start", ws.docPath, "--web", "--bogus"]]) {
			const result = await cli(args);
			assert.equal(result.code, 2, args.join(" "));
			assert.match(result.stderr, /usage: brigadev-runner start <feature-doc> \[--no-pr\] \[--web \[--port N\] \[--web-in-multiplexer\]\]\n/, args.join(" "));
		}
		let stderr = "";
		const bad = await main(["start", ws.docPath, "--web"], { ...env, BRIGADEV_WEB_PORT: "99999" }, { out: () => {}, err: (text) => (stderr += `${text}\n`) }, ws.repo, TERMINAL);
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
				assert.match(result.stderr, /press Enter in its terminal for a new link/, "and how to get a new link");
				assert.ok(!/USR1|kill /.test(result.stderr), "never a signal");
			}
		} finally {
			(held as () => void)();
		}
	});
});
