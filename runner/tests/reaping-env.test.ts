// H4 at the environment: `ReapingExecutionEnv` runs a command in its own process group and session with no terminal, and ends the whole group when the call is over,
// whichever way it ended, and also when the runner ends inside the SIGTERM-to-SIGKILL grace (R4-001). Real processes, polled with a bound: a call is waited for by what it
// prints (`bg=<pid>`), never by a clock, and liveness is a signal-0 probe (no `ps`).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import * as reaping from "../src/reaping-env.ts";
import { ReapingExecutionEnv, reapGroup } from "../src/reaping-env.ts";
import { goneWithin, live } from "./fixture.ts";

let dir: string;
let pids: number[] = [];
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-reap-")));
});
afterEach(() => {
	for (const pid of pids) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Gone.
		}
	}
	pids = [];
	rmSync(dir, { recursive: true, force: true });
});

const envOf = (graceMs = 50) => new ReapingExecutionEnv({ cwd: dir, shellEnv: { ...process.env, BRIGADE_ENV_MARK: "contained" }, graceMs });

const MARKER_MS = 20_000;

/**
 * A background shell that ignores SIGTERM, with its pid as `bg=<pid>`. The call waits (bounded) until the shell has installed its trap (`mark` exists): without that the
 * call returns, and the group is sent SIGTERM, before the trap is set, and the shell simply dies of it, which would test nothing.
 */
const ignoresTerm = (mark: string) => `sh -c 'trap "" TERM; : > ${mark}; sleep 30' & echo bg=$!; n=0; while [ ! -e ${mark} ] && [ $n -lt 1000 ]; do n=$((n+1)); sleep 0.01; done`;

/** A call in flight: what it printed so far, and its result. */
function start(env: ReapingExecutionEnv, command: string, options: { timeout?: number; signal?: AbortSignal } = {}) {
	const seen = { output: "" };
	const context = options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
	const finished = env.exec(command, { ...(options.timeout === undefined ? {} : { timeout: options.timeout }), onOutput: (text) => void (seen.output += text) }, context).then((result) => {
		const started = [...seen.output.matchAll(/bg=(\d+)/g)].map((match) => Number(match[1]));
		pids.push(...started);
		return { result, output: seen.output, pids: started };
	});
	return { seen, finished };
}

async function run(env: ReapingExecutionEnv, command: string, options: { timeout?: number; signal?: AbortSignal } = {}) {
	return start(env, command, options).finished;
}

