// lib/bg-processes.ts: the background process manager. Unit tests drive it with a fake child and fake timers;
// the real-process tests at the end start real shells (POSIX only) and clean up every process they start.

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { BG_KILL_GRACE_MS, BgError, createBgProcesses, LEFTOVER_NOTE, MAX_RUNNING, MAX_SETTLED_KEPT, shellEnvironment, TailBuffer, type BgChild, type BgProcessDeps } from "../lib/bg-processes.ts";
import { CLOSE_DRAIN_MS, createChildTracker, KILL_GRACE_MS, type ProcessEntry } from "../lib/child-run.ts";

class FakeChild extends EventEmitter {
	pid: number | undefined;
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	signals: string[] = [];
	kill(signal?: string): boolean {
		this.signals.push(signal ?? "SIGTERM");
		return true;
	}
}

interface Timer {
	fn: () => void;
	ms: number;
	cleared: boolean;
	fired: boolean;
}

function fakeTimers() {
	const timers: Timer[] = [];
	return {
		timers,
		setTimer: (fn: () => void, ms: number) => {
			const timer: Timer = { fn, ms, cleared: false, fired: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle: unknown) => void ((handle as Timer).cleared = true),
		pending: () => timers.filter((t) => !t.cleared && !t.fired),
		/** Fires the pending timer(s) with this delay. */
		fire(ms: number) {
			for (const timer of timers.filter((t) => !t.cleared && !t.fired && t.ms === ms)) {
				timer.fired = true;
				timer.fn();
			}
		},
	};
}

function harness(overrides: Partial<BgProcessDeps> = {}) {
	const children: FakeChild[] = [];
	const spawns: Array<{ file: string; args: string[]; options: any }> = [];
	const groupKills: Array<[number, string]> = [];
	const pidKills: Array<[number, string]> = [];
	const timers = fakeTimers();
	const clock = { now: 1000 };
	const manager = createBgProcesses({
		spawn: (file, args, options) => {
			const child = new FakeChild();
			child.pid = 100 + children.length;
			children.push(child);
			spawns.push({ file, args, options });
			return child as unknown as BgChild;
		},
		shell: () => ({ shell: "/bin/test-sh", args: ["-c"] }),
		env: () => ({ PATH: "/x" }),
		now: () => clock.now,
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
		killGroup: (pid, signal) => void groupKills.push([pid, signal]),
		killPid: (pid, signal) => void pidKills.push([pid, signal]),
		listProcesses: () => [],
		selfPid: 1,
		platform: "linux",
		tracker: createChildTracker({ listProcesses: () => [] }),
		...overrides,
	});
	return { manager, children, spawns, groupKills, pidKills, timers, clock };
}

describe("TailBuffer", () => {
	it("keeps everything under the cap", () => {
		const buffer = new TailBuffer(100);
		buffer.push("hello ");
		buffer.push("world");
		assert.deepEqual({ text: buffer.text(), total: buffer.totalBytes, truncated: buffer.truncatedBytes }, { text: "hello world", total: 11, truncated: 0 });
	});

	it("drops the oldest output past the cap and counts it", () => {
		const buffer = new TailBuffer(10);
		for (const chunk of ["aaaa", "bbbb", "cccc"]) buffer.push(chunk);
		assert.equal(buffer.text(), "bbbbcccc");
		assert.equal(buffer.truncatedBytes, 4);
		assert.equal(buffer.totalBytes, 12);
	});

	it("trims one chunk larger than the cap to its tail, on a character boundary", () => {
		const buffer = new TailBuffer(10);
		buffer.push("old");
		buffer.push(`${"x".repeat(20)}ééé`);
		assert.ok(Buffer.byteLength(buffer.text()) <= 10);
		assert.ok(buffer.text().endsWith("ééé"));
		assert.ok(!buffer.text().includes("\uFFFD"));
		assert.equal(buffer.totalBytes, 3 + 20 + 6);
		assert.equal(buffer.totalBytes - buffer.truncatedBytes, Buffer.byteLength(buffer.text()));
	});

	it("is capped at 256 KB per process by default", () => {
		const { manager, children } = harness();
		const snap = manager.start({ command: "x", cwd: "/w" });
		children[0].stdout.emit("data", Buffer.from("a".repeat(300 * 1024)));
		const after = manager.get(snap.id)!;
		assert.equal(Buffer.byteLength(after.output), 256 * 1024);
		assert.equal(after.totalBytes, 300 * 1024);
		assert.equal(after.truncatedBytes, 44 * 1024);
	});
});

describe("starting", () => {
	it("runs the command string through the shell, detached, with no stdin, in the given cwd and env", () => {
		const { manager, spawns } = harness();
		const snap = manager.start({ command: "npm run dev", cwd: "/proj", name: "dev server" });
		assert.equal(spawns.length, 1);
		assert.equal(spawns[0].file, "/bin/test-sh");
		assert.deepEqual(spawns[0].args, ["-c", "npm run dev"]);
		assert.equal(spawns[0].options.cwd, "/proj");
		assert.deepEqual(spawns[0].options.stdio, ["ignore", "pipe", "pipe"]);
		assert.equal(spawns[0].options.detached, true);
		assert.deepEqual(spawns[0].options.env, { PATH: "/x" });
		assert.deepEqual({ id: snap.id, name: snap.name, state: snap.state, pid: snap.pid, cwd: snap.cwd, command: snap.command }, { id: "bg-1", name: "dev server", state: "running", pid: 100, cwd: "/proj", command: "npm run dev" });
	});

	it("is not detached on win32, and names an unnamed process after its command", () => {
		const { manager, spawns } = harness({ platform: "win32" });
		const snap = manager.start({ command: "npm run dev -- --port 3000", cwd: "/proj" });
		assert.equal(spawns[0].options.detached, false);
		assert.equal(snap.name, "npm run dev -- --port 3000");
		assert.ok(manager.start({ command: "x".repeat(200), cwd: "/p" }).name.length <= 60);
	});

	it("numbers processes in start order", () => {
		const { manager } = harness();
		assert.deepEqual([1, 2, 3].map(() => manager.start({ command: "x", cwd: "/w" }).id), ["bg-1", "bg-2", "bg-3"]);
	});

	it("rejects an empty command and a stdin-fed shell", () => {
		const { manager, spawns } = harness();
		assert.throws(() => manager.start({ command: "   ", cwd: "/w" }), BgError);
		const stdinShell = harness({ shell: () => ({ shell: "bash.exe", args: ["-s"], commandTransport: "stdin" }) });
		assert.throws(() => stdinShell.manager.start({ command: "x", cwd: "/w" }), /stdin/);
		assert.equal(spawns.length, 0);
	});

	it("allows at most 8 running; a settled one frees a slot", () => {
		const { manager, children } = harness();
		assert.equal(MAX_RUNNING, 8);
		for (let i = 0; i < MAX_RUNNING; i++) manager.start({ command: `c${i}`, cwd: "/w" });
		assert.throws(() => manager.start({ command: "ninth", cwd: "/w" }), /at most 8|Too many/i);
		assert.equal(manager.runningCount(), 8);
		children[0].emit("close", 0, null);
		assert.equal(manager.runningCount(), 7);
		assert.equal(manager.start({ command: "ninth", cwd: "/w" }).state, "running");
	});

	it("reports a spawn that throws as a BgError and keeps no entry", () => {
		const { manager } = harness({
			spawn: () => {
				throw new Error("EAGAIN");
			},
		});
		assert.throws(() => manager.start({ command: "x", cwd: "/w" }), /EAGAIN/);
		assert.equal(manager.list().length, 0);
	});

	it("registers each running process with the child tracker and releases it when it settles", () => {
		const tracker = createChildTracker({ listProcesses: () => [] });
		const { manager, children } = harness({ tracker });
		manager.start({ command: "a", cwd: "/w" });
		manager.start({ command: "b", cwd: "/w" });
		assert.equal(tracker.size(), 2);
		children[0].emit("close", 0, null);
		assert.equal(tracker.size(), 1);
		assert.equal(manager.tracker, tracker);
	});
});

describe("output and exit", () => {
	it("keeps stdout and stderr in one stream, decoding characters split across chunks", () => {
		const { manager, children } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		const euro = Buffer.from("€");
		children[0].stdout.emit("data", Buffer.concat([Buffer.from("a "), euro.subarray(0, 1)]));
		children[0].stdout.emit("data", euro.subarray(1));
		children[0].stderr.emit("data", "oops\n");
		assert.equal(manager.get(id)!.output, "a €oops\n");
	});

	it("settles done on exit code 0 once the output closed", () => {
		const { manager, children, clock } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		clock.now = 6000;
		children[0].emit("exit", 0, null);
		assert.equal(manager.get(id)!.state, "running", "waits for the output to close");
		children[0].emit("close", 0, null);
		const snap = manager.get(id)!;
		assert.deepEqual({ state: snap.state, exitCode: snap.exitCode, endedAt: snap.endedAt, startedAt: snap.startedAt }, { state: "done", exitCode: 0, endedAt: 6000, startedAt: 1000 });
	});

	it("settles failed on a non-zero exit and on an unrequested signal", () => {
		const { manager, children } = harness();
		const a = manager.start({ command: "a", cwd: "/w" });
		const b = manager.start({ command: "b", cwd: "/w" });
		children[0].emit("close", 2, null);
		children[1].emit("close", null, "SIGSEGV");
		assert.deepEqual({ state: manager.get(a.id)!.state, code: manager.get(a.id)!.exitCode }, { state: "failed", code: 2 });
		assert.deepEqual({ state: manager.get(b.id)!.state, signal: manager.get(b.id)!.signal }, { state: "failed", signal: "SIGSEGV" });
	});

	it("settles failed with the error when the process cannot start", () => {
		const { manager, children } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].emit("error", new Error("spawn ENOENT"));
		const snap = manager.get(id)!;
		assert.equal(snap.state, "failed");
		assert.match(snap.error ?? "", /ENOENT/);
		assert.equal(manager.runningCount(), 0);
	});

	it("settles after the drain bound when a descendant holds the pipes open: the group is ended and the process is reported killed, with a note", () => {
		const { manager, children, timers, groupKills } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].emit("exit", 0, null);
		assert.equal(manager.get(id)!.state, "running");
		assert.equal(CLOSE_DRAIN_MS, 1000);
		timers.fire(CLOSE_DRAIN_MS);
		assert.deepEqual(groupKills, [[100, "SIGKILL"]]);
		const snap = manager.get(id)!;
		assert.equal(snap.state, "killed");
		assert.equal(snap.exitCode, 0);
		assert.equal(snap.error, LEFTOVER_NOTE);
		assert.match(LEFTOVER_NOTE, /left running after the shell exited/);
	});

	it("an empty group at the drain (nothing was left running) keeps the real outcome", () => {
		const { manager, children, timers } = harness({
			killGroup: () => {
				throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
			},
		});
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].emit("exit", 0, null);
		timers.fire(CLOSE_DRAIN_MS);
		assert.deepEqual({ state: manager.get(id)!.state, error: manager.get(id)!.error }, { state: "done", error: undefined });
	});

	it("ignores output after it settled", () => {
		const { manager, children } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].stdout.emit("data", "one");
		children[0].emit("close", 0, null);
		children[0].stdout.emit("data", "two");
		assert.equal(manager.get(id)!.output, "one");
	});

	it("tells subscribers about state changes and (bounded) output", () => {
		const { manager, children, timers } = harness();
		const events: string[] = [];
		const stop = manager.subscribe((event) => events.push(event));
		manager.start({ command: "x", cwd: "/w" });
		children[0].stdout.emit("data", "a");
		children[0].stdout.emit("data", "b");
		children[0].stdout.emit("data", "c");
		assert.deepEqual(events, ["state", "output"], "output notices are throttled");
		timers.fire(100);
		assert.deepEqual(events, ["state", "output", "output"], "the throttle ends with one notice for what it held back");
		timers.fire(100);
		children[0].stdout.emit("data", "d");
		assert.deepEqual(events, ["state", "output", "output", "output"]);
		children[0].emit("close", 0, null);
		assert.equal(events.at(-1), "state");
		stop();
		const before = events.length;
		manager.start({ command: "y", cwd: "/w" });
		assert.equal(events.length, before);
	});
});

