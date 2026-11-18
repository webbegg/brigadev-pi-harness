import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ChildControl } from "../lib/child-rpc.ts";
import { CLOSE_DRAIN_MS, createChildTracker, EXIT_GRACE_MS, createProcessSignaller, descendantTargets, failed, mergeDescendantTargets, listProcessesWithPs, parseProcessList, installParentExitGuard, KILL_GRACE_MS, output, runChild, type ParentProcessLike, type ChildProcessLike, type ChildRunDeps, type RunOptions, type RunResult, type SpawnFn } from "../lib/child-run.ts";
import { classifyFailure } from "../lib/fallback.ts";
import { CHILD_ENV, STRUCTURED_OUTPUT_EXTENSION_PATH } from "../lib/runtime.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Manual timers, so no test waits for real time. */
function fakeTime() {
	let now = 0;
	let nextHandle = 1;
	const timers = new Map<number, { at: number; fn: () => void }>();
	return {
		setTimer: (fn: () => void, ms: number) => {
			const handle = nextHandle++;
			timers.set(handle, { at: now + ms, fn });
			return handle;
		},
		clearTimer: (handle: unknown) => void timers.delete(handle as number),
		advance(ms: number) {
			now += ms;
			for (const [handle, t] of [...timers]) {
				if (t.at <= now) {
					timers.delete(handle);
					t.fn();
				}
			}
		},
		pending: () => timers.size,
	};
}

/** The child's stdin: what the parent wrote (one JSON record per line) and whether it closed the pipe. */
class FakeStdin extends EventEmitter {
	written: string[] = [];
	ended = false;
	/** Writes after the pipe was closed (a bug in the run loop; node would emit an error). */
	late = 0;
	write(chunk: string) {
		if (this.ended) this.late++;
		else this.written.push(chunk);
		return true;
	}
	end() {
		this.ended = true;
	}
	/** Every record written so far, parsed; each must be exactly one LF-terminated JSON line. */
	records(): any[] {
		return this.written.map((chunk) => {
			assert.ok(chunk.endsWith("\n") && chunk.indexOf("\n") === chunk.length - 1, "one LF-terminated record per write");
			return JSON.parse(chunk);
		});
	}
}

class FakeChild extends EventEmitter implements ChildProcessLike {
	stdin = new FakeStdin();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kills: string[] = [];
	/** Set by a test that exercises process-group signalling; a fake without one is signalled through `kill`. */
	pid: number | undefined;
	kill(signal?: NodeJS.Signals) {
		this.kills.push(String(signal));
		return true;
	}
	say(text: string) {
		this.stdout.emit("data", Buffer.from(text));
	}
	line(event: unknown) {
		this.say(`${JSON.stringify(event)}\n`);
	}
	close(code: number | null) {
		this.emit("close", code);
	}
}

const assistant = (text: string, extra: Record<string, unknown> = {}) => ({
	type: "message_end",
	message: { role: "assistant", content: [{ type: "text", text }], provider: "anthropic", model: "claude-x", stopReason: "stop", usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, ...extra },
});

function harness(over: { agent?: Partial<RunOptions["agent"]>; env?: NodeJS.ProcessEnv; signal?: AbortSignal; schema?: RunOptions["schema"]; price?: RunOptions["price"]; onControl?: RunOptions["onControl"]; onUpdate?: RunOptions["onUpdate"]; deps?: Partial<ChildRunDeps> } = {}) {
	const time = fakeTime();
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-child-run-"));
	const tmpRoot = path.join(root, "tmp");
	const docs = path.join(root, "docs");
	const cwd = path.join(root, "project");
	for (const dir of [tmpRoot, docs, cwd]) fs.mkdirSync(dir);
	const h = {
		time,
		root,
		tmpRoot,
		docs,
		proc: undefined as FakeChild | undefined,
		spawned: undefined as { command: string; args: string[]; options: Parameters<SpawnFn>[2]; promptFile?: string } | undefined,
		updates: 0,
		/** The result the last update carried (the live snapshot). */
		last: undefined as RunResult | undefined,
		/** Child clock for the partial-update throttle; defaults to a frozen 42. */
		clock: 42,
		start: () => {
			const spawn: SpawnFn = (command, args, options) => {
				const at = args.indexOf("--append-system-prompt");
				h.spawned = { command, args, options, promptFile: at >= 0 ? fs.readFileSync(args[at + 1], "utf8") : undefined };
				h.proc = new FakeChild();
				onSpawn?.();
				return h.proc;
			};
			const options: RunOptions = {
				cwd,
				agent: { name: "scout", description: "d", writer: false, systemPrompt: "You are a scout.", source: "package", filePath: "/a.md", ...over.agent } as RunOptions["agent"],
				request: { agent: "scout", task: "map the code", reason: "Evidence budget" },
				taskText: "## Task\nmap the code",
				route: { model: "anthropic/claude-x", thinking: "low", modelSource: "definition", thinkingSource: "definition" },
				routeLabel: "definition",
				schema: over.schema,
				price: over.price ?? (() => undefined),
				onControl: over.onControl,
				signal: over.signal,
				onUpdate: (r) => {
					h.updates++;
					h.last = r;
					over.onUpdate?.(r);
				},
			};
			const promise = runChild(options, {
				spawn,
				piInvocation: (args) => ({ command: "pi-bin", args: ["--wrapped", ...args] }),
				env: { PATH: "/bin", ...over.env },
				setTimer: time.setTimer,
				clearTimer: time.clearTimer,
				now: () => h.clock,
				tmpRoot,
				docsDir: () => docs,
				// A fake child has a made-up pid: never list or signal real processes unless a test injects its own.
				listProcesses: () => [],
				killPid: () => undefined,
				selfPid: 100,
				...over.deps,
			});
			// Surface a rejection to the test only when it awaits `promise`.
			promise.catch(() => undefined);
			return promise;
		},
		ready: async () => {
			// The run spawns after real async temp-dir I/O, which can take any number of ticks under load: wait for the spawn itself.
			if (!h.proc) {
				await new Promise<void>((resolve) => {
					const ceiling = setTimeout(resolve, 5000);
					onSpawn = () => {
						clearTimeout(ceiling);
						resolve();
					};
				});
			}
			assert.ok(h.proc, "child was spawned");
			return h.proc;
		},
		savedRuns: () => fs.readdirSync(path.join(docs, "runs")),
		saved: (result: RunResult, file: string) => fs.readFileSync(path.join(result.artifactsDir!, file), "utf8"),
	};
	let onSpawn: (() => void) | undefined;
	return h;
}

describe("runChild: output folding", () => {
	it("spawns through piInvocation with the childLaunch argv/env, folds JSON lines split across chunks, and saves artifacts", async () => {
		const h = harness({ agent: { writer: true } });
		const promise = h.start();
		const proc = await h.ready();
		assert.equal(h.spawned!.command, "pi-bin");
		assert.deepEqual(h.spawned!.args.slice(0, 4), ["--wrapped", "--mode", "rpc", "--no-session"]);
		assert.ok(!h.spawned!.args.includes("## Task\nmap the code"), "the task is not an argument");
		assert.deepEqual(proc.stdin.records(), [{ type: "prompt", message: "## Task\nmap the code" }], "the task is the RPC prompt");
		assert.equal(h.spawned!.options.shell, false);
		assert.deepEqual(h.spawned!.options.stdio, ["pipe", "pipe", "pipe"]);
		assert.equal(h.spawned!.options.env[CHILD_ENV.CHILD], "1");
		assert.equal(h.spawned!.options.env.PATH, "/bin");
		assert.equal(h.spawned!.promptFile, "You are a scout.");

		const first = JSON.stringify(assistant("hello"));
		proc.say(first.slice(0, 20));
		assert.equal(h.updates, 0, "a partial line is not parsed");
		proc.say(`${first.slice(20)}\n`);
		assert.equal(h.updates, 1);
		proc.say(JSON.stringify(assistant("final answer"))); // no trailing newline: flushed on close
		assert.equal(h.updates, 1);
		proc.close(0);
		const result = await promise;

		assert.equal(h.updates, 2);
		assert.equal(result.exitCode, 0);
		assert.equal(result.messages.length, 2);
		assert.equal(result.model, "anthropic/claude-x");
		assert.equal(result.usage.turns, 2);
		assert.equal(result.usage.input, 20);
		assert.equal(output(result), "final answer");
		assert.ok(!failed(result));

		assert.deepEqual(h.savedRuns(), [result.runId]);
		assert.equal(result.artifactsDir, path.join(h.docs, "runs", result.runId!));
		assert.equal(h.saved(result, "task.md"), "## Task\nmap the code");
		assert.equal(JSON.parse(h.saved(result, "transcript.json")).length, 2);
		const saved = JSON.parse(h.saved(result, "result.json"));
		assert.equal(saved.exitCode, 0);
		assert.equal(saved.output, "final answer");
		assert.equal(saved.endedAt, 42);
		assert.equal(saved.reason, "Evidence budget");
		assert.deepEqual(fs.readdirSync(h.tmpRoot), [], "the temp folder is removed");
		assert.equal(h.time.pending(), 0, "no timer is left armed");
	});

	it("prices zero-cost bridge turns through the injected calculator", async () => {
		const h = harness({ price: (_provider, _model, usage) => ({ ...usage.cost, total: 0.5 }) });
		const promise = h.start();
		const proc = await h.ready();
		proc.line(assistant("ok", { provider: "claude-bridge", model: "claude-x", usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }));
		proc.close(0);
		assert.equal((await promise).usage.cost, 0.5);
	});
});

const delta = (text: string) => ({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });

describe("runChild: multi-byte UTF-8 split across stdout/stderr chunks stays intact", () => {
	const TEXT = "é 日本 😀 end";

	it("a streamed delta and a final message fold intact when every byte arrives in its own chunk", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		const feed = (text: string) => {
			for (const byte of Buffer.from(text)) proc.stdout.emit("data", Buffer.from([byte]));
		};
		feed(`${JSON.stringify(delta(TEXT))}\n`);
		assert.equal(h.last!.partial, TEXT);
		feed(`${JSON.stringify(assistant(TEXT))}\n`);
		proc.close(0);
		const result = await promise;
		assert.equal(output(result), TEXT);
		assert.ok(!output(result).includes("�"));
	});

	it("a split in the middle of each character (2-, 3- and 4-byte) folds intact", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		const bytes = Buffer.from(`${JSON.stringify(delta(TEXT))}\n`);
		for (const word of ["é", "日", "😀"]) {
			const at = bytes.indexOf(Buffer.from(word)) + 1; // one byte into the character
			assert.ok(at > 0);
			h.clock += 1000;
			proc.stdout.emit("data", bytes.subarray(0, at));
			proc.stdout.emit("data", bytes.subarray(at));
			assert.equal(h.last!.partial?.endsWith(TEXT), true, `split inside ${word}`);
			assert.ok(!h.last!.partial!.includes("�"), `no replacement character after splitting ${word}`);
		}
		proc.close(0);
		await promise;
	});

	it("stderr decodes the same way, and a character cut off by the end of the stream is flushed on close", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		const bytes = Buffer.from("日本 oops");
		proc.stderr.emit("data", bytes.subarray(0, 1));
		proc.stderr.emit("data", bytes.subarray(1));
		proc.stderr.emit("data", Buffer.from([0xe6, 0x97])); // a 3-byte character that never completes
		proc.close(1);
		const result = await promise;
		assert.equal(result.stderr, "日本 oops�");
	});

	it("a final line without a newline is flushed through the decoder on close", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		const bytes = Buffer.from(JSON.stringify(assistant(TEXT)));
		const at = bytes.indexOf(Buffer.from("日")) + 1;
		proc.stdout.emit("data", bytes.subarray(0, at));
		proc.stdout.emit("data", bytes.subarray(at));
		proc.close(0);
		assert.equal(output(await promise), TEXT);
	});
});

