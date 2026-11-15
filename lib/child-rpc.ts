// The Pi RPC protocol as a subagent child speaks it (`pi --mode rpc`): command
// encoding, record decoding, the S0 policy for extension UI requests, and the
// steering handle a running task exposes. Pure: no Pi imports, no I/O.
//
// Pi docs (installed 1.5.2, docs/):
// - rpc.md:22-33 record families; :35-48 optional command `id`, matching response; :50-56 strict JSONL framing (LF only)
// - rpc.md:58-71 `prompt` is acknowledged, not completed; `agent_settled` says Pi will not continue by itself;
//   disposition "handled" means no run started (don't wait for `agent_settled`)
// - rpc.md:91-97 closing stdin requests an orderly shutdown
// - rpc-commands.md:7-44 `prompt`; :46-68 `steer`; :70-92 `follow_up`; :94-105 `abort`
// - rpc-extension-ui.md:5-10 dialog methods (select, confirm, input, editor) block until answered;
//   fire-and-forget methods (notify, setStatus, setWidget, setTitle, set_editor_text) expect nothing;
//   :172-194 responses; the cancellation response `{"type":"extension_ui_response","id":...,"cancelled":true}` dismisses any dialog

/** Commands the parent writes to a child's stdin. */
export type RpcCommand =
	| { type: "prompt"; message: string; id?: string }
	| { type: "steer"; message: string }
	| { type: "follow_up"; message: string }
	| { type: "abort" };

/** The parent's answer to a dialog (rpc-extension-ui.md:188-194). */
export interface UiResponse {
	type: "extension_ui_response";
	id: string;
	cancelled: true;
}

/** An `extension_ui_request` from the child; the other fields depend on the method. */
export interface UiRequest {
	id: string;
	method: string;
	[field: string]: unknown;
}

/** One record decoded from a child's stdout. */
export type RpcRecord =
	| { kind: "response"; command: string; success: boolean; id?: string; error?: string; disposition?: string }
	| { kind: "ui_request"; request: UiRequest }
	/** A session event (json.md): anything that is neither a response nor a UI request. */
	| { kind: "event"; event: any };

/** Methods that block the child until the client answers (rpc-extension-ui.md:7). */
export const UI_DIALOG_METHODS: readonly string[] = ["select", "confirm", "input", "editor"];
/** Methods that expect no answer (rpc-extension-ui.md:8). */
export const FIRE_AND_FORGET_METHODS: readonly string[] = ["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"];

/** One record, LF-terminated (rpc.md:52). JSON escapes newlines inside strings, so the terminator is the only raw LF. */
export const encodeCommand = (record: RpcCommand | UiResponse): string => `${JSON.stringify(record)}\n`;

/** Decodes one stdout line; blank or broken lines (and a CR from CRLF) decode to nothing or are tolerated. */
export function decodeRecord(line: string): RpcRecord | undefined {
	if (!line.trim()) return undefined;
	let event: any;
	try {
		event = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (event?.type === "response") {
		return {
			kind: "response",
			command: String(event.command ?? ""),
			success: event.success === true,
			...(typeof event.id === "string" ? { id: event.id } : {}),
			...(typeof event.error === "string" ? { error: event.error } : {}),
			...(typeof event.data?.disposition === "string" ? { disposition: event.data.disposition } : {}),
		};
	}
	if (event?.type === "extension_ui_request") {
		const { type: _type, id, method, ...fields } = event;
		return { kind: "ui_request", request: { id: typeof id === "string" ? id : "", method: String(method ?? ""), ...fields } };
	}
	return { kind: "event", event };
}

/**
 * S0: a subagent never asks the user for anything and never waits for an answer.
 * Every dialog gets the cancellation response at once (the extension then sees
 * `undefined`, or `false` for confirm); fire-and-forget requests are ignored.
 * A method this version does not know is answered like a dialog: if it is a
 * dialog added later, leaving it unanswered would hang the child, and an answer
 * to a request that expects none is harmless.
 */
export function answerUiRequest(request: UiRequest): UiResponse | undefined {
	if (!request.id) return undefined;
	if (FIRE_AND_FORGET_METHODS.includes(request.method)) return undefined;
	return { type: "extension_ui_response", id: request.id, cancelled: true };
}

/** What a running task exposes for takeover; gone once the run has finished. Every method returns false when it could not send. */
export interface ChildControl {
	/** Queues text to be delivered after the current turn's tool calls, before the next model call (rpc-commands.md:46-48). */
	steer(text: string): boolean;
	/** Queues text for when the child has no more work; use it between turns (rpc-commands.md:70-72). */
	followUp(text: string): boolean;
	/** Asks the child to abort its current operation (rpc-commands.md:94-96). */
	abort(): boolean;
	/** True between `agent_start` and `agent_end`: steer applies; otherwise follow up. */
	isStreaming(): boolean;
}

export interface ChildControlIo {
	/** Writes a command; false when the child's input is closed. */
	send(command: RpcCommand): boolean;
	streaming(): boolean;
	/** The abort command went out: the run loop escalates if the child does not stop. */
	onAbort(): void;
}

export function createChildControl(io: ChildControlIo): ChildControl {
	const queue = (type: "steer" | "follow_up", text: string) => (text.trim() ? io.send({ type, message: text }) : false);
	return {
		steer: (text) => queue("steer", text),
		followUp: (text) => queue("follow_up", text),
		abort() {
			if (!io.send({ type: "abort" })) return false;
			io.onAbort();
			return true;
		},
		isStreaming: () => io.streaming(),
	};
}