describe("killing", () => {
	it("SIGTERMs the process group, then SIGKILLs after 5 s, and settles as killed", async () => {
		const { manager, children, timers, groupKills } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		assert.equal(BG_KILL_GRACE_MS, KILL_GRACE_MS);
		assert.equal(KILL_GRACE_MS, 5000);
		const killing = manager.kill(id);
		assert.deepEqual(groupKills, [[100, "SIGTERM"]]);
		assert.ok(timers.pending().some((t) => t.ms === 5000));
		timers.fire(5000);
		assert.deepEqual(groupKills, [[100, "SIGTERM"], [100, "SIGKILL"]]);
		children[0].emit("close", null, "SIGKILL");
		const snap = (await killing)!;
		assert.deepEqual({ state: snap.state, signal: snap.signal }, { state: "killed", signal: "SIGKILL" });
	});

	it("does not escalate when the process exited after SIGTERM", async () => {
		const { manager, children, timers, groupKills } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		const killing = manager.kill(id);
		children[0].emit("close", null, "SIGTERM");
		assert.equal((await killing)!.state, "killed");
		assert.equal(timers.pending().length, 0, "every timer was cleared");
		assert.deepEqual(groupKills, [[100, "SIGTERM"]]);
	});

	it("settles by force, bounded, when the process cannot be reaped", async () => {
		const { manager, timers } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		const killing = manager.kill(id);
		timers.fire(5000);
		timers.fire(5000 + CLOSE_DRAIN_MS + 1000);
		const snap = (await killing)!;
		assert.equal(snap.state, "killed");
		assert.match(snap.error ?? "", /did not exit/);
		assert.equal(manager.runningCount(), 0);
	});

	it("a process that finished on its own before the signal keeps its real outcome", async () => {
		const { manager, children } = harness();
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].emit("close", 0, null);
		const snap = (await manager.kill(id))!;
		assert.equal(snap.state, "done");
	});

	it("returns undefined for an unknown id", async () => {
		assert.equal(await harness().manager.kill("bg-9"), undefined);
	});

	it("falls back to the child itself when its group cannot be signalled, and on win32", async () => {
		const noGroup = harness({
			killGroup: () => {
				throw new Error("ESRCH");
			},
		});
		const a = noGroup.manager.start({ command: "x", cwd: "/w" });
		void noGroup.manager.kill(a.id);
		assert.deepEqual(noGroup.children[0].signals, ["SIGTERM"]);
		const win = harness({ platform: "win32" });
		const b = win.manager.start({ command: "x", cwd: "/w" });
		void win.manager.kill(b.id);
		assert.deepEqual(win.groupKills, []);
		assert.deepEqual(win.children[0].signals, ["SIGTERM"]);
	});

	it("lists the descendants before SIGTERM and SIGKILLs the ones in their own group when the shell exits early", async () => {
		let table: ProcessEntry[] = [
			{ pid: 100, ppid: 1, pgid: 100 },
			{ pid: 200, ppid: 100, pgid: 200 },
			{ pid: 1, ppid: 0, pgid: 1 },
		];
		const { manager, children, groupKills, timers } = harness({ listProcesses: () => table });
		const { id } = manager.start({ command: "x", cwd: "/w" });
		const killing = manager.kill(id);
		assert.deepEqual(groupKills, [[100, "SIGTERM"]], "SIGTERM goes to the shell's group only");
		table = [{ pid: 1, ppid: 0, pgid: 1 }]; // the shell is gone: the parent chain no longer exists
		children[0].emit("exit", null, "SIGTERM");
		assert.deepEqual(groupKills, [[100, "SIGTERM"], [200, "SIGKILL"]]);
		children[0].emit("close", null, "SIGTERM");
		assert.equal((await killing)!.state, "killed");
		assert.equal(timers.pending().length, 0);
	});

	it("never signals pid or group 0/1, the parent, or the parent's group", async () => {
		const table: ProcessEntry[] = [
			{ pid: 50, ppid: 1, pgid: 50 }, // the parent (selfPid)
			{ pid: 100, ppid: 50, pgid: 100 },
			{ pid: 150, ppid: 100, pgid: 50 }, // shares the parent's group: by pid only
			{ pid: 151, ppid: 100, pgid: 1 },
			{ pid: 152, ppid: 100, pgid: 0 },
			{ pid: 1, ppid: 0, pgid: 1 },
		];
		const { manager, children, groupKills, pidKills } = harness({ listProcesses: () => table, selfPid: 50 });
		const { id } = manager.start({ command: "x", cwd: "/w" });
		void manager.kill(id);
		children[0].emit("exit", null, "SIGTERM");
		children[0].emit("close", null, "SIGTERM");
		assert.deepEqual(groupKills, [[100, "SIGTERM"]]);
		assert.deepEqual(pidKills, [[150, "SIGKILL"]]);
	});

	it("the forced pass also kills descendants that sit in their own process group", async () => {
		const table = [
			{ pid: 100, ppid: 1, pgid: 100 },
			{ pid: 200, ppid: 100, pgid: 200 },
			{ pid: 201, ppid: 200, pgid: 200 },
			{ pid: 1, ppid: 0, pgid: 1 },
		];
		const { manager, timers, groupKills } = harness({ listProcesses: () => table });
		const { id } = manager.start({ command: "x", cwd: "/w" });
		void manager.kill(id);
		timers.fire(5000);
		assert.deepEqual(groupKills.filter(([, signal]) => signal === "SIGKILL").map(([pid]) => pid).sort(), [100, 200]);
	});
});