describe("runChild: live partial text", () => {
	it("folds streaming deltas into result.partial, updates at most every 100 ms, and clears it on the matching message_end", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "message_start", message: { role: "assistant", content: [] } });
		assert.equal(h.updates, 0, "nothing was buffered, so nothing changed");
		h.clock = 1000;
		proc.line(delta("Hel"));
		assert.equal(h.updates, 1);
		assert.equal(h.last!.partial, "Hel");
		h.clock = 1050;
		proc.line(delta("lo"));
		assert.equal(h.updates, 1, "throttled");
		assert.equal(h.last!.partial, "Hello", "the snapshot is current even when no update was sent");
		h.clock = 1100;
		proc.line(delta(" world"));
		assert.equal(h.updates, 2);
		proc.line(assistant("Hello world"));
		assert.equal(h.updates, 3, "a finished message is never throttled");
		assert.equal(h.last!.partial, undefined);
		proc.close(0);
		const result = await promise;
		assert.equal(result.partial, undefined);
		assert.equal(JSON.parse(h.saved(result, "result.json")).output, "Hello world");
	});

	it("a child killed mid-message does not keep the partial text in its result", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(delta("half a sent"));
		assert.equal(h.last!.partial, "half a sent");
		proc.close(1);
		assert.equal((await promise).partial, undefined);
	});

	it("streaming deltas are signs of life for the stall watchdog", async () => {
		const h = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "60000" } });
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(59_000);
		proc.line(delta("still thinking"));
		h.time.advance(59_000);
		assert.deepEqual(proc.kills, []);
		proc.close(0);
		await promise;
	});
});

describe("runChild: failures", () => {
	it("captures stderr and reports a non-zero exit as failed, with the error in the saved result", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.stderr.emit("data", Buffer.from("boom: bad flag\n"));
		proc.close(2);
		const result = await promise;
		assert.equal(result.exitCode, 2);
		assert.equal(result.stderr, "boom: bad flag\n");
		assert.ok(failed(result));
		assert.equal(output(result), "boom: bad flag");
		const saved = JSON.parse(h.saved(result, "result.json"));
		assert.equal(saved.exitCode, 2);
		assert.equal(saved.output, "boom: bad flag");
	});

	it("a spawn error settles as exit 1 with the error on stderr", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.emit("error", new Error("ENOENT pi"));
		const result = await promise;
		assert.equal(result.exitCode, 1);
		assert.match(result.stderr, /ENOENT pi/);
	});

	it("keeps the child's own error message and stop reason", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(assistant("", { stopReason: "error", errorMessage: "429 rate limit" }));
		proc.close(0);
		const result = await promise;
		assert.ok(failed(result));
		assert.equal(result.stopReason, "error");
		assert.equal(output(result), "429 rate limit");
	});
});

const settled = (aborted = false) => ({ type: "agent_settled", aborted });
const ack = (command: string, extra: Record<string, unknown> = {}) => ({ type: "response", command, success: true, ...extra });
const uiRequest = (method: string, extra: Record<string, unknown> = {}) => ({ type: "extension_ui_request", id: `ui-${method}`, method, ...extra });

describe("runChild: RPC lifecycle (Pi rpc.md:58-97)", () => {
	it("closes stdin once the agent settles, after folding the final messages, and the child then exits", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(ack("prompt", { data: { disposition: "started" } }));
		proc.line({ type: "agent_start" });
		proc.line(assistant("the answer"));
		assert.equal(proc.stdin.ended, false, "still open: more work can follow");
		proc.line({ type: "agent_end", messages: [], willRetry: false });
		assert.equal(proc.stdin.ended, false, "agent_end alone is not the end: retries, compaction, queued messages can follow");
		proc.line(settled());
		assert.equal(proc.stdin.ended, true);
		proc.close(0);
		const result = await promise;
		assert.equal(result.exitCode, 0);
		assert.equal(output(result), "the answer");
		assert.equal(result.messages.length, 1, "the response record is not a transcript message");
		assert.equal(proc.stdin.late, 0);
		assert.equal(h.time.pending(), 0);
	});

	it("a message in the same chunk as agent_settled is still folded", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.say(`${JSON.stringify(assistant("tail"))}\n${JSON.stringify(settled())}\n`);
		assert.equal(proc.stdin.ended, true);
		proc.close(0);
		assert.equal(output(await promise), "tail");
	});

	it("a prompt Pi rejects ends the run as an error instead of waiting for a run that never starts", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "response", command: "prompt", success: false, error: "No model selected" });
		assert.equal(proc.stdin.ended, true);
		proc.close(0);
		const result = await promise;
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /No model selected/);
		assert.ok(failed(result));
	});

	it("a prompt that was handled starts no run: stdin closes at once (rpc.md:67)", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(ack("prompt", { data: { disposition: "handled" } }));
		assert.equal(proc.stdin.ended, true);
		proc.close(0);
		await promise;
	});

	it("a response to some other command never ends the run", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "response", command: "steer", success: false, error: "not streaming" });
		proc.line(ack("abort"));
		assert.equal(proc.stdin.ended, false);
		proc.close(0);
		await promise;
	});

	it("a stdin error (the child exited early) is absorbed", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.stdin.emit("error", new Error("EPIPE"));
		proc.close(1);
		assert.equal((await promise).exitCode, 1);
	});

	it("a silent child is still stopped by the stall watchdog (the backstop)", async () => {
		const h = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "60000" } });
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(60_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.close(null);
		assert.equal((await promise).stopReason, "error");
	});
});

describe("runChild: S0, a child's UI requests are answered by the parent, never by a person", () => {
	for (const method of ["select", "confirm", "input", "editor"]) {
		it(`${method}: answered at once with the cancellation response, nothing else written`, async () => {
			const h = harness();
			const promise = h.start();
			const proc = await h.ready();
			proc.line(uiRequest(method, { title: "Allow?", options: ["a"], timeout: 10_000 }));
			assert.deepEqual(proc.stdin.records().slice(1), [{ type: "extension_ui_response", id: `ui-${method}`, cancelled: true }]);
			proc.line(settled());
			proc.close(0);
			const result = await promise;
			assert.equal(result.messages.length, 0, "the request is not a transcript message");
		});
	}

	it("fire-and-forget requests are ignored, and a dialog after them is still answered", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		for (const method of ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]) proc.line(uiRequest(method, { message: "hi" }));
		assert.equal(proc.stdin.records().length, 1, "only the prompt was written");
		proc.line(uiRequest("confirm"));
		assert.deepEqual(proc.stdin.records().at(-1), { type: "extension_ui_response", id: "ui-confirm", cancelled: true });
		proc.close(0);
		await promise;
	});

	it("a request that arrives after the pipe closed is dropped without a write", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(settled());
		proc.line(uiRequest("confirm"));
		assert.equal(proc.stdin.late, 0);
		proc.close(0);
		await promise;
	});

	it("a dialog counts as a sign of life for the watchdog", async () => {
		const h = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "60000" } });
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(59_000);
		proc.line(uiRequest("input"));
		h.time.advance(59_000);
		assert.deepEqual(proc.kills, []);
		proc.close(0);
		await promise;
	});
});

