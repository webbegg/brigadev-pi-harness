import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerUiRequest, createChildControl, createCommandTracker, decodeRecord, encodeCommand, FIRE_AND_FORGET_METHODS, UI_DIALOG_METHODS, type CommandOutcome, type RpcCommand } from "../lib/child-rpc.ts";

describe("encodeCommand: one JSON record per line (Pi rpc.md:50-56)", () => {
	it("terminates every record with LF and keeps embedded newlines escaped", () => {
		const line = encodeCommand({ type: "prompt", message: "line one\nline two", id: "p1" });
		assert.ok(line.endsWith("\n"));
		assert.equal(line.indexOf("\n"), line.length - 1, "only the terminator is a raw LF");
		assert.deepEqual(JSON.parse(line), { type: "prompt", message: "line one\nline two", id: "p1" });
	});

	it("encodes steer, follow_up and abort as in rpc-commands.md:46-105", () => {
		assert.equal(encodeCommand({ type: "steer", message: "stop" }), '{"type":"steer","message":"stop"}\n');
		assert.equal(encodeCommand({ type: "follow_up", message: "then this" }), '{"type":"follow_up","message":"then this"}\n');
		assert.equal(encodeCommand({ type: "abort" }), '{"type":"abort"}\n');
	});

	it("steer and follow_up carry an optional id that Pi echoes in the response (rpc.md:37-44)", () => {
		assert.equal(encodeCommand({ type: "steer", message: "stop", id: "cmd-1" }), '{"type":"steer","message":"stop","id":"cmd-1"}\n');
		assert.equal(encodeCommand({ type: "follow_up", message: "then", id: "cmd-2" }), '{"type":"follow_up","message":"then","id":"cmd-2"}\n');
	});

	it("encodes an extension UI response", () => {
		assert.equal(encodeCommand({ type: "extension_ui_response", id: "u1", cancelled: true }), '{"type":"extension_ui_response","id":"u1","cancelled":true}\n');
	});
});

describe("decodeRecord: responses, extension UI requests, and session events stay apart", () => {
	it("a command response is a response, never an event", () => {
		assert.deepEqual(decodeRecord('{"id":"p1","type":"response","command":"prompt","success":true,"data":{"disposition":"started"}}'), { kind: "response", command: "prompt", id: "p1", success: true, disposition: "started" });
		assert.deepEqual(decodeRecord('{"type":"response","command":"steer","success":false,"error":"nope"}'), { kind: "response", command: "steer", success: false, error: "nope" });
		assert.deepEqual(decodeRecord('{"type":"response","command":"parse","success":false,"error":"Failed to parse command: x"}'), { kind: "response", command: "parse", success: false, error: "Failed to parse command: x" });
	});

	it("an extension UI request carries its id, method and fields", () => {
		const record = decodeRecord('{"type":"extension_ui_request","id":"u1","method":"confirm","title":"t","message":"m","timeout":5000}');
		assert.deepEqual(record, { kind: "ui_request", request: { id: "u1", method: "confirm", title: "t", message: "m", timeout: 5000 } });
	});

	it("everything else is a session event, with the CR of CRLF input tolerated", () => {
		assert.deepEqual(decodeRecord('{"type":"agent_settled","aborted":false}\r'), { kind: "event", event: { type: "agent_settled", aborted: false } });
	});

	it("blank and broken lines decode to nothing", () => {
		assert.equal(decodeRecord(""), undefined);
		assert.equal(decodeRecord("   "), undefined);
		assert.equal(decodeRecord("not json {"), undefined);
	});
});