describe("consumed (what the model has already seen)", () => {
	it("bg_status of a settled process marks it seen; of a running one does not", () => {
		const { manager, children } = harness();
		const a = manager.start({ command: "a", cwd: "/w" });
		manager.start({ command: "b", cwd: "/w" });
		assert.equal(manager.status(a.id)!.state, "running");
		assert.equal(manager.isConsumed(a.id), false);
		children[0].emit("close", 0, null);
		assert.equal(manager.isConsumed(a.id), false);
		manager.status(a.id);
		assert.equal(manager.isConsumed(a.id), true);
	});

	it("a kill the model waits on is seen at settle time, so the settle hook says consumed", async () => {
		const { manager, children } = harness();
		const settled: Array<[string, boolean]> = [];
		manager.onSettled((snap, consumed) => settled.push([snap.id, consumed]));
		const { id } = manager.start({ command: "x", cwd: "/w" });
		const killing = manager.kill(id);
		children[0].emit("close", null, "SIGTERM");
		await killing;
		assert.deepEqual(settled, [[id, true]]);
		assert.equal(manager.isConsumed(id), true);
	});

	it("a kill the user asked for (not seen) leaves the exit for the model", async () => {
		const { manager, children } = harness();
		const settled: Array<[string, boolean]> = [];
		manager.onSettled((snap, consumed) => settled.push([snap.id, consumed]));
		const { id } = manager.start({ command: "x", cwd: "/w" });
		const killing = manager.kill(id, { seen: false });
		children[0].emit("close", null, "SIGTERM");
		await killing;
		assert.deepEqual(settled, [[id, false]]);
		assert.equal(manager.isConsumed(id), false);
	});

	it("a natural exit is announced once, with the final snapshot", () => {
		const { manager, children } = harness();
		const settled: string[] = [];
		manager.onSettled((snap) => settled.push(`${snap.id}:${snap.state}:${snap.output}`));
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].stdout.emit("data", "bye\n");
		children[0].emit("exit", 3, null);
		children[0].emit("close", 3, null);
		children[0].emit("close", 3, null);
		assert.deepEqual(settled, [`${id}:failed:bye\n`]);
	});

	it("a hook that throws does not break the manager", () => {
		const { manager, children } = harness();
		manager.onSettled(() => {
			throw new Error("ui bug");
		});
		const { id } = manager.start({ command: "x", cwd: "/w" });
		children[0].emit("close", 0, null);
		assert.equal(manager.get(id)!.state, "done");
	});
});