describe("runChild: the steering handle (S4)", () => {
	const controlled = () => {
		const seen: Array<ChildControl | undefined> = [];
		const h = harness({ onControl: (c) => void seen.push(c) });
		return { h, seen };
	};

	it("is exposed once the child is spawned and sends steer and follow_up as RPC commands", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		assert.equal(seen.length, 1);
		const control = seen[0]!;
		void control.steer("go left");
		void control.followUp("then right");
		const [steer, followUp] = proc.stdin.records().slice(1);
		assert.deepEqual({ ...steer, id: undefined }, { type: "steer", message: "go left", id: undefined });
		assert.deepEqual({ ...followUp, id: undefined }, { type: "follow_up", message: "then right", id: undefined });
		assert.ok(steer.id && followUp.id && steer.id !== followUp.id, "each command has its own id (rpc.md:37-44)");
		proc.close(0);
		await promise;
	});

	it("accepted: the outcome settles from Pi's response to that command, with its disposition", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		const outcome = seen[0]!.steer("go left");
		const { id } = proc.stdin.records().at(-1);
		proc.line({ type: "response", id, command: "steer", success: true, data: { disposition: "queued" } });
		assert.deepEqual(await outcome, { status: "accepted", disposition: "queued" });
		proc.close(0);
		await promise;
	});

	it("rejected: Pi's error for that command is the outcome", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const outcome = seen[0]!.followUp("later");
		const { id } = proc.stdin.records().at(-1);
		proc.line({ type: "response", id, command: "follow_up", success: false, error: "Agent is shutting down" });
		assert.deepEqual(await outcome, { status: "rejected", error: "Agent is shutting down" });
		proc.close(0);
		await promise;
	});

	it("responses out of order settle their own commands (T7's smoke: Pi answers out of order)", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const first = seen[0]!.steer("one");
		const second = seen[0]!.followUp("two");
		const [a, b] = proc.stdin.records().slice(1);
		proc.line({ type: "response", id: b.id, command: "follow_up", success: false, error: "nope" });
		proc.line({ type: "response", id: a.id, command: "steer", success: true, data: { disposition: "queued" } });
		assert.deepEqual(await second, { status: "rejected", error: "nope" });
		assert.deepEqual(await first, { status: "accepted", disposition: "queued" });
		proc.close(0);
		await promise;
	});

	it("a response with another id (or none) never settles a command", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		let outcome: unknown = "pending";
		void seen[0]!.steer("one").then((o) => (outcome = o));
		proc.line({ type: "response", command: "steer", success: true });
		proc.line({ type: "response", id: "other", command: "steer", success: true });
		await tick();
		assert.equal(outcome, "pending");
		proc.close(0);
		await promise;
		await tick();
		assert.deepEqual(outcome, { status: "not_delivered" });
	});

	it("not delivered: the agent settles (input ends) before Pi answers; a late response changes nothing", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const outcome = seen[0]!.steer("too late to matter");
		const { id } = proc.stdin.records().at(-1);
		proc.line(settled());
		assert.deepEqual(await outcome, { status: "not_delivered" });
		proc.line({ type: "response", id, command: "steer", success: true });
		proc.close(0);
		await promise;
	});

	it("not delivered: the child exits before responding", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const outcome = seen[0]!.followUp("anyone there?");
		proc.close(1);
		await promise;
		assert.deepEqual(await outcome, { status: "not_delivered" });
	});

	it("not delivered: the child fails to start, or its stdin breaks", async () => {
		const a = controlled();
		const failing = a.h.start();
		const procA = await a.h.ready();
		const outcomeA = a.seen[0]!.steer("x");
		procA.emit("error", new Error("ENOENT pi"));
		await failing;
		assert.deepEqual(await outcomeA, { status: "not_delivered" });

		const b = controlled();
		const broken = b.h.start();
		const procB = await b.h.ready();
		const outcomeB = b.seen[0]!.steer("x");
		procB.stdin.emit("error", new Error("EPIPE"));
		assert.deepEqual(await outcomeB, { status: "not_delivered" });
		procB.close(1);
		await broken;
	});

	it("commands sent to a finished run are not delivered and write nothing", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(settled());
		assert.deepEqual(await seen[0]!.steer("x"), { status: "not_delivered" });
		assert.deepEqual(await seen[0]!.followUp("x"), { status: "not_delivered" });
		assert.equal(proc.stdin.late, 0);
		proc.close(0);
		await promise;
	});

	it("no command is left pending after the run ends (every outcome settled, no timer left)", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const outcomes = [seen[0]!.steer("a"), seen[0]!.followUp("b"), seen[0]!.steer("c")];
		const [first] = proc.stdin.records().slice(1);
		proc.line({ type: "response", id: first.id, command: "steer", success: true });
		proc.close(0);
		await promise;
		const settledOutcomes = await Promise.all(outcomes);
		assert.deepEqual(settledOutcomes.map((o) => o.status), ["accepted", "not_delivered", "not_delivered"]);
		assert.equal(h.time.pending(), 0);
	});

	it("knows whether the child is streaming (agent_start .. agent_end)", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const control = seen[0]!;
		assert.equal(control.isStreaming(), false);
		proc.line({ type: "agent_start" });
		assert.equal(control.isStreaming(), true);
		proc.line({ type: "agent_end", messages: [], willRetry: true });
		assert.equal(control.isStreaming(), false);
		proc.line({ type: "agent_start" });
		assert.equal(control.isStreaming(), true);
		proc.close(0);
		await promise;
	});

	it("is withdrawn when the agent settles: a finished run has no handle and takes no more input", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		const control = seen[0]!;
		proc.line(settled());
		assert.equal(seen.at(-1), undefined);
		assert.deepEqual(await control.steer("too late"), { status: "not_delivered" });
		assert.equal(control.abort(), false);
		assert.equal(proc.stdin.late, 0);
		proc.close(0);
		await promise;
	});

	it("is withdrawn when the child exits, and when it fails to start", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		proc.close(1);
		await promise;
		assert.equal(seen.at(-1), undefined);

		const errored = controlled();
		const failing = errored.h.start();
		const proc2 = await errored.h.ready();
		proc2.emit("error", new Error("ENOENT pi"));
		await failing;
		assert.equal(errored.seen.at(-1), undefined);
	});

	it("abort: sends the RPC abort, the child settles aborted, and the run ends as aborted without throwing", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		assert.equal(seen[0]!.abort(), true);
		assert.deepEqual(proc.stdin.records().at(-1), { type: "abort" });
		assert.deepEqual(proc.kills, [], "a polite abort first");
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.line(settled(true));
		assert.equal(proc.stdin.ended, true);
		proc.close(0);
		const result = await promise;
		assert.equal(result.stopReason, "aborted");
		assert.equal(result.errorMessage, "Aborted by the user");
		assert.ok(failed(result));
		assert.equal(h.time.pending(), 0, "the escalation timer is cleared");
		assert.deepEqual(proc.kills, []);
	});

	it("abort: a child that does not stop within the grace period is terminated (SIGTERM, then SIGKILL)", async () => {
		const { h, seen } = controlled();
		const promise = h.start();
		const proc = await h.ready();
		seen[0]!.abort();
		h.time.advance(4999);
		assert.deepEqual(proc.kills, []);
		h.time.advance(1);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(5000);
		assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"]);
		proc.close(null);
		const result = await promise;
		assert.equal(result.stopReason, "aborted");
		assert.equal(h.time.pending(), 0);
	});
});

describe("runChild: abort", () => {
	it("SIGTERM at once, SIGKILL after 5 s if the child is still there, then rejects and still saves the folder", async () => {
		const abort = new AbortController();
		const h = harness({ signal: abort.signal });
		const promise = h.start();
		const proc = await h.ready();
		abort.abort();
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(4999);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(1);
		assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"]);
		proc.close(null);
		await assert.rejects(promise, /Subagent was aborted/);
		assert.equal(h.savedRuns().length, 1);
		assert.deepEqual(fs.readdirSync(h.tmpRoot), []);
		assert.equal(h.time.pending(), 0);
	});

	it("no SIGKILL when the child exits within the grace period", async () => {
		const abort = new AbortController();
		const h = harness({ signal: abort.signal });
		const promise = h.start();
		const proc = await h.ready();
		abort.abort();
		proc.close(null);
		await assert.rejects(promise, /Subagent was aborted/);
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
	});

	it("an already-aborted signal terminates the child as soon as it is spawned", async () => {
		const abort = new AbortController();
		abort.abort();
		const h = harness({ signal: abort.signal });
		const promise = h.start();
		const proc = await h.ready();
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.close(null);
		await assert.rejects(promise, /Subagent was aborted/);
	});
});

describe("runChild: stall watchdog", () => {
	it("terminates a silent child, and the stall wins over the child's own aborted report", async () => {
		const h = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "60000" } });
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(59_000);
		assert.deepEqual(proc.kills, []);
		proc.line({ type: "turn_start" }); // a sign of life restarts the budget
		h.time.advance(59_000);
		assert.deepEqual(proc.kills, []);
		h.time.advance(1_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.close(143);
		const result = await promise;
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "stalled for 1 min after: turn_start");
		assert.ok(failed(result));
		assert.equal(JSON.parse(h.saved(result, "result.json")).errorMessage, "stalled for 1 min after: turn_start");
	});

	it("allows the longer tool budget while a tool call is in flight", async () => {
		const h = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "1000", BRIGADEV_TOOL_STALL_TIMEOUT_MS: "5000" } });
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "bash", arguments: {} }], stopReason: "toolUse" } });
		h.time.advance(4_999);
		assert.deepEqual(proc.kills, []);
		h.time.advance(1);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.close(null);
		assert.match((await promise).errorMessage ?? "", /^stalled for 0\.1 min after: tool bash$/);
	});
});

