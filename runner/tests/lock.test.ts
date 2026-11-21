// B4: the store lock is an OS lock that dies with its process. With the pid-file lock, twelve racers against a lock left by a dead process produced two or three
// holders (the stale-lock takeover was check-then-remove-then-create), and the release threw ENOENT once the file was gone.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { acquireStore, lockHolder } from "../src/cli.ts";

const CHILD = fileURLToPath(new URL("./lock-child.ts", import.meta.url));
let dir: string;
beforeEach(() => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-lock-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Child {
	output: Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null }>;
	ready: Promise<void>;
}

function child(storePath: string, goFile: string, mode: "hold" | "die", holdMs = 0): Child {
	const process_ = spawn(process.execPath, [CHILD, storePath, goFile, mode, String(holdMs)], { stdio: ["ignore", "pipe", "inherit"] });
	let stdout = "";
	let markReady!: () => void;
	const ready = new Promise<void>((resolve) => (markReady = resolve));
	process_.stdout.on("data", (chunk) => {
		stdout += chunk;
		if (stdout.includes("READY")) markReady();
	});
	const output = new Promise<{ stdout: string; code: number | null; signal: NodeJS.Signals | null }>((resolve) => process_.on("close", (code, signal) => resolve({ stdout, code, signal })));
	return { output, ready };
}

describe("store lock (B4)", () => {
	it("N processes racing for a lock left by a dead process: exactly one holds it per round, and its double release does not throw", async () => {
		const store = join(dir, "runner.sqlite");
		const racers = 10;
		for (let round = 1; round <= 3; round++) {
			// A process takes the lock and dies without releasing it: it leaves the lock (and its pid file) behind.
			const goDead = join(dir, `go-dead-${round}`);
			const dead = child(store, goDead, "die");
			await dead.ready;
			writeFileSync(goDead, "");
			const died = await dead.output;
			assert.equal(died.signal, "SIGKILL", `round ${round}: the holder died without releasing`);

			const go = join(dir, `go-${round}`);
			const children = Array.from({ length: racers }, () => child(store, go, "hold", 1500));
			await Promise.all(children.map((entry) => entry.ready));
			writeFileSync(go, "");
			const results = await Promise.all(children.map((entry) => entry.output));
			const holders = results.filter((result) => result.stdout.includes("HELD"));
			const busy = results.filter((result) => result.stdout.includes("BUSY"));
			assert.equal(holders.length, 1, `round ${round}: exactly one holder, got ${holders.length}`);
			assert.equal(busy.length, racers - 1, `round ${round}`);
			assert.ok(holders[0].stdout.includes("RELEASED") && holders[0].code === 0, `round ${round}: releasing twice did not throw: ${holders[0].stdout} (exit ${holders[0].code})`);
			assert.ok(results.every((result) => result.code === 0), `round ${round}: every process exited cleanly`);
		}
	});

	it("is not re-entrant, release is idempotent, and the holder is known while it is held", () => {
		const store = join(dir, "runner.sqlite");
		assert.equal(lockHolder(store), undefined, "nothing holds a store that was never locked");
		const release = acquireStore(store);
		assert.equal(typeof release, "function");
		assert.equal(lockHolder(store), process.pid);
		assert.equal(acquireStore(store), process.pid, "a second acquire in the same process is refused with the holder's pid");
		(release as () => void)();
		assert.doesNotThrow(() => (release as () => void)(), "releasing twice");
		assert.equal(lockHolder(store), undefined);
		const again = acquireStore(store);
		assert.equal(typeof again, "function", "free again after the release");
		(again as () => void)();
	});

	it("a pid file left by the earlier lock implementation (a number in `<store>.lock`, not a database) is replaced, not a crash", () => {
		const store = join(dir, "runner.sqlite");
		writeFileSync(`${store}.lock`, "12345");
		assert.equal(lockHolder(store), undefined);
		writeFileSync(`${store}.lock`, "12345");
		const release = acquireStore(store);
		assert.equal(typeof release, "function");
		(release as () => void)();
	});

	it("a lock held by another process shows that process's pid (or -1 while it has not written it yet), and is free once that process is gone", async () => {
		const store = join(dir, "runner.sqlite");
		const go = join(dir, "go");
		const holder = child(store, go, "hold", 1500);
		await holder.ready;
		writeFileSync(go, "");
		const deadline = Date.now() + 10_000;
		while (lockHolder(store) === undefined && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		const seen = lockHolder(store);
		assert.ok(seen !== undefined && seen !== process.pid, `held by another process: ${seen}`);
		assert.notEqual(typeof acquireStore(store), "function", "not acquirable while the other process holds it");
		await holder.output;
		assert.equal(lockHolder(store), undefined, "released when the process ended");
	});
});
