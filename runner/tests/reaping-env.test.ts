// H4 at the environment: `ReapingExecutionEnv` runs a command in its own process group and session with no terminal, and ends the whole group when the call is over,
// whichever way it ended. Real processes, polled with a bound; no fixed sleeps beyond the commands' own.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
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

async function run(env: ReapingExecutionEnv, command: string, options: { timeout?: number; signal?: AbortSignal } = {}) {
	let output = "";
	const context = options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;
	const result = await env.exec(command, { ...(options.timeout === undefined ? {} : { timeout: options.timeout }), onOutput: (text) => void (output += text) }, context);
	const pidsSeen = [...output.matchAll(/bg=(\d+)/g)].map((match) => Number(match[1]));
	pids.push(...pidsSeen);
	return { result, output, pids: pidsSeen };
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
		const { pids: started } = await run(envOf(), `sh -c 'trap "" TERM; sleep 30' & echo bg=$!`);
		assert.equal(started.length, 1);
		assert.equal(await goneWithin(started[0], 5_000), true, "SIGKILL after the grace");
	});

	it("ends the group after a failing call, a timeout, and an abort as well, and reports each as before", async () => {
		const env = envOf();
		const failed = await run(env, "sleep 30 & echo bg=$!; exit 3");
		assert.deepEqual([failed.result.ok, failed.result.ok && failed.result.value.exitCode], [true, 3], "a nonzero exit is still a result with its code");
		assert.equal(await goneWithin(failed.pids[0], 5_000), true, "after a failure");

		const timedOut = await run(env, "sleep 30 & echo bg=$!; sleep 30", { timeout: 1 });
		assert.equal(timedOut.result.ok, false);
		assert.equal(!timedOut.result.ok && timedOut.result.error.code, "timeout");
		assert.equal(await goneWithin(timedOut.pids[0], 5_000), true, "after a timeout");

		const controller = new AbortController();
		const pending = run(env, "sleep 30 & echo bg=$!; sleep 30", { signal: controller.signal });
		await new Promise((resolve) => setTimeout(resolve, 300));
		controller.abort();
		const aborted = await pending;
		assert.equal(!aborted.result.ok && aborted.result.error.code, "aborted");
		assert.equal(await goneWithin(aborted.pids[0], 5_000), true, "after an abort");
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
		const running = run(env, "sleep 30 & echo bg=$!; sleep 30");
		await new Promise((resolve) => setTimeout(resolve, 300));
		await env.cleanup(BACKGROUND_CONTEXT);
		const done = await running;
		assert.ok(done.pids.length > 0);
		assert.equal(await goneWithin(done.pids[0], 5_000), true);
		assert.doesNotThrow(() => reapGroup(2_147_483_000, 10), "no such group");
		assert.doesNotThrow(() => reapGroup(0, 10));
		assert.doesNotThrow(() => reapGroup(1, 10), "never signals init's group");
		assert.equal(live(process.pid), true, "and never this process");
	});
});