describe("runChild: run budget", () => {
	const budgeted = { agent: { budgetMinutes: 1 }, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000" } };
	const sentOf = (proc: FakeChild, type: string) => proc.stdin.records().filter((r) => r.type === type);

	it("asks a streaming child to wrap up once the budget is spent, and keeps the result it then returns", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(59_999);
		assert.deepEqual(sentOf(proc, "steer"), []);
		h.time.advance(1);
		const [steer] = sentOf(proc, "steer");
		assert.match(steer.message, /structured_output/);
		assert.deepEqual(proc.kills, []);
		proc.line({ type: "response", id: steer.id, command: "steer", success: true, data: { disposition: "queued" } });
		proc.line(assistant("partial answer"));
		proc.line({ type: "agent_end", messages: [], willRetry: false });
		proc.line(settled());
		assert.equal(h.time.pending(), 1, "settling cancels the wrap-up grace: only the exit grace is left");
		proc.close(0);
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, [], "a run that settled inside the grace is not killed");
		const result = await promise;
		assert.equal(result.exitCode, 0);
		assert.equal(failed(result), false);
		assert.equal(output(result), "partial answer");
		assert.equal(h.time.pending(), 0);
	});

	it("between turns, holds the wrap-up and steers it into the next turn (a follow-up would wait for the run's end)", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(60_000);
		assert.equal(sentOf(proc, "steer").length, 0);
		assert.equal(sentOf(proc, "follow_up").length, 0);
		proc.line({ type: "agent_start" });
		assert.equal(sentOf(proc, "steer").length, 1);
		proc.line({ type: "agent_end", messages: [] });
		proc.line({ type: "agent_start" });
		assert.equal(sentOf(proc, "steer").length, 1, "sent once");
		assert.equal(sentOf(proc, "follow_up").length, 0);
		proc.line(settled());
		proc.close(0);
		assert.equal(failed(await promise), false);
	});

	it("a held wrap-up is dropped when the run settles before another turn", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(60_000);
		proc.line(assistant("done"));
		proc.line(settled());
		proc.close(0);
		const result = await promise;
		assert.equal(failed(result), false);
		assert.equal(proc.stdin.records().filter((r) => r.type === "steer" || r.type === "follow_up").length, 0);
		assert.equal(h.time.pending(), 0);
	});

	it("a steer the child rejects falls back to one follow-up", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		const [steer] = sentOf(proc, "steer");
		proc.line({ type: "response", id: steer.id, command: "steer", success: false, error: "not streaming" });
		await tick();
		const followUps = sentOf(proc, "follow_up");
		assert.equal(followUps.length, 1);
		assert.match(followUps[0].message, /structured_output/);
		proc.line({ type: "response", id: followUps[0].id, command: "follow_up", success: true });
		await tick();
		h.time.advance(10_000);
		proc.close(143);
		assert.equal((await promise).errorMessage, "over budget: no result 0.2 min after the 1 min wrap-up request");
	});

	it("a rejected steer followed by an unanswered follow-up keeps the steer's rejection in the failure", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		proc.line({ type: "response", id: sentOf(proc, "steer")[0].id, command: "steer", success: false, error: "Agent is compacting" });
		await tick();
		assert.equal(sentOf(proc, "follow_up").length, 1);
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.close(143);
		const result = await promise;
		assert.equal(result.errorMessage, "over budget: no result 0.2 min after the 1 min budget; the child rejected the wrap-up steer (Agent is compacting) and never acknowledged the follow-up");
		assert.equal(classifyFailure(result.stopReason, result.errorMessage), undefined, "still never falls back");
	});

	it("the over-budget failure says when the wrap-up never reached the child", async () => {
		const cases: Array<[string, (proc: FakeChild) => Promise<void>, RegExp]> = [
			["no turn started", async () => undefined, /; the wrap-up request was never sent: the child started no turn$/],
			[
				"no answer",
				async (proc) => void proc.line({ type: "agent_start" }),
				/; the child never acknowledged the wrap-up request$/,
			],
			[
				"rejected twice",
				async (proc) => {
					proc.line({ type: "agent_start" });
					h!.time.advance(60_000);
					proc.line({ type: "response", id: sentOf(proc, "steer")[0].id, command: "steer", success: false, error: "busy" });
					await tick();
					proc.line({ type: "response", id: sentOf(proc, "follow_up")[0].id, command: "follow_up", success: false, error: "Agent is shutting down" });
					await tick();
				},
				/; the child rejected the wrap-up request: Agent is shutting down$/,
			],
		];
		let h: ReturnType<typeof harness> | undefined;
		for (const [label, act, expected] of cases) {
			h = harness(budgeted);
			const promise = h.start();
			const proc = await h.ready();
			await act(proc);
			if (label !== "rejected twice") h.time.advance(60_000);
			h.time.advance(10_000);
			assert.deepEqual(proc.kills, ["SIGTERM"], label);
			proc.close(143);
			const result = await promise;
			assert.match(result.errorMessage ?? "", /^over budget: no result 0\.2 min after the 1 min budget/, label);
			assert.match(result.errorMessage ?? "", expected, label);
		}
	});

	it("an AbortSignal abort in progress gets no wrap-up and no second terminate", async () => {
		const controller = new AbortController();
		const h = harness({ ...budgeted, signal: controller.signal });
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(59_000);
		controller.abort();
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(1_000);
		assert.equal(proc.stdin.records().filter((r) => r.type === "steer" || r.type === "follow_up").length, 0);
		proc.close(143);
		await assert.rejects(promise, /Subagent was aborted/);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
	});

	it("terminates a child with no result after the wrap-up grace, as a failure that does not fall back", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		h.time.advance(9_999);
		assert.deepEqual(proc.kills, []);
		h.time.advance(1);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.close(143);
		const result = await promise;
		assert.equal(result.exitCode, 1);
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /^over budget: /);
		assert.ok(failed(result));
	});

	it("a run that settles inside its budget gets no wrap-up and leaves no timer", async () => {
		const h = harness(budgeted);
		const promise = h.start();
		const proc = await h.ready();
		proc.line(assistant("done"));
		proc.line(settled());
		proc.close(0);
		await promise;
		h.time.advance(120_000);
		assert.deepEqual(sentOf(proc, "steer"), []);
		assert.deepEqual(sentOf(proc, "follow_up"), []);
		assert.equal(h.time.pending(), 0);
	});

	it("an agent without budgetMinutes is never asked to wrap up", async () => {
		const h = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "999999999" } });
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60 * 60_000);
		assert.deepEqual(sentOf(proc, "steer"), []);
		assert.deepEqual(proc.kills, []);
		proc.line(settled());
		proc.close(0);
		await promise;
	});

	it("a user abort in progress gets no wrap-up and stays the cause", async () => {
		let control: ChildControl | undefined;
		const h = harness({ ...budgeted, onControl: (c) => void (c && (control = c)) });
		const promise = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(59_000);
		control!.abort();
		h.time.advance(1_000);
		assert.deepEqual([...sentOf(proc, "steer"), ...sentOf(proc, "follow_up")], []);
		proc.close(143);
		assert.equal((await promise).errorMessage, "Aborted by the user");

		let late: ChildControl | undefined;
		const h2 = harness({ ...budgeted, onControl: (c) => void (c && (late = c)) });
		const promise2 = h2.start();
		const proc2 = await h2.ready();
		proc2.line({ type: "agent_start" });
		h2.time.advance(68_000);
		late!.abort();
		h2.time.advance(2_000);
		proc2.close(143);
		const result2 = await promise2;
		assert.equal(result2.stopReason, "aborted");
		assert.equal(result2.errorMessage, "Aborted by the user");
	});

	it("a stall that already terminated the child keeps the stall as the cause", async () => {
		const h = harness({ agent: { budgetMinutes: 1 }, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000", BRIGADEV_STALL_TIMEOUT_MS: "65000" } });
		const promise = h.start();
		const proc = await h.ready();
		h.time.advance(65_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(10_000);
		proc.close(143);
		const result = await promise;
		assert.match(result.errorMessage ?? "", /^stalled for /);
	});
});

describe("runChild: no wrap-up write once over budget has terminated the child", () => {
	const B = { agent: { budgetMinutes: 1 }, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000", BRIGADEV_STALL_TIMEOUT_MS: "999999999" } };
	const wraps = (proc: FakeChild) => proc.stdin.records().filter((r) => r.type === "steer" || r.type === "follow_up").map((r) => r.type);

	it("a held wrap-up is not steered into a turn that starts after the over-budget terminate", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		h.time.advance(60_000);
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.line({ type: "agent_start" });
		assert.deepEqual(wraps(proc), []);
		proc.close(143);
		const r = await p;
		assert.equal(r.errorMessage, "over budget: no result 0.2 min after the 1 min budget; the wrap-up request was never sent: the child started no turn");
		assert.equal(h.time.pending(), 0);
	});

	it("a steer rejected after the over-budget terminate gets no follow-up", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		const [steer] = proc.stdin.records().filter((r) => r.type === "steer");
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.line({ type: "response", id: steer.id, command: "steer", success: false, error: "Agent is shutting down" });
		await tick();
		assert.deepEqual(wraps(proc), ["steer"]);
		proc.close(143);
		const r = await p;
		assert.equal(r.errorMessage, "over budget: no result 0.2 min after the 1 min budget; the child never acknowledged the wrap-up request");
		assert.equal(h.time.pending(), 0);
	});
});

describe("runChild: run budget races", () => {
	const B = { agent: { budgetMinutes: 1 }, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000", BRIGADEV_STALL_TIMEOUT_MS: "999999999" } };
	const wraps = (proc: FakeChild) => proc.stdin.records().filter((r) => r.type === "steer" || r.type === "follow_up");

	it("sends exactly one wrap-up across later turns", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		proc.line({ type: "agent_end", messages: [] });
		proc.line({ type: "agent_start" });
		h.time.advance(5_000);
		assert.deepEqual(wraps(proc).map((r) => r.type), ["steer"]);
		assert.deepEqual(proc.kills, []);
		proc.line(assistant("ok"));
		proc.line(settled());
		proc.close(0);
		const r = await p;
		assert.equal(r.exitCode, 0);
		assert.ok(!failed(r));
		assert.equal(h.time.pending(), 0);
	});

	it("a child that exits inside the grace without settling keeps its result", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		proc.line(assistant("partial"));
		proc.close(0);
		const r = await p;
		assert.equal(r.exitCode, 0);
		assert.ok(!failed(r));
		assert.equal(output(r), "partial");
		assert.equal(h.time.pending(), 0);
	});

	it("an exit inside the grace wins over a wrap-up expiry that fires before close", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		h.time.advance(60_000);
		proc.line(assistant("partial"));
		h.time.advance(9_500);
		proc.emit("exit", 0);
		h.time.advance(600);
		assert.deepEqual(proc.kills, []);
		proc.close(0);
		const r = await p;
		assert.equal(r.exitCode, 0);
		assert.ok(!failed(r));
		assert.equal(h.time.pending(), 0);
	});

	it("over budget escalates to SIGKILL and stays the cause over a later stall", async () => {
		const h = harness({ agent: { budgetMinutes: 1 }, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000", BRIGADEV_STALL_TIMEOUT_MS: "72000" } });
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		h.time.advance(60_000);
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(2_000);
		assert.deepEqual(proc.kills, ["SIGTERM"], "the stall does not terminate again");
		h.time.advance(3_000);
		assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"]);
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.close(null);
		const r = await p;
		assert.equal(r.exitCode, 1);
		assert.equal(r.stopReason, "error");
		assert.match(r.errorMessage ?? "", /^over budget: /);
		assert.equal(h.time.pending(), 0);
	});

	it("no wrap-up is written to a broken pipe or after a rejected prompt", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		proc.stdin.emit("error", new Error("EPIPE"));
		h.time.advance(60_000);
		assert.equal(proc.stdin.late, 0);
		assert.equal(wraps(proc).length, 0);
		proc.close(1);
		await p;

		const h2 = harness(B);
		const p2 = h2.start();
		const proc2 = await h2.ready();
		proc2.line({ type: "response", command: "prompt", success: false, error: "nope" });
		h2.time.advance(60_000);
		h2.time.advance(10_000);
		assert.equal(wraps(proc2).length, 0);
		assert.equal(proc2.stdin.late, 0);
		proc2.close(0);
		assert.match((await p2).errorMessage ?? "", /Pi rejected/);
	});

	it("BRIGADEV_RUN_BUDGET=off (any case) arms no budget timer", async () => {
		const base = harness({ env: { BRIGADEV_STALL_TIMEOUT_MS: "999999999" } });
		const pb = base.start();
		const procB = await base.ready();
		const timers = base.time.pending();
		procB.line(settled());
		procB.close(0);
		await pb;
		for (const off of ["off", " OFF "]) {
			const h = harness({ agent: { budgetMinutes: 1 }, env: { BRIGADEV_RUN_BUDGET: off, BRIGADEV_STALL_TIMEOUT_MS: "999999999" } });
			const p = h.start();
			const proc = await h.ready();
			assert.equal(h.time.pending(), timers);
			h.time.advance(60 * 60_000);
			assert.equal(wraps(proc).length, 0);
			assert.deepEqual(proc.kills, []);
			proc.line(settled());
			proc.close(0);
			await p;
		}
	});
});

