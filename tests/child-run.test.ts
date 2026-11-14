import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import type { ChildControl } from "../lib/child-rpc.ts";
import { failed, output, runChild, type ChildProcessLike, type RunOptions, type RunResult, type SpawnFn } from "../lib/child-run.ts";
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

function harness(over: { agent?: Partial<RunOptions["agent"]>; env?: NodeJS.ProcessEnv; signal?: AbortSignal; schema?: RunOptions["schema"]; price?: RunOptions["price"]; onControl?: RunOptions["onControl"] } = {}) {
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
			});
			// Surface a rejection to the test only when it awaits `promise`.
			promise.catch(() => undefined);
			return promise;
		},
		ready: async () => {
			for (let i = 0; i < 50 && !h.proc; i++) await tick();
			assert.ok(h.proc, "child was spawned");
			return h.proc;
		},
		savedRuns: () => fs.readdirSync(path.join(docs, "runs")),
		saved: (result: RunResult, file: string) => fs.readFileSync(path.join(result.artifactsDir!, file), "utf8"),
	};
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