describe("list, history, reset, shutdown", () => {
	it("lists processes in start order; get is a copy", () => {
		const { manager, children } = harness();
		manager.start({ command: "a", cwd: "/w" });
		manager.start({ command: "b", cwd: "/w" });
		assert.deepEqual(manager.list().map((s) => s.id), ["bg-1", "bg-2"]);
		const snap = manager.get("bg-1")!;
		children[0].stdout.emit("data", "later");
		assert.equal(snap.output, "");
		assert.equal(manager.get("bg-1")!.output, "later");
	});

	it("keeps a bounded history of settled processes, oldest first out, never a running one", () => {
		const { manager, children } = harness();
		const keep = manager.start({ command: "long", cwd: "/w" });
		for (let i = 0; i < MAX_SETTLED_KEPT + 5; i++) {
			manager.start({ command: `c${i}`, cwd: "/w" });
			children[i + 1].emit("close", 0, null);
		}
		assert.equal(manager.get(keep.id)?.state, "running");
		assert.equal(manager.list().filter((s) => s.state !== "running").length, MAX_SETTLED_KEPT);
		assert.equal(manager.get("bg-2"), undefined);
	});

	it("reset forgets settled processes but keeps running ones", () => {
		const { manager, children } = harness();
		manager.start({ command: "a", cwd: "/w" });
		manager.start({ command: "b", cwd: "/w" });
		children[0].emit("close", 0, null);
		manager.reset();
		assert.deepEqual(manager.list().map((s) => s.id), ["bg-2"]);
	});

	it("shutdown SIGTERMs everything, waits, and SIGKILLs the survivors; it is bounded", async () => {
		const { manager, children, timers, groupKills } = harness();
		manager.start({ command: "a", cwd: "/w" });
		manager.start({ command: "b", cwd: "/w" });
		const done = manager.shutdown();
		assert.deepEqual(groupKills, [[100, "SIGTERM"], [101, "SIGTERM"]]);
		children[0].emit("close", null, "SIGTERM");
		timers.fire(5000);
		assert.deepEqual(groupKills.filter(([, s]) => s === "SIGKILL").map(([pid]) => pid), [101]);
		timers.fire(5000 + CLOSE_DRAIN_MS + 1000);
		await done;
		assert.equal(manager.tracker.size(), 0, "a survivor settles by force");
		assert.equal(manager.runningCount(), 0);
	});

	it("shutdown with nothing running resolves at once", async () => {
		await harness().manager.shutdown();
	});
});