describe("runChild: a finished structured result survives the wrap-up grace", () => {
	const schema = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } };
	const B = { agent: { budgetMinutes: 1, outputSchema: "/x/schema.json" }, schema, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000", BRIGADEV_STALL_TIMEOUT_MS: "999999999" } };
	const call = (args: unknown) => ({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "structured_output", arguments: args }], stopReason: "toolUse" } });
	const toolResult = (isError: boolean) => ({ type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "structured_output", isError, content: [] } });

	it("an accepted, valid call that has not settled when the grace expires is the run's result, and the child is still stopped", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call({ verdict: "ok" }));
		proc.line(toolResult(false));
		h.time.advance(60_000);
		h.time.advance(10_000);
		assert.equal(proc.stdin.ended, true, "input is closed so the child can exit");
		h.time.advance(EXIT_GRACE_MS);
		assert.deepEqual(proc.kills, ["SIGTERM"], "the child that never settled is stopped");
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.close(143);
		const r = await p;
		assert.deepEqual(r.structured, { verdict: "ok" });
		assert.equal(r.exitCode, 0);
		assert.notEqual(r.stopReason, "error");
		assert.equal(r.errorMessage, undefined);
		assert.ok(!failed(r));
		assert.equal(h.time.pending(), 0);
	});

	it("an invalid payload is still over budget", async () => {
		const h = harness(B);
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call({ verdict: 7 }));
		proc.line(toolResult(false));
		h.time.advance(60_000);
		h.time.advance(10_000);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.close(143);
		const r = await p;
		assert.equal(r.exitCode, 1);
		assert.equal(r.stopReason, "error");
		assert.match(r.errorMessage ?? "", /^over budget: /);
		assert.equal(r.structured, undefined);
	});

	it("a call the child's tool rejected, or none at all, is still over budget", async () => {
		for (const lines of [[call({ verdict: "ok" }), toolResult(true)], [call({ verdict: "ok" })], [assistant("working")]]) {
			const h = harness(B);
			const p = h.start();
			const proc = await h.ready();
			proc.line({ type: "agent_start" });
			for (const line of lines) proc.line(line);
			h.time.advance(60_000);
			h.time.advance(10_000);
			assert.deepEqual(proc.kills, ["SIGTERM"]);
			proc.close(143);
			const r = await p;
			assert.equal(r.exitCode, 1);
			assert.match(r.errorMessage ?? "", /^over budget: /);
			assert.equal(r.structured, undefined);
		}
	});

	it("a user abort after the grace expired still wins over the kept result", async () => {
		let control: ChildControl | undefined;
		const h = harness({ ...B, onControl: (c) => void (c && (control = c)) });
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call({ verdict: "ok" }));
		proc.line(toolResult(false));
		h.time.advance(70_000);
		control?.abort();
		proc.close(143);
		const r = await p;
		assert.equal(r.stopReason, "aborted");
		assert.equal(r.errorMessage, "Aborted by the user");
	});

	it("an AbortSignal abort still rejects the run", async () => {
		const controller = new AbortController();
		const h = harness({ ...B, signal: controller.signal });
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call({ verdict: "ok" }));
		proc.line(toolResult(false));
		h.time.advance(70_000);
		controller.abort();
		proc.close(143);
		await assert.rejects(p, /Subagent was aborted/);
	});
});

describe("runChild: a kept structured result survives the child's own shutdown", () => {
	const schema = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } };
	const B = { agent: { budgetMinutes: 1, outputSchema: "/x/schema.json" }, schema, env: { BRIGADEV_WRAP_UP_GRACE_MS: "10000", BRIGADEV_STALL_TIMEOUT_MS: "999999999" } };
	const call = { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "structured_output", arguments: { verdict: "ok" } }], stopReason: "toolUse" } };
	const toolResult = { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "structured_output", isError: false, content: [] } };
	const start = async (signal?: AbortSignal) => {
		const h = harness({ ...B, signal });
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call);
		proc.line(toolResult);
		h.time.advance(60_000);
		h.time.advance(10_000);
		assert.equal(proc.stdin.ended, true);
		return { h, p, proc };
	};

	it("the child aborts its unsettled turn on the stdin close and exits inside the exit grace: the result is kept", async () => {
		const { h, p, proc } = await start();
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.line({ type: "agent_end" });
		proc.close(0);
		const r = await p;
		assert.deepEqual(r.structured, { verdict: "ok" });
		assert.equal(r.exitCode, 0);
		assert.notEqual(r.stopReason, "error");
		assert.notEqual(r.stopReason, "aborted");
		assert.equal(r.errorMessage, undefined);
		assert.ok(!failed(r));
		assert.deepEqual(proc.kills, []);
		assert.equal(h.time.pending(), 0);
	});

	it("the child exits nonzero on its own inside the exit grace: the result is kept", async () => {
		const { h, p, proc } = await start();
		h.time.advance(1_000);
		proc.close(1);
		const r = await p;
		assert.deepEqual(r.structured, { verdict: "ok" });
		assert.equal(r.exitCode, 0);
		assert.ok(!failed(r));
		assert.equal(h.time.pending(), 0);
	});

	it("an aborted message with an error, then exit 1 on its own: the result is kept", async () => {
		const { p, proc } = await start();
		proc.line(assistant("", { stopReason: "aborted", errorMessage: "Request was aborted" }));
		proc.close(1);
		const r = await p;
		assert.deepEqual(r.structured, { verdict: "ok" });
		assert.equal(r.exitCode, 0);
		assert.equal(r.errorMessage, undefined);
		assert.ok(!failed(r));
	});

	it("the child exits 1 and close never comes (drain timeout): the result is kept", async () => {
		const { h, p, proc } = await start();
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.emit("exit", 1);
		h.time.advance(CLOSE_DRAIN_MS);
		const r = await p;
		assert.deepEqual(r.structured, { verdict: "ok" });
		assert.equal(r.exitCode, 0);
		assert.ok(!failed(r));
	});

	it("a user abort sent before the grace ends still wins when the child then closes on its own", async () => {
		let control: ChildControl | undefined;
		const h = harness({ ...B, onControl: (c) => void (c && (control = c)) });
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call);
		proc.line(toolResult);
		h.time.advance(60_000);
		h.time.advance(5_000);
		assert.equal(control!.abort(), true);
		h.time.advance(5_000);
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.line({ type: "agent_end" });
		proc.close(0);
		const r = await p;
		assert.equal(r.stopReason, "aborted");
		assert.equal(r.errorMessage, "Aborted by the user");
		assert.ok(failed(r));
	});

	it("a captured handle cannot abort once the result is kept (stdin closed): the result stands", async () => {
		let control: ChildControl | undefined;
		const h = harness({ ...B, onControl: (c) => void (c && (control = c)) });
		const p = h.start();
		const proc = await h.ready();
		proc.line({ type: "agent_start" });
		proc.line(call);
		proc.line(toolResult);
		h.time.advance(60_000);
		h.time.advance(10_000);
		assert.equal(control!.abort(), false);
		assert.equal(proc.stdin.late, 0);
		proc.close(0);
		const r = await p;
		assert.deepEqual(r.structured, { verdict: "ok" });
		assert.equal(r.exitCode, 0);
		assert.ok(!failed(r));
	});

	it("an AbortSignal abort after the kept result still rejects the run", async () => {
		const controller = new AbortController();
		const { p, proc } = await start(controller.signal);
		controller.abort();
		proc.line(assistant("", { stopReason: "aborted" }));
		proc.close(0);
		await assert.rejects(p, /Subagent was aborted/);
	});
});

describe("runChild: structured output", () => {
	const schema = { type: "object", required: ["verdict"], properties: { verdict: { type: "string" } } };
	const call = { type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "structured_output", arguments: { verdict: "ok" } }], stopReason: "toolUse" } };
	const accepted = { type: "message_end", message: { role: "toolResult", toolCallId: "c1", toolName: "structured_output", isError: false, content: [] } };

	it("keeps the validated payload", async () => {
		const h = harness({ agent: { outputSchema: "/x/schema.json" }, schema });
		const promise = h.start();
		const proc = await h.ready();
		assert.ok(h.spawned!.args.includes(STRUCTURED_OUTPUT_EXTENSION_PATH));
		proc.line(call);
		proc.line(accepted);
		proc.close(0);
		const result = await promise;
		assert.deepEqual(result.structured, { verdict: "ok" });
		assert.ok(!failed(result));
	});

	it("fails a run that finished without calling structured_output", async () => {
		const h = harness({ agent: { outputSchema: "/x/schema.json" }, schema });
		const promise = h.start();
		const proc = await h.ready();
		proc.line(assistant("done, no payload"));
		proc.close(0);
		const result = await promise;
		assert.equal(result.stopReason, "error");
		assert.equal(result.errorMessage, "Subagent finished without calling structured_output.");
		assert.ok(failed(result));
		assert.equal(JSON.parse(h.saved(result, "result.json")).stopReason, "error");
	});
});

describe("runChild: artifacts", () => {
	it("a failed artifact write never fails the run", async () => {
		const h = harness();
		fs.writeFileSync(path.join(h.docs, "runs"), "not a folder"); // mkdir <docs>/runs/<id> now fails
		const promise = h.start();
		const proc = await h.ready();
		proc.line(assistant("fine"));
		proc.close(0);
		const result = await promise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.artifactsDir, undefined);
	});
});

/** Resolves true when the promise settled within a real 300 ms, false when it is still pending (a hang). */
const settlesSoon = (promise: Promise<unknown>) =>
	Promise.race([promise.then(() => true, () => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 300).unref())]);

describe("runChild: a throwing caller hook never stops the run from settling (R4-001)", () => {
	it("onUpdate throwing in a data chunk does not escape the stream handler; the run still settles with its output", async () => {
		const h = harness({
			onUpdate: () => {
				throw new Error("ui hook bug");
			},
		});
		const promise = h.start();
		const proc = await h.ready();
		assert.doesNotThrow(() => proc.line(assistant("first")));
		assert.doesNotThrow(() => proc.line(assistant("second")), "every line is folded even though the hook threw on the one before");
		assert.doesNotThrow(() => proc.line(settled()));
		assert.doesNotThrow(() => proc.close(0));
		assert.equal(await settlesSoon(promise), true, "settled");
		const result = await promise;
		assert.equal(result.exitCode, 0);
		assert.equal(result.messages.length, 2);
		assert.equal(output(result), "second");
		assert.equal(h.time.pending(), 0, "no timer is left armed");
	});

	it("onUpdate throwing on the last line (flushed by close) still reaches settlement", async () => {
		const h = harness({
			onUpdate: () => {
				throw new Error("ui hook bug");
			},
		});
		const promise = h.start();
		const proc = await h.ready();
		proc.say(JSON.stringify(assistant("tail without newline")));
		assert.doesNotThrow(() => proc.close(0));
		assert.equal(await settlesSoon(promise), true, "the close handler reached settlement");
		const result = await promise;
		assert.equal(output(result), "tail without newline");
		assert.equal(h.time.pending(), 0);
		assert.deepEqual(fs.readdirSync(h.tmpRoot), [], "the temp folder is removed");
	});

	it("onControl throwing (the handle, and its withdrawal) does not break the run", async () => {
		let calls = 0;
		const h = harness({
			onControl: () => {
				calls++;
				throw new Error("control hook bug");
			},
		});
		const promise = h.start();
		const proc = await h.ready();
		assert.equal(calls, 1, "the handle was offered");
		proc.line(assistant("ok"));
		assert.doesNotThrow(() => proc.line(settled()));
		assert.doesNotThrow(() => proc.close(0));
		assert.equal(await settlesSoon(promise), true);
		assert.equal(calls, 2, "the withdrawal was attempted too");
		assert.equal((await promise).exitCode, 0);
		assert.equal(h.time.pending(), 0);
	});

	it("a hook that throws on every call cannot stop a user abort or a stall from settling the run", async () => {
		const h = harness({
			env: { BRIGADEV_STALL_TIMEOUT_MS: "1000" },
			onUpdate: () => {
				throw new Error("ui hook bug");
			},
		});
		const promise = h.start();
		const proc = await h.ready();
		proc.line(delta("working"));
		assert.doesNotThrow(() => h.time.advance(5000), "the watchdog's termination is not blocked by the hook");
		assert.ok(proc.kills.includes("SIGTERM"));
		proc.close(null);
		assert.equal(await settlesSoon(promise), true);
		assert.equal((await promise).stopReason, "error");
	});
});

