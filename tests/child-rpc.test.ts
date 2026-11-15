import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { answerUiRequest, createChildControl, decodeRecord, encodeCommand, FIRE_AND_FORGET_METHODS, UI_DIALOG_METHODS, type RpcCommand } from "../lib/child-rpc.ts";

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

describe("createChildControl: the handle a running task exposes", () => {
	function rig(streaming = true, open = true) {
		const sent: RpcCommand[] = [];
		const state = { streaming, open, aborts: 0 };
		const control = createChildControl({
			send: (command) => (state.open ? (sent.push(command), true) : false),
			streaming: () => state.streaming,
			onAbort: () => void state.aborts++,
		});
		return { control, sent, state };
	}

	it("steer and followUp send their RPC commands", () => {
		const { control, sent } = rig();
		assert.equal(control.steer("go left"), true);
		assert.equal(control.followUp("then right"), true);
		assert.deepEqual(sent, [
			{ type: "steer", message: "go left" },
			{ type: "follow_up", message: "then right" },
		]);
	});

	it("blank text sends nothing", () => {
		const { control, sent } = rig();
		assert.equal(control.steer("   "), false);
		assert.equal(control.followUp(""), false);
		assert.deepEqual(sent, []);
	});

	it("abort sends the RPC abort and tells the run loop", () => {
		const { control, sent, state } = rig();
		assert.equal(control.abort(), true);
		assert.deepEqual(sent, [{ type: "abort" }]);
		assert.equal(state.aborts, 1);
	});

	it("a closed child accepts nothing and abort does not start an escalation", () => {
		const { control, sent, state } = rig(true, false);
		assert.equal(control.steer("x"), false);
		assert.equal(control.followUp("x"), false);
		assert.equal(control.abort(), false);
		assert.deepEqual(sent, []);
		assert.equal(state.aborts, 0);
	});

	it("reports whether the child is streaming", () => {
		const { control, state } = rig(false);
		assert.equal(control.isStreaming(), false);
		state.streaming = true;
		assert.equal(control.isStreaming(), true);
	});
});