describe("shell environment", () => {
	it("puts Pi's bin dir first on PATH once, and carries the session variables Pi's bash tool sets", () => {
		const env = shellEnvironment({ PATH: "/usr/bin:/bin", PI_MODEL: "stale", KEEP: "1" }, { binDir: "/pi/bin", delimiter: ":", session: { PI_SESSION_ID: "s1", PI_PROVIDER: "anthropic" } });
		assert.equal(env.PATH, "/pi/bin:/usr/bin:/bin");
		assert.equal(env.KEEP, "1");
		assert.equal(env.PI_SESSION_ID, "s1");
		assert.equal(env.PI_PROVIDER, "anthropic");
		assert.equal(env.PI_MODEL, undefined, "a stale value is not inherited");
		assert.equal(shellEnvironment({ PATH: "/pi/bin:/bin" }, { binDir: "/pi/bin", delimiter: ":" }).PATH, "/pi/bin:/bin");
		assert.equal(shellEnvironment({ Path: "C:\\x" }, { binDir: "C:\\pi", delimiter: ";" }).Path, "C:\\pi;C:\\x");
	});
});

// ---- real processes (POSIX only) ----

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function until(check: () => boolean, ms = 4000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((r) => setTimeout(r, 20));
	}
	return check();
}

describe("real processes", { skip: process.platform === "win32" }, () => {
	async function withManager(body: (manager: ReturnType<typeof createBgProcesses>, track: (pid: number) => void) => Promise<void>) {
		const manager = createBgProcesses({ graceMs: 300, tracker: createChildTracker() });
		const strays: number[] = [];
		try {
			await body(manager, (pid) => strays.push(pid));
		} finally {
			await manager.shutdown();
			for (const pid of strays) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					// Already gone.
				}
			}
		}
	}
	const pidIn = (text: string) => Number(/pid=(\d+)/.exec(text)?.[1]);

	it("runs a command in its cwd, merges stdout and stderr, and settles with the exit code", async () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "bg-real-")));
		try {
			await withManager(async (manager) => {
				const { id } = manager.start({ command: "pwd; echo out; echo err >&2; exit 3", cwd: dir });
				assert.ok(await until(() => manager.get(id)!.state !== "running"));
				const snap = manager.get(id)!;
				assert.deepEqual({ state: snap.state, exitCode: snap.exitCode }, { state: "failed", exitCode: 3 });
				assert.match(snap.output, new RegExp(`${dir}\\n`));
				assert.match(snap.output, /out\n/);
				assert.match(snap.output, /err\n/);
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("gives the process no stdin: a command that reads it sees end of file at once", async () => {
		await withManager(async (manager) => {
			const { id } = manager.start({ command: "cat; echo eof-seen", cwd: process.cwd() });
			assert.ok(await until(() => manager.get(id)!.state !== "running", 3000));
			assert.match(manager.get(id)!.output, /eof-seen/);
		});
	});

	it("kills a command that ignores SIGTERM with SIGKILL after the grace, and the process is gone", async () => {
		await withManager(async (manager, track) => {
			const { id } = manager.start({ command: "trap '' TERM; echo pid=$$; while :; do sleep 0.2; done", cwd: process.cwd() });
			assert.ok(await until(() => /pid=\d+/.test(manager.get(id)!.output)));
			const pid = pidIn(manager.get(id)!.output);
			track(pid);
			const started = Date.now();
			const snap = (await manager.kill(id))!;
			assert.equal(snap.state, "killed");
			assert.ok(Date.now() - started >= 250, "waited for the grace before SIGKILL");
			assert.ok(await until(() => !alive(pid), 2000));
		});
	});

	it("kills a grandchild with the process: it shares the group", async () => {
		await withManager(async (manager, track) => {
			const { id } = manager.start({ command: "sleep 300 & echo pid=$!; wait", cwd: process.cwd() });
			assert.ok(await until(() => /pid=\d+/.test(manager.get(id)!.output)));
			const grandchild = pidIn(manager.get(id)!.output);
			track(grandchild);
			assert.ok(alive(grandchild));
			const snap = (await manager.kill(id))!;
			assert.equal(snap.state, "killed");
			assert.ok(await until(() => !alive(grandchild), 2000), "the grandchild died too");
		});
	});

	it("kills a grandchild in its own process group when SIGTERM is ignored (forced pass)", async () => {
		await withManager(async (manager, track) => {
			const { id } = manager.start({ command: "trap '' TERM; set -m; sleep 300 & echo pid=$!; while :; do wait; sleep 0.1; done", cwd: process.cwd() });
			assert.ok(await until(() => /pid=\d+/.test(manager.get(id)!.output)));
			const grandchild = pidIn(manager.get(id)!.output);
			track(grandchild);
			await manager.kill(id);
			assert.ok(await until(() => !alive(grandchild), 2000), "the grandchild in its own group died too");
		});
	});

	it("a descendant that outlives the shell and holds the pipes does not keep the process running", async () => {
		await withManager(async (manager, track) => {
			const { id } = manager.start({ command: "sleep 300 & echo pid=$!", cwd: process.cwd() });
			assert.ok(await until(() => /pid=\d+/.test(manager.get(id)!.output)));
			track(pidIn(manager.get(id)!.output));
			assert.ok(await until(() => manager.get(id)!.state !== "running", CLOSE_DRAIN_MS + 3000));
			assert.equal(manager.get(id)!.state, "killed");
			assert.match(manager.get(id)!.error ?? "", /left running after the shell exited/);
			assert.ok(await until(() => !alive(pidIn(manager.get(id)!.output)), 2000), "the leftover descendant was ended");
		});
	});

	it("shutdown stops every running process within a bound", async () => {
		await withManager(async (manager, track) => {
			const pids: number[] = [];
			for (let i = 0; i < 3; i++) {
				const { id } = manager.start({ command: "trap '' TERM; echo pid=$$; while :; do sleep 0.2; done", cwd: process.cwd() });
				assert.ok(await until(() => /pid=\d+/.test(manager.get(id)!.output)));
				pids.push(pidIn(manager.get(id)!.output));
				track(pids.at(-1)!);
			}
			const started = Date.now();
			await manager.shutdown();
			assert.ok(Date.now() - started < 3000);
			assert.ok(await until(() => pids.every((pid) => !alive(pid)), 2000));
			assert.equal(manager.runningCount(), 0);
		});
	});
});