describe("answerUiRequest: S0, a child's dialog is cancelled at once and never forwarded (Pi rpc-extension-ui.md:5-8, 188-194)", () => {
	const dialogs: Array<[string, Record<string, unknown>]> = [
		["select", { title: "Allow dangerous command?", options: ["Allow", "Block"], timeout: 10000 }],
		["confirm", { title: "Clear session?", message: "All messages will be lost.", timeout: 5000 }],
		["input", { title: "Enter a value", placeholder: "type something..." }],
		["editor", { title: "Edit some text", prefill: "Line 1\nLine 2" }],
	];
	for (const [method, fields] of dialogs) {
		it(`${method}: answered with cancelled: true under the request's id`, () => {
			assert.deepEqual(answerUiRequest({ id: `id-${method}`, method, ...fields }), { type: "extension_ui_response", id: `id-${method}`, cancelled: true });
		});
	}

	const fireAndForget: Array<[string, Record<string, unknown>]> = [
		["notify", { message: "Command blocked by user", notifyType: "warning" }],
		["setStatus", { statusKey: "my-ext", statusText: "Turn 3 running..." }],
		["setWidget", { widgetKey: "my-ext", widgetLines: ["a"], widgetPlacement: "aboveEditor" }],
		["setTitle", { title: "pi - my project" }],
		["set_editor_text", { text: "prefilled" }],
	];
	for (const [method, fields] of fireAndForget) {
		it(`${method}: fire-and-forget, ignored (no response is sent)`, () => {
			assert.equal(answerUiRequest({ id: `id-${method}`, method, ...fields }), undefined);
		});
	}

	it("covers every method the docs list, no more and no fewer", () => {
		assert.deepEqual([...UI_DIALOG_METHODS].sort(), ["confirm", "editor", "input", "select"]);
		assert.deepEqual([...FIRE_AND_FORGET_METHODS].sort(), ["notify", "setStatus", "setTitle", "setWidget", "set_editor_text"]);
	});

	it("a method this version does not know is cancelled too: a dialog added later must not hang the child", () => {
		assert.deepEqual(answerUiRequest({ id: "u9", method: "pickColor" }), { type: "extension_ui_response", id: "u9", cancelled: true });
	});

	it("a request without an id cannot be answered", () => {
		assert.equal(answerUiRequest({ id: "", method: "confirm" }), undefined);
	});
});

describe("createCommandTracker: responses are matched to commands by id, in any order (rpc.md:37-48)", () => {
	const settledNow = async (promise: Promise<CommandOutcome>) => Promise.race([promise, new Promise<"pending">((resolve) => setImmediate(() => resolve("pending")))]);

	it("hands out unique ids and settles each promise from its own response", async () => {
		const tracker = createCommandTracker();
		const a = tracker.expect();
		const b = tracker.expect();
		assert.notEqual(a.id, b.id);
		assert.equal(tracker.pending(), 2);
		assert.equal(tracker.respond({ id: a.id, success: true, disposition: "queued" }), true);
		assert.deepEqual(await a.outcome, { status: "accepted", disposition: "queued" });
		assert.equal(tracker.pending(), 1);
		assert.equal(tracker.respond({ id: b.id, success: false, error: "Agent is not running" }), true);
		assert.deepEqual(await b.outcome, { status: "rejected", error: "Agent is not running" });
		assert.equal(tracker.pending(), 0);
	});

	it("a response out of order settles the right command", async () => {
		const tracker = createCommandTracker();
		const first = tracker.expect();
		const second = tracker.expect();
		tracker.respond({ id: second.id, success: true, disposition: "handled" });
		assert.equal(await settledNow(first.outcome), "pending", "the first is still waiting");
		assert.deepEqual(await second.outcome, { status: "accepted", disposition: "handled" });
		tracker.respond({ id: first.id, success: true });
		assert.deepEqual(await first.outcome, { status: "accepted" });
	});

	it("a response without a matching id (the prompt's, a parse error, a repeat) settles nothing", async () => {
		const tracker = createCommandTracker();
		const a = tracker.expect();
		assert.equal(tracker.respond({ success: true }), false);
		assert.equal(tracker.respond({ id: "someone-else", success: false, error: "x" }), false);
		assert.equal(tracker.pending(), 1);
		tracker.respond({ id: a.id, success: true });
		assert.equal(tracker.respond({ id: a.id, success: true }), false, "settles once");
		assert.deepEqual(await a.outcome, { status: "accepted" });
	});

	it("settleAll marks everything still waiting as not delivered and leaves nothing pending", async () => {
		const tracker = createCommandTracker();
		const a = tracker.expect();
		const b = tracker.expect();
		tracker.respond({ id: a.id, success: true });
		tracker.settleAll();
		assert.deepEqual(await a.outcome, { status: "accepted" }, "an answered command keeps its outcome");
		assert.deepEqual(await b.outcome, { status: "not_delivered" });
		assert.equal(tracker.pending(), 0);
		assert.equal(tracker.respond({ id: b.id, success: true }), false, "a late response is ignored");
	});

	it("forget settles one command as not delivered (its write failed)", async () => {
		const tracker = createCommandTracker();
		const a = tracker.expect();
		tracker.forget(a.id);
		assert.deepEqual(await a.outcome, { status: "not_delivered" });
		assert.equal(tracker.pending(), 0);
	});
});