describe("runChild: the run settles when the child exits even if `close` never comes (R4-003a)", () => {
	it("settles CLOSE_DRAIN_MS after `exit` without `close`, keeping the output it already read", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		let done = false;
		void promise.then(() => (done = true));
		proc.line(assistant("answer"));
		proc.say(JSON.stringify(assistant("last line, no newline")));
		proc.emit("exit", 0, null); // a grandchild holds the pipes: `close` never follows
		h.time.advance(CLOSE_DRAIN_MS - 1);
		await tick();
		assert.equal(done, false, "still draining output");
		h.time.advance(1);
		assert.equal(await settlesSoon(promise), true);
		const result = await promise;
		assert.equal(result.exitCode, 0);
		assert.equal(output(result), "last line, no newline");
		assert.equal(h.time.pending(), 0);
		assert.deepEqual(fs.readdirSync(h.tmpRoot), []);
	});

	it("a `close` that follows `exit` in time settles at once with the output that arrived in between", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.emit("exit", 3, null);
		proc.line(assistant("flushed after exit"));
		proc.close(3);
		const result = await promise;
		assert.equal(result.exitCode, 3);
		assert.equal(output(result), "flushed after exit");
		assert.equal(h.time.pending(), 0, "the drain timer was cleared by close");
	});

	it("output arriving after the run settled does not change its result", async () => {
		const h = harness();
		const promise = h.start();
		const proc = await h.ready();
		proc.line(assistant("before"));
		proc.emit("exit", 0, null);
		h.time.advance(CLOSE_DRAIN_MS);
		const result = await promise;
		assert.doesNotThrow(() => proc.line(assistant("too late")));
		proc.stderr.emit("data", Buffer.from("too late"));
		proc.close(0);
		assert.equal(output(result), "before");
		assert.equal(result.stderr, "");
	});

	it("a user abort whose child exits but never closes still settles (the cancel case)", async () => {
		const controller = new AbortController();
		const h = harness({ signal: controller.signal });
		const promise = h.start();
		const proc = await h.ready();
		controller.abort();
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		proc.emit("exit", null, "SIGTERM");
		h.time.advance(CLOSE_DRAIN_MS);
		assert.equal(await settlesSoon(promise), true);
		await assert.rejects(promise, /aborted/);
		assert.equal(h.time.pending(), 0, "the SIGKILL timer is gone");
	});
});

