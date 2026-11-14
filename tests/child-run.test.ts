import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
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

class FakeChild extends EventEmitter implements ChildProcessLike {
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

function harness(over: { agent?: Partial<RunOptions["agent"]>; env?: NodeJS.ProcessEnv; signal?: AbortSignal; schema?: RunOptions["schema"]; price?: RunOptions["price"] } = {}) {
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
		assert.deepEqual(h.spawned!.args.slice(0, 4), ["--wrapped", "--mode", "json", "-p"]);
		assert.equal(h.spawned!.args.at(-1), "## Task\nmap the code");
		assert.equal(h.spawned!.options.shell, false);
		assert.deepEqual(h.spawned!.options.stdio, ["ignore", "pipe", "pipe"]);
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