describe("createChildControl: the handle a running task exposes", () => {
	function rig(streaming = true, open = true) {
		const sent: RpcCommand[] = [];
		const state = { streaming, open, aborts: 0 };
		const commands = createCommandTracker();
		const control = createChildControl({
			send: (command) => (state.open ? (sent.push(command), true) : false),
			streaming: () => state.streaming,
			onAbort: () => void state.aborts++,
			commands,
		});
		return { control, sent, state, commands };
	}

	it("steer and followUp send their RPC commands, each with its own id", () => {
		const { control, sent, commands } = rig();
		void control.steer("go left");
		void control.followUp("then right");
		assert.equal(sent.length, 2);
		assert.deepEqual(sent.map(({ type, ...rest }) => ({ type, message: (rest as any).message })), [
			{ type: "steer", message: "go left" },
			{ type: "follow_up", message: "then right" },
		]);
		const ids = sent.map((c) => (c as { id?: string }).id);
		assert.ok(ids.every((id) => typeof id === "string" && id.length > 0));
		assert.notEqual(ids[0], ids[1]);
		assert.equal(commands.pending(), 2);
	});

	it("accepted: the promise settles from Pi's response with its disposition", async () => {
		const { control, sent, commands } = rig();
		const outcome = control.steer("go left");
		commands.respond({ id: (sent[0] as { id: string }).id, success: true, disposition: "queued" });
		assert.deepEqual(await outcome, { status: "accepted", disposition: "queued" });
	});

	it("rejected: Pi's error comes through", async () => {
		const { control, sent, commands } = rig();
		const outcome = control.followUp("later");
		commands.respond({ id: (sent[0] as { id: string }).id, success: false, error: "Extension commands are not allowed" });
		assert.deepEqual(await outcome, { status: "rejected", error: "Extension commands are not allowed" });
	});

	it("blank text sends nothing and is not delivered", async () => {
		const { control, sent, commands } = rig();
		assert.deepEqual(await control.steer("   "), { status: "not_delivered" });
		assert.deepEqual(await control.followUp(""), { status: "not_delivered" });
		assert.deepEqual(sent, []);
		assert.equal(commands.pending(), 0);
	});

	it("abort sends the RPC abort and tells the run loop", () => {
		const { control, sent, state } = rig();
		assert.equal(control.abort(), true);
		assert.deepEqual(sent, [{ type: "abort" }]);
		assert.equal(state.aborts, 1);
	});

	it("a closed child accepts nothing (not delivered, nothing pending) and abort does not start an escalation", async () => {
		const { control, sent, state, commands } = rig(true, false);
		assert.deepEqual(await control.steer("x"), { status: "not_delivered" });
		assert.deepEqual(await control.followUp("x"), { status: "not_delivered" });
		assert.equal(control.abort(), false);
		assert.deepEqual(sent, []);
		assert.equal(state.aborts, 0);
		assert.equal(commands.pending(), 0);
	});

	it("reports whether the child is streaming", () => {
		const { control, state } = rig(false);
		assert.equal(control.isStreaming(), false);
		state.streaming = true;
		assert.equal(control.isStreaming(), true);
	});
});
