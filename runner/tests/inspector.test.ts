// SIGUSR1 must not open Node's inspector in the runner: a worker's `kill -USR1 $PPID` would otherwise get an unauthenticated debugger on 127.0.0.1, so code
// running in the runner, with the real environment (tokens, gh login) the containment keeps from the worker.
//
// The inspector says "Debugger listening on ws://..." on stderr when it opens. `--inspect-port=0` picks a free port, so nothing here races for one. Each child
// is checked against a plain child in the same test, which must open: a slow machine fails the control instead of passing the protected case by accident.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(new URL("../src/cli.ts", import.meta.url).pathname).href;
const LISTENING = /Debugger listening on ws:/;

/** Start node with `flags` running `preload`, send SIGUSR1 once it is ready, and say whether the inspector opened within `waitMs`. */
async function inspectorOpens(flags: string[], preload: string, waitMs: number): Promise<boolean> {
	const child = spawn(process.execPath, ["--inspect-port=0", ...flags, "--input-type=module", "-e", `${preload}\nprocess.stdout.write("ready\\n");\nsetInterval(() => {}, 1000);`], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stderr = "";
	child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
	try {
		await new Promise<void>((done, fail) => {
			child.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && done());
			child.on("exit", (code) => fail(new Error(`child exited ${code}: ${stderr}`)));
		});
		process.kill(child.pid!, "SIGUSR1");
		const end = Date.now() + waitMs;
		while (Date.now() < end && !LISTENING.test(stderr)) await new Promise((r) => setTimeout(r, 25));
		return LISTENING.test(stderr);
	} finally {
		child.kill("SIGKILL");
	}
}

test("SIGUSR1 opens no inspector in a process that loaded the runner CLI (a plain node process, the control, does open one)", async () => {
	assert.equal(await inspectorOpens([], "", 10_000), true, "control: a plain node process opens its inspector on SIGUSR1");
	assert.equal(await inspectorOpens([], `await import(${JSON.stringify(CLI)});`, 1_500), false);
});

test("`--disable-sigusr1`, which `npm start` passes, also keeps it closed", async () => {
	assert.equal(await inspectorOpens([], "", 10_000), true, "control");
	assert.equal(await inspectorOpens(["--disable-sigusr1"], "", 1_500), false);
});