/** The pid a running call printed as `bg=<pid>`: waits for the marker (bounded), and fails when it never came, so no test passes without a process to check. */
async function pidOf(call: { seen: { output: string } }): Promise<number> {
	const end = Date.now() + MARKER_MS;
	for (;;) {
		const found = /bg=(\d+)/.exec(call.seen.output);
		if (found) {
			pids.push(Number(found[1]));
			return Number(found[1]);
		}
		assert.ok(Date.now() < end, `no bg=<pid> within ${MARKER_MS} ms: ${JSON.stringify(call.seen.output)}`);
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

describe("ReapingExecutionEnv (H4)", () => {
	it("kills a background process when the call returns: `&`, `nohup … &`, and a grandchild", async () => {
		const env = envOf();
		for (const command of ["sleep 30 & echo bg=$!", "nohup sleep 30 >/dev/null 2>&1 & echo bg=$!", "(sleep 30 & echo bg=$!)", "sh -c 'sleep 30 & echo bg=$!; sleep 30 &' & wait $!; true"]) {
			const { result, pids: started } = await run(env, command);
			assert.equal(result.ok, true, `${command}: ${JSON.stringify(result)}`);
			assert.ok(started.length > 0, command);
			for (const pid of started) assert.equal(await goneWithin(pid, 5_000), true, `${command}: ${pid} outlived the call`);
		}
	});

	it("kills what ignores SIGTERM too, after the grace", async () => {
		const { pids: started } = await run(envOf(), ignoresTerm("ready"));
		assert.equal(started.length, 1);
		assert.equal(await goneWithin(started[0], 5_000), true, "SIGKILL after the grace");
	});

	it("ends the group after a failing call, a timeout, and an abort as well, and reports each as before", async () => {
		const env = envOf();
		const failed = await run(env, "sleep 30 & echo bg=$!; exit 3");
		assert.deepEqual([failed.result.ok, failed.result.ok && failed.result.value.exitCode], [true, 3], "a nonzero exit is still a result with its code");
		assert.equal(failed.pids.length, 1);
		assert.equal(await goneWithin(failed.pids[0], 5_000), true, "after a failure");

		const timedOut = await run(env, "sleep 30 & echo bg=$!; sleep 30", { timeout: 1 });
		assert.equal(timedOut.result.ok, false);
		assert.equal(!timedOut.result.ok && timedOut.result.error.code, "timeout");
		assert.equal(timedOut.pids.length, 1, "the shell printed its marker inside the timeout");
		assert.equal(await goneWithin(timedOut.pids[0], 5_000), true, "after a timeout");

		const controller = new AbortController();
		const call = start(env, "sleep 30 & echo bg=$!; sleep 30", { signal: controller.signal });
		const background = await pidOf(call); // the call is running and has started its background process
		assert.equal(live(background), true, "the marker names a running process");
		controller.abort();
		const aborted = await call.finished;
		assert.equal(!aborted.result.ok && aborted.result.error.code, "aborted");
		assert.equal(await goneWithin(background, 5_000), true, "after an abort");
	});

	it("a call runs with its own cwd and the contained environment, in its own session with no controlling terminal and nothing on stdin", async () => {
		const { result, output } = await run(envOf(), 'pwd; echo "mark=$BRIGADE_ENV_MARK"; tty; echo "pgid=$(ps -o pgid= -p $$ | tr -d " ") me=$$"; ps -o tty= -p $$; cat; echo after-cat');
		assert.equal(result.ok && result.value.exitCode, 0);
		assert.match(output, new RegExp(`^${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "m"), "cwd");
		assert.match(output, /mark=contained/);
		assert.match(output, /not a tty/);
		const own = /pgid=(\d+) me=(\d+)/.exec(output)!;
		assert.equal(own[1], own[2], "the shell leads its own process group");
		assert.match(output, /^\s*\?+\s*$/m, "no controlling terminal");
		assert.match(output, /after-cat/, "stdin is closed, not the terminal: `cat` ends at once");
	});

	it("cleanup() still kills what is running, and a group that is gone is no error", async () => {
		const env = envOf();
		const call = start(env, "sleep 30 & echo bg=$!; sleep 30");
		const background = await pidOf(call);
		await env.cleanup(BACKGROUND_CONTEXT);
		await call.finished;
		assert.equal(await goneWithin(background, 5_000), true);
		assert.doesNotThrow(() => reapGroup(2_147_483_000, 10), "no such group");
		assert.doesNotThrow(() => reapGroup(0, 10));
		assert.doesNotThrow(() => reapGroup(1, 10), "never signals init's group");
		assert.equal(live(process.pid), true, "and never this process");
	});
});

describe("a process that ignores SIGTERM does not outlive the runner (R4-001)", () => {
	// The grace is far longer than any test: only a flush can end the process inside it.
	const LONG_GRACE_MS = 60_000;

	it("env.cleanup() ends the groups already sent SIGTERM at once (SIGKILL now, not after the grace)", async () => {
		const env = envOf(LONG_GRACE_MS);
		const { pids: started } = await run(env, ignoresTerm("ready"));
		assert.equal(started.length, 1, "the call returned and its marker was captured");
		await new Promise((resolve) => setTimeout(resolve, 100)); // it has had its SIGTERM, and ignores it
		assert.equal(live(started[0]), true, "it ignored SIGTERM and the grace has not run out");
		await env.cleanup(BACKGROUND_CONTEXT);
		assert.equal(await goneWithin(started[0], 5_000), true, "cleanup flushed the pending SIGKILL");
	});

	it("cleanup() flushes only its own environment's pending kills", async () => {
		const mine = envOf(LONG_GRACE_MS);
		const other = envOf(LONG_GRACE_MS);
		const a = await run(mine, ignoresTerm("ready-a"));
		const b = await run(other, ignoresTerm("ready-b"));
		assert.deepEqual([a.pids.length, b.pids.length], [1, 1]);
		await mine.cleanup(BACKGROUND_CONTEXT);
		assert.equal(await goneWithin(a.pids[0], 5_000), true, "its own");
		assert.equal(live(b.pids[0]), true, "the other environment's grace is not cut short");
		await other.cleanup(BACKGROUND_CONTEXT);
		assert.equal(await goneWithin(b.pids[0], 5_000), true);
	});

	it("a process that exits right after the call, without closing anything (the runner's `process.exit`), leaves nothing behind: the 'exit' hook sends the SIGKILL", async () => {
		const child = spawn(process.execPath, [join(import.meta.dirname, "reaping-exit-child.ts"), dir, String(LONG_GRACE_MS)], { stdio: ["ignore", "pipe", "inherit"] });
		let stdout = "";
		child.stdout.on("data", (chunk) => void (stdout += chunk));
		const code = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => (child.kill("SIGKILL"), reject(new Error("the exiting process did not end"))), 30_000);
			child.once("close", (status) => (clearTimeout(timer), resolve(status)));
		});
		const found = /bg=(\d+)/.exec(stdout);
		assert.ok(found, `the child printed no marker: ${JSON.stringify(stdout)}`);
		const background = Number(found[1]);
		pids.push(background);
		assert.equal(code, 0);
		assert.equal(await goneWithin(background, 5_000), true, "a SIGTERM-ignoring background process outlived the runner");
	});

	it("registers one 'exit' listener for the whole process, not one per environment or per call", async () => {
		const before = process.listenerCount("exit");
		const env = envOf(LONG_GRACE_MS);
		for (let n = 0; n < 3; n += 1) await run(env, ignoresTerm(`ready-${n}`));
		await run(envOf(LONG_GRACE_MS), "sleep 30 & echo bg=$!");
		assert.ok(process.listenerCount("exit") - before <= 1, `${process.listenerCount("exit") - before} listeners were added`);
		await env.cleanup(BACKGROUND_CONTEXT);
	});
});

describe("the hook into pi-durable is checked against the installed version (F6)", () => {
	it("each command goes through `activeChildPids`: add when it starts, delete when it settles (the pid that is reaped)", async () => {
		await assert.doesNotReject(reaping.verifyReaping(envOf(), BACKGROUND_CONTEXT));
	});

	it("fails closed when the base class keeps the field but stops using it for its commands", async () => {
		class Untracked extends ReapingExecutionEnv {
			// Runs the command through NodeExecutionEnv's own exec on an environment whose set is not ours: the pid never passes through `this.activeChildPids`.
			override exec(command: string, options: Parameters<NodeExecutionEnv["exec"]>[1], context: Parameters<NodeExecutionEnv["exec"]>[2]) {
				return new NodeExecutionEnv({ cwd: dir }).exec(command, options, context);
			}
		}
		await assert.rejects(reaping.verifyReaping(new Untracked({ cwd: dir }), BACKGROUND_CONTEXT), /no longer tracks/);
	});
});