describe("runChild: the child runs in its own process group and signals reach the group (R4-003b)", () => {
	const groupHarness = (over: Parameters<typeof harness>[0] = {}) => {
		const groupKills: Array<[number, string]> = [];
		const h = harness({
			...over,
			deps: {
				platform: "linux",
				killGroup: (pid, signal) => void groupKills.push([pid, signal]),
				...over.deps,
			},
		});
		return { h, groupKills };
	};

	it("spawns detached (a new group) off Windows, and not on win32", async () => {
		const linux = groupHarness();
		const p1 = linux.h.start();
		const c1 = await linux.h.ready();
		assert.equal(linux.h.spawned!.options.detached, true);
		c1.close(0);
		await p1;
		const win = groupHarness({ deps: { platform: "win32" } });
		const p2 = win.h.start();
		const c2 = await win.h.ready();
		assert.equal(win.h.spawned!.options.detached, false);
		c2.close(0);
		await p2;
	});

	it("abort signals the group with SIGTERM, then SIGKILL after the grace, instead of the lone child", async () => {
		const controller = new AbortController();
		const { h, groupKills } = groupHarness({ signal: controller.signal });
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 4242;
		controller.abort();
		assert.deepEqual(groupKills, [[4242, "SIGTERM"]]);
		h.time.advance(KILL_GRACE_MS);
		assert.deepEqual(groupKills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
		assert.deepEqual(proc.kills, [], "the group signal covers the child");
		proc.close(null);
		await assert.rejects(promise, /aborted/);
	});

	it("falls back to the child itself when signalling the group throws", async () => {
		const controller = new AbortController();
		const attempts: string[] = [];
		const { h } = groupHarness({
			signal: controller.signal,
			deps: {
				killGroup: (pid, signal) => {
					attempts.push(`${pid}:${signal}`);
					throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
				},
			},
		});
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 77;
		controller.abort();
		assert.deepEqual(attempts, ["77:SIGTERM"]);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		h.time.advance(KILL_GRACE_MS);
		assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"]);
		proc.close(null);
		await assert.rejects(promise, /aborted/);
	});

	it("signals the child alone when it has no pid, and on win32 even with one", async () => {
		for (const [platform, pid] of [["linux", undefined], ["win32", 99]] as const) {
			const controller = new AbortController();
			const { h, groupKills } = groupHarness({ signal: controller.signal, deps: { platform } });
			const promise = h.start();
			const proc = await h.ready();
			proc.pid = pid;
			controller.abort();
			assert.deepEqual(groupKills, [], platform);
			assert.deepEqual(proc.kills, ["SIGTERM"], platform);
			proc.close(null);
			await assert.rejects(promise, /aborted/);
		}
	});

	it("a child that exited but left the pipes held is cleaned up: the group gets SIGKILL when the drain gives up", async () => {
		const { h, groupKills } = groupHarness();
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 555;
		proc.emit("exit", 0, null);
		assert.deepEqual(groupKills, [], "nothing is killed while output may still drain");
		h.time.advance(CLOSE_DRAIN_MS);
		await promise;
		assert.deepEqual(groupKills, [[555, "SIGKILL"]]);
	});

	it("a normal exit and close never signal anything", async () => {
		const { h, groupKills } = groupHarness();
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 556;
		proc.emit("exit", 0, null);
		proc.close(0);
		await promise;
		assert.deepEqual(groupKills, []);
		assert.deepEqual(proc.kills, []);
	});
});

describe("createChildTracker: every live child in one place, with a bounded forced shutdown (R4-002)", () => {
	it("tracks a running child from spawn until the run settles, sync or async alike", async () => {
		const tracker = createChildTracker();
		const h = harness({ deps: { tracker } });
		const promise = h.start();
		const proc = await h.ready();
		assert.equal(tracker.size(), 1);
		proc.close(0);
		await promise;
		assert.equal(tracker.size(), 0);
	});

	it("a spawn error releases the child too", async () => {
		const tracker = createChildTracker();
		const h = harness({ deps: { tracker } });
		const promise = h.start();
		const proc = await h.ready();
		proc.emit("error", new Error("ENOENT"));
		await promise;
		assert.equal(tracker.size(), 0);
	});

	it("killAll signals every tracked child's group now", async () => {
		const tracker = createChildTracker({ listProcesses: () => [] });
		const groupKills: Array<[number, string]> = [];
		const deps: Partial<ChildRunDeps> = { tracker, platform: "linux", killGroup: (pid, signal) => void groupKills.push([pid, signal]) };
		const a = harness({ deps });
		const b = harness({ deps });
		const pa = a.start();
		const pb = b.start();
		(await a.ready()).pid = 11;
		(await b.ready()).pid = 12;
		tracker.killAll("SIGKILL");
		// Each run spawns after its own async temp-dir setup, so the two register in either order.
		assert.deepEqual(groupKills.sort(([x], [y]) => x - y), [[11, "SIGKILL"], [12, "SIGKILL"]]);
		a.proc!.close(null);
		b.proc!.close(null);
		await Promise.all([pa, pb]);
	});

	it("shutdown: SIGTERM, resolves as soon as every child settled, no SIGKILL", async () => {
		const tracker = createChildTracker();
		const time = fakeTime();
		const h = harness({ deps: { tracker } });
		const promise = h.start();
		const proc = await h.ready();
		let shut = false;
		const shutdown = tracker.shutdown({ graceMs: 6000, setTimer: time.setTimer, clearTimer: time.clearTimer }).then(() => (shut = true));
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		await tick();
		assert.equal(shut, false);
		proc.close(null);
		await promise.catch(() => undefined);
		await shutdown;
		assert.deepEqual(proc.kills, ["SIGTERM"], "no SIGKILL for a child that stopped");
		assert.equal(time.pending(), 0, "the grace timer is cleared");
	});

	it("shutdown: a child that ignores SIGTERM is SIGKILLed after the grace and shutdown still returns", async () => {
		const tracker = createChildTracker();
		const time = fakeTime();
		const h = harness({ deps: { tracker } });
		const promise = h.start();
		const proc = await h.ready();
		let shut = false;
		const shutdown = tracker.shutdown({ graceMs: 6000, setTimer: time.setTimer, clearTimer: time.clearTimer }).then(() => (shut = true));
		time.advance(5999);
		await tick();
		assert.equal(shut, false);
		assert.deepEqual(proc.kills, ["SIGTERM"]);
		time.advance(1);
		await shutdown;
		assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"], "survivors are killed before shutdown returns");
		proc.close(null);
		await promise.catch(() => undefined);
	});

	it("shutdown with no live child resolves at once and arms nothing", async () => {
		const time = fakeTime();
		await createChildTracker().shutdown({ graceMs: 6000, setTimer: time.setTimer, clearTimer: time.clearTimer });
		assert.equal(time.pending(), 0);
	});

	it("a kill function that throws does not stop the others or the shutdown", async () => {
		const tracker = createChildTracker();
		const seen: string[] = [];
		tracker.add(() => {
			throw new Error("gone");
		});
		tracker.add((signal) => void seen.push(signal));
		const time = fakeTime();
		const shutdown = tracker.shutdown({ graceMs: 10, setTimer: time.setTimer, clearTimer: time.clearTimer });
		time.advance(10);
		await shutdown;
		assert.deepEqual(seen, ["SIGTERM", "SIGKILL"]);
	});

	it("R4-101 killAllNow SIGKILLs every tracked child group synchronously and never throws", async () => {
		const tracker = createChildTracker({ listProcesses: () => [] });
		tracker.killAllNow(); // nothing tracked
		const groupKills: Array<[number, string]> = [];
		const deps: Partial<ChildRunDeps> = { tracker, platform: "linux", killGroup: (pid, signal) => void groupKills.push([pid, signal]) };
		const a = harness({ deps });
		const b = harness({ deps });
		const pa = a.start();
		const pb = b.start();
		(await a.ready()).pid = 21;
		(await b.ready()).pid = 22;
		tracker.killAllNow();
		// Each run spawns after its own async temp-dir setup, so the two register in either order.
		assert.deepEqual(groupKills.sort(([x], [y]) => x - y), [[21, "SIGKILL"], [22, "SIGKILL"]]);
		a.proc!.close(null);
		b.proc!.close(null);
		await Promise.all([pa, pb]);
	});

	it("R4-101 killAllNow with a throwing kill function does not throw and still reaches the others", () => {
		const tracker = createChildTracker();
		const seen: string[] = [];
		tracker.add(() => {
			throw new Error("gone");
		});
		tracker.add((signal) => void seen.push(signal));
		assert.doesNotThrow(() => tracker.killAllNow());
		assert.deepEqual(seen, ["SIGKILL"]);
	});

	it("R4-101 killAllNow falls back to the child itself when the group kill throws (the same path as terminate)", async () => {
		const tracker = createChildTracker({ listProcesses: () => [] });
		const h = harness({ deps: { tracker, platform: "linux", killGroup: () => { throw new Error("ESRCH"); } } });
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 31;
		tracker.killAllNow();
		assert.deepEqual(proc.kills, ["SIGKILL"]);
		proc.close(null);
		await promise;
	});
});

/** A stand-in for `process`: records listeners, lets a test fire them, and records exit codes. */
function fakeProcess(others: Record<string, number> = {}) {
	const listeners = new Map<string, Array<() => void>>();
	const exits: Array<number | undefined> = [];
	const proc = {
		on(event: string, listener: () => void) {
			listeners.set(event, [...(listeners.get(event) ?? []), listener]);
			return proc;
		},
		listenerCount: (event: string) => (listeners.get(event)?.length ?? 0) + (others[event] ?? 0),
		exit: (code?: number) => void exits.push(code),
	};
	return { proc: proc as unknown as ParentProcessLike, listeners, exits, fire: (event: string) => (listeners.get(event) ?? []).forEach((l) => l()) };
}

describe("installParentExitGuard: children do not outlive a parent that exits without session_shutdown (R4-101)", () => {
	/** A tracker with two children whose kills are recorded. */
	function tracked() {
		const tracker = createChildTracker();
		const kills: string[] = [];
		tracker.add((s) => void kills.push(`a:${s}`));
		tracker.add((s) => void kills.push(`b:${s}`));
		return { tracker, kills };
	}

	it("the process 'exit' event SIGKILLs every tracked child, synchronously", () => {
		const { tracker, kills } = tracked();
		const p = fakeProcess();
		installParentExitGuard(tracker, { processLike: p.proc });
		assert.equal(p.listeners.get("exit")?.length, 1);
		p.fire("exit");
		assert.deepEqual(kills, ["a:SIGKILL", "b:SIGKILL"]);
	});

	it("installing again (extension reloaded) adds no second listener, and the new tracker is covered too", () => {
		const first = tracked();
		const second = tracked();
		const p = fakeProcess();
		installParentExitGuard(first.tracker, { processLike: p.proc, signals: ["SIGHUP"] });
		installParentExitGuard(second.tracker, { processLike: p.proc, signals: ["SIGHUP"] });
		installParentExitGuard(second.tracker, { processLike: p.proc, signals: ["SIGHUP"] });
		assert.equal(p.listeners.get("exit")?.length, 1);
		assert.equal(p.listeners.get("SIGHUP")?.length, 1);
		p.fire("exit");
		assert.deepEqual(first.kills, ["a:SIGKILL", "b:SIGKILL"]);
		assert.deepEqual(second.kills, ["a:SIGKILL", "b:SIGKILL"]);
	});

	it("no signal listener is installed unless asked (Pi handles SIGTERM/SIGHUP itself)", () => {
		const p = fakeProcess();
		installParentExitGuard(createChildTracker(), { processLike: p.proc });
		assert.deepEqual([...p.listeners.keys()], ["exit"]);
	});

	it("a signal nobody else handles: kill the children, then exit with 128+signo", () => {
		const { tracker, kills } = tracked();
		const p = fakeProcess();
		installParentExitGuard(tracker, { processLike: p.proc, signals: ["SIGHUP", "SIGTERM"] });
		p.fire("SIGHUP");
		assert.deepEqual(kills, ["a:SIGKILL", "b:SIGKILL"]);
		assert.deepEqual(p.exits, [129]);
		p.fire("SIGTERM");
		assert.deepEqual(p.exits, [129, 143]);
	});

	it("a signal someone else handles: kill the children, do not exit (the other handler decides)", () => {
		const { tracker, kills } = tracked();
		const p = fakeProcess({ SIGTERM: 1 });
		installParentExitGuard(tracker, { processLike: p.proc, signals: ["SIGTERM"] });
		p.fire("SIGTERM");
		assert.deepEqual(kills, ["a:SIGKILL", "b:SIGKILL"]);
		assert.deepEqual(p.exits, []);
	});

	it("with nothing tracked, or a kill that throws, the handlers are safe", () => {
		const empty = fakeProcess();
		installParentExitGuard(createChildTracker(), { processLike: empty.proc, signals: ["SIGHUP"] });
		assert.doesNotThrow(() => empty.fire("exit"));
		assert.doesNotThrow(() => empty.fire("SIGHUP"));
		const tracker = createChildTracker();
		tracker.add(() => {
			throw new Error("gone");
		});
		const p = fakeProcess();
		installParentExitGuard(tracker, { processLike: p.proc, signals: ["SIGTERM"] });
		assert.doesNotThrow(() => p.fire("exit"));
		assert.doesNotThrow(() => p.fire("SIGTERM"));
		assert.deepEqual(p.exits, [143], "still exits after a kill that threw");
	});
});

// A child's bash tool runs its commands in their own process group, so the child's group kill misses them (D2).
// Pids: 100 is this (parent) process in group 100; 4242 is the child (its own group); 4300 -> 4301 and 4400 are descendants in other groups.
const PS = [
	{ pid: 100, ppid: 1, pgid: 100 },
	{ pid: 4242, ppid: 100, pgid: 4242 },
	{ pid: 4300, ppid: 4242, pgid: 4300 }, // the bash tool's command, its own group
	{ pid: 4301, ppid: 4300, pgid: 4300 }, // its helper, same group
	{ pid: 4400, ppid: 4301, pgid: 4400 }, // a grandchild that started yet another group
	{ pid: 4500, ppid: 4242, pgid: 4242 }, // a plain child in the child's own group
	{ pid: 9000, ppid: 1, pgid: 9000 }, // unrelated
];

describe("process table helpers (D2, S5)", () => {
	it("parseProcessList reads `pid ppid pgid` rows and skips anything else", () => {
		assert.deepEqual(parseProcessList("  1     0     1\n 20  1  20\nnot a row\n\n"), [{ pid: 1, ppid: 0, pgid: 1 }, { pid: 20, ppid: 1, pgid: 20 }]);
	});

	it("descendantTargets is bounded and cycle-safe, and refuses a root of 0, 1 or the parent itself", () => {
		const cycle = [{ pid: 100, ppid: 1, pgid: 100 }, { pid: 5, ppid: 6, pgid: 5 }, { pid: 6, ppid: 5, pgid: 6 }];
		assert.deepEqual(descendantTargets(5, cycle, 100).groups.map((g) => g.pgid), [6]);
		for (const root of [0, 1, 100, Number.NaN]) assert.deepEqual(descendantTargets(root, PS, 100), { groups: [], pids: [] });
		const wide = [{ pid: 100, ppid: 1, pgid: 100 }, ...Array.from({ length: 5000 }, (_, i) => ({ pid: 1000 + i, ppid: 50, pgid: 1000 + i }))];
		assert.ok(descendantTargets(50, wide, 100).groups.length <= 1001);
	});

	it("with the parent's group unknown, no group is trusted: descendants are signalled by pid", () => {
		assert.deepEqual(descendantTargets(4242, PS.filter((e) => e.pid !== 100), 100), { groups: [], pids: [4300, 4500, 4301, 4400] });
	});

	it("the default listing is the real process table: it holds this process, with its parent and group", () => {
		const me = listProcessesWithPs().find((e) => e.pid === process.pid);
		assert.equal(me?.ppid, process.ppid);
		assert.ok((me?.pgid ?? 0) > 1);
	});
});

describe("forced kills also reach the child's descendant process groups (D2, S5)", () => {
	const forcedHarness = (over: Parameters<typeof harness>[0] = {}, list: () => Array<{ pid: number; ppid: number; pgid: number }> = () => PS) => {
		const groupKills: Array<[number, string]> = [];
		const pidKills: Array<[number, string]> = [];
		let listed = 0;
		const h = harness({
			...over,
			deps: {
				platform: "linux",
				killGroup: (pid, signal) => void groupKills.push([pid, signal]),
				killPid: (pid, signal) => void pidKills.push([pid, signal]),
				listProcesses: () => {
					listed++;
					return list();
				},
				...over.deps,
			},
		});
		return { h, groupKills, pidKills, listed: () => listed };
	};
	const sorted = (kills: Array<[number, string]>) => [...kills].sort(([a], [b]) => a - b);

	it("the SIGKILL after the grace also kills descendants' groups; the SIGTERM before it does not list or signal them", async () => {
		const controller = new AbortController();
		const { h, groupKills, pidKills, listed } = forcedHarness({ signal: controller.signal });
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 4242;
		controller.abort();
		assert.deepEqual(groupKills, [[4242, "SIGTERM"]], "graceful: the child's group only, so it can clean up");
		assert.equal(listed(), 0, "the graceful path does not even list processes");
		h.time.advance(KILL_GRACE_MS);
		assert.equal(listed(), 1, "a single child's own forced kill lists once, for itself");
		assert.deepEqual(groupKills[1], [4242, "SIGKILL"], "the child's own group first");
		assert.deepEqual(sorted(groupKills.slice(2)), [[4300, "SIGKILL"], [4400, "SIGKILL"]]);
		assert.equal(groupKills.length, 4, "nothing unrelated, no duplicate of the child's group");
		assert.deepEqual(pidKills, []);
		proc.close(null);
		await assert.rejects(promise, /aborted/);
	});

	it("the close-drain SIGKILL ends the child's own group only and lists no processes (the child is gone: its descendants are reparented and its pid may be reused)", async () => {
		const { h, groupKills, pidKills, listed } = forcedHarness();
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 4242;
		proc.emit("exit", 0, null);
		h.time.advance(CLOSE_DRAIN_MS);
		await promise;
		assert.deepEqual(groupKills, [[4242, "SIGKILL"]]);
		assert.deepEqual(pidKills, []);
		assert.equal(listed(), 0, "no process listing after the child exited");
	});

	it("never signals pid/group 0 or 1, the parent's pid, or the parent's own group; a descendant in the parent's group is killed by pid", async () => {
		const hostile = [
			{ pid: 4242, ppid: 100, pgid: 4242 },
			{ pid: 100, ppid: 4242, pgid: 100 }, // the parent itself listed as a descendant (a bogus cycle)
			{ pid: 1, ppid: 4242, pgid: 1 },
			{ pid: 0, ppid: 4242, pgid: 0 },
			{ pid: 4600, ppid: 4242, pgid: 1 }, // group 1
			{ pid: 4601, ppid: 4242, pgid: 0 }, // group 0
			{ pid: 4602, ppid: 4242, pgid: 100 }, // in the parent's own group
			{ pid: 4700, ppid: 4242, pgid: 4700 }, // fine
		];
		const self = { pid: 100, ppid: 1, pgid: 100 };
		const controller = new AbortController();
		const { h, groupKills, pidKills } = forcedHarness({ signal: controller.signal }, () => [self, ...hostile]);
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 4242;
		controller.abort();
		h.time.advance(KILL_GRACE_MS);
		proc.close(null);
		await assert.rejects(promise, /aborted/);
		assert.deepEqual(groupKills, [[4242, "SIGTERM"], [4242, "SIGKILL"], [4700, "SIGKILL"]]);
		assert.deepEqual(pidKills, [[4602, "SIGKILL"]], "only a pid, never the parent's group");
	});

	it("a process list that fails (throws, or is empty) falls back to the existing behavior and never throws", async () => {
		for (const list of [() => { throw new Error("ps: not found"); }, () => []]) {
			const controller = new AbortController();
			const { h, groupKills, pidKills } = forcedHarness({ signal: controller.signal }, list);
			const promise = h.start();
			const proc = await h.ready();
			proc.pid = 4242;
			controller.abort();
			h.time.advance(KILL_GRACE_MS);
			assert.deepEqual(groupKills, [[4242, "SIGTERM"], [4242, "SIGKILL"]]);
			assert.deepEqual(pidKills, []);
			proc.close(null);
			await assert.rejects(promise, /aborted/);
		}
	});

	it("a descendant group that cannot be signalled falls back to its pids", async () => {
		const controller = new AbortController();
		const { h, pidKills } = forcedHarness({ signal: controller.signal, deps: { killGroup: (pid) => { if (pid !== 4242) throw new Error("EPERM"); } } });
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 4242;
		controller.abort();
		h.time.advance(KILL_GRACE_MS);
		assert.deepEqual(sorted(pidKills), [[4300, "SIGKILL"], [4301, "SIGKILL"], [4400, "SIGKILL"]]);
		proc.close(null);
		await assert.rejects(promise, /aborted/);
	});

	it("win32 and a child without a pid skip the listing", async () => {
		for (const [platform, pid] of [["win32", 4242], ["linux", undefined]] as const) {
			const controller = new AbortController();
			const { h, listed } = forcedHarness({ signal: controller.signal, deps: { platform } });
			const promise = h.start();
			const proc = await h.ready();
			proc.pid = pid;
			controller.abort();
			h.time.advance(KILL_GRACE_MS);
			assert.equal(listed(), 0, platform);
			assert.deepEqual(proc.kills, ["SIGTERM", "SIGKILL"], platform);
			proc.close(null);
			await assert.rejects(promise, /aborted/);
		}
	});

	it("tracker killAllNow and shutdown survivors kill the descendants' groups; shutdown's SIGTERM does not", async () => {
		const tracker = createChildTracker({ listProcesses: () => PS });
		const { h, groupKills, listed } = forcedHarness({ deps: { tracker } });
		const promise = h.start();
		const proc = await h.ready();
		proc.pid = 4242;
		const time = h.time;
		const down = tracker.shutdown({ graceMs: 6000, setTimer: time.setTimer, clearTimer: time.clearTimer });
		assert.deepEqual(groupKills, [[4242, "SIGTERM"]]);
		assert.equal(listed(), 0);
		time.advance(6000);
		await down;
		assert.deepEqual(sorted(groupKills.slice(1)), [[4242, "SIGKILL"], [4300, "SIGKILL"], [4400, "SIGKILL"]]);
		groupKills.length = 0;
		tracker.killAllNow();
		assert.deepEqual(sorted(groupKills), [[4242, "SIGKILL"], [4300, "SIGKILL"], [4400, "SIGKILL"]], "synchronously, in the exit handler");
		proc.close(null);
		await promise;
	});

	// Three tracked children: one forced pass takes ONE process listing (not one synchronous `ps` of up to 2 s per child) and hands it to each.
	const trackedThree = async (list: () => Array<{ pid: number; ppid: number; pgid: number }>) => {
		let trackerListed = 0;
		const tracker = createChildTracker({ listProcesses: () => (trackerListed++, list()) });
		const groupKills: Array<[number, string]> = [];
		let ownListed = 0;
		const deps: Partial<ChildRunDeps> = { tracker, platform: "linux", killGroup: (pid, signal) => void groupKills.push([pid, signal]), listProcesses: () => (ownListed++, PS) };
		const runs = [harness({ deps }), harness({ deps }), harness({ deps })];
		const promises = runs.map((r) => r.start());
		const pids = [4242, 5000, 5100];
		for (const [i, r] of runs.entries()) (await r.ready()).pid = pids[i];
		return { tracker, groupKills, trackerListed: () => trackerListed, ownListed: () => ownListed, finish: () => Promise.all(runs.map((r, i) => (r.proc!.close(null), promises[i]))) };
	};

	it("a forced pass over three tracked children takes one process listing and hands it to each", async () => {
		const t = await trackedThree(() => [...PS, { pid: 5000, ppid: 100, pgid: 5000 }, { pid: 5100, ppid: 100, pgid: 5100 }]);
		t.tracker.killAllNow();
		assert.equal(t.trackerListed(), 1);
		assert.equal(t.ownListed(), 0, "no child lists for itself during a tracker pass");
		assert.deepEqual(sorted(t.groupKills), [[4242, "SIGKILL"], [4300, "SIGKILL"], [4400, "SIGKILL"], [5000, "SIGKILL"], [5100, "SIGKILL"]]);
		t.groupKills.length = 0;
		t.tracker.killAll("SIGTERM");
		assert.equal(t.trackerListed(), 1, "a graceful pass lists nothing");
		t.tracker.killAll("SIGKILL");
		assert.equal(t.trackerListed(), 2, "one listing per forced pass");
		assert.equal(t.ownListed(), 0);
		await t.finish();
	});

	it("a failed listing in a tracker pass still kills each child's own group, and never throws", async () => {
		for (const list of [() => { throw new Error("ps: timed out"); }, () => []]) {
			const t = await trackedThree(list);
			assert.doesNotThrow(() => t.tracker.killAllNow());
			assert.equal(t.trackerListed(), 1);
			assert.equal(t.ownListed(), 0, "a failed shared listing is not retried per child");
			assert.deepEqual(sorted(t.groupKills), [[4242, "SIGKILL"], [5000, "SIGKILL"], [5100, "SIGKILL"]]);
			await t.finish();
		}
	});
});

describe("the shared process signaller", () => {
	const make = (overrides: Partial<Parameters<typeof createProcessSignaller>[0]> = {}) => {
		const calls: string[] = [];
		const signaller = createProcessSignaller({
			pid: () => 100,
			killSelf: (signal) => void calls.push(`self:${signal}`),
			killGroup: (pid, signal) => void calls.push(`group:${pid}:${signal}`),
			killPid: (pid, signal) => void calls.push(`pid:${pid}:${signal}`),
			listProcesses: () => [
				{ pid: 100, ppid: 50, pgid: 100 },
				{ pid: 200, ppid: 100, pgid: 200 },
				{ pid: 50, ppid: 1, pgid: 50 },
			],
			selfPid: 50,
			platform: "linux",
			...overrides,
		});
		return { signaller, calls };
	};

	it("signals the group, then SIGKILLs the listed descendants' groups", () => {
		const { signaller, calls } = make();
		signaller.signal("SIGKILL", signaller.descendants());
		assert.deepEqual(calls, ["group:100:SIGKILL", "group:200:SIGKILL"]);
	});

	it("signals the group only when no descendants are given; the process alone without a group", () => {
		const a = make();
		a.signaller.signal("SIGTERM");
		assert.deepEqual(a.calls, ["group:100:SIGTERM"]);
		const b = make({ platform: "win32" });
		b.signaller.signal("SIGTERM", b.signaller.descendants());
		assert.deepEqual(b.calls, ["self:SIGTERM"]);
		const c = make({ pid: () => undefined });
		c.signaller.signal("SIGTERM");
		assert.deepEqual(c.calls, ["self:SIGTERM"]);
	});

	it("falls back to pids when a descendant group cannot be signalled, and never throws", () => {
		const calls: string[] = [];
		const { signaller } = make({
			killGroup: (pid, signal) => {
				if (pid === 200) throw new Error("ESRCH");
				calls.push(`group:${pid}:${signal}`);
			},
			killPid: () => {
				throw new Error("ESRCH");
			},
		});
		signaller.signal("SIGKILL", signaller.descendants());
		assert.deepEqual(calls, ["group:100:SIGKILL"]);
	});

	it("killDescendants skips the process's own group when asked", () => {
		const { signaller, calls } = make();
		signaller.killDescendants({ groups: [{ pgid: 100, pids: [101] }, { pgid: 200, pids: [200] }], pids: [7] }, true);
		assert.deepEqual(calls, ["group:200:SIGKILL", "pid:7:SIGKILL"]);
	});

	it("a failed listing means no descendants", () => {
		const { signaller } = make({
			listProcesses: () => {
				throw new Error("ps failed");
			},
		});
		assert.equal(signaller.descendants(), undefined);
	});

	it("mergeDescendantTargets joins two listings without repeats", () => {
		assert.equal(mergeDescendantTargets(undefined, undefined), undefined);
		const one = { groups: [{ pgid: 2, pids: [20] }], pids: [5] };
		assert.equal(mergeDescendantTargets(one, undefined), one);
		assert.deepEqual(mergeDescendantTargets(one, { groups: [{ pgid: 2, pids: [21] }, { pgid: 3, pids: [30] }], pids: [5, 6] }), { groups: [{ pgid: 2, pids: [20, 21] }, { pgid: 3, pids: [30] }], pids: [5, 6] });
	});
});
