// Escape during a run asks "Stop the current run?" instead of aborting at once (extensions/stop-confirm.ts), against a fake pi/ctx.
import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, describe, it } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const ESC = "\x1b";
type Input = (data: string) => { consume?: boolean } | undefined;

let uninstall: () => void;
let ext: (pi: unknown) => void;
let root: string;
const saved = { agentDir: process.env.PI_CODING_AGENT_DIR, child: process.env.BRIGADEV_CHILD };

before(async () => {
	uninstall = installPiStubs();
	ext = (await import("../extensions/stop-confirm.ts")).default;
	root = realpathSync(mkdtempSync(join(tmpdir(), "stop-confirm-")));
	process.env.PI_CODING_AGENT_DIR = root;
	delete process.env.BRIGADEV_CHILD;
});
after(() => {
	uninstall();
	rmSync(root, { recursive: true, force: true });
	if (saved.agentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = saved.agentDir;
	if (saved.child !== undefined) process.env.BRIGADEV_CHILD = saved.child;
});
beforeEach(() => writeFileSync(join(root, "brigadev.json"), "{}"));

/** The main editor, as Pi recognizes it: an `actionHandlers` map. */
const editor = (autocomplete = false) => ({ actionHandlers: new Map(), isShowingAutocomplete: () => autocomplete });

async function setup(options: { mode?: string; hasUI?: boolean; answer?: boolean | (() => Promise<boolean>) } = {}) {
	const pi = createFakePi();
	ext(pi);
	const ctx = createFakeCtx({ cwd: root, hasUI: options.hasUI ?? true, idle: false });
	ctx.mode = options.mode ?? "tui";
	const state = { focused: editor() as unknown, aborts: 0, confirms: [] as Array<{ title: string; signal?: AbortSignal }>, input: undefined as Input | undefined };
	ctx.abort = () => void state.aborts++;
	const ui = ctx.ui as Record<string, unknown>;
	ui.onTerminalInput = (handler: Input) => {
		state.input = handler;
		return () => (state.input = undefined);
	};
	ui.setWidget = (_key: string, content: unknown) => {
		if (typeof content === "function") content({ getFocusedComponent: () => state.focused }, {});
	};
	ui.confirm = async (title: string, _message: string, opts?: { signal?: AbortSignal }) => {
		state.confirms.push({ title, signal: opts?.signal });
		const answer = options.answer ?? true;
		return typeof answer === "function" ? answer() : answer;
	};
	await pi.fire("session_start", {}, ctx);
	const press = async (data = ESC) => {
		const result = state.input?.(data);
		await new Promise((resolve) => setImmediate(resolve));
		return result;
	};
	return { pi, ctx, state, press };
}

describe("stop-confirm: Escape during a run asks first", () => {
	it("asks while the agent runs and the editor has focus; Yes aborts the run once", async () => {
		const { state, press } = await setup({ answer: true });
		assert.deepEqual(await press(), { consume: true }, "the built-in abort does not run");
		assert.equal(state.confirms.length, 1);
		assert.match(state.confirms[0].title, /Stop the current run\?/);
		assert.equal(state.aborts, 1);
	});

	it("No keeps the run going", async () => {
		const { state, press } = await setup({ answer: false });
		await press();
		assert.equal(state.confirms.length, 1);
		assert.equal(state.aborts, 0);
	});

	it("leaves Escape alone when idle (double Escape, /tree, `!` bash keep their built-in behavior)", async () => {
		const { ctx, state, press } = await setup();
		ctx.idle = true;
		assert.equal(await press(), undefined);
		assert.equal(state.confirms.length, 0);
	});

	it("leaves Escape to a focused dialog, selector, or overlay, and to the editor's autocomplete", async () => {
		const { state, press } = await setup();
		state.focused = { handleInput() {} };
		assert.equal(await press(), undefined, "dialog");
		state.focused = editor(true);
		assert.equal(await press(), undefined, "autocomplete");
		state.focused = null;
		assert.equal(await press(), undefined, "nothing focused");
		assert.equal(state.confirms.length, 0);
	});

	it("a second Escape while the question is open goes to the question (it dismisses it: keep running)", async () => {
		let answer!: (value: boolean) => void;
		const { state, press } = await setup({ answer: () => new Promise<boolean>((resolve) => (answer = resolve)) });
		await press();
		assert.equal(await press(), undefined);
		assert.equal(state.confirms.length, 1);
		answer(false);
		await press("x");
		assert.equal(state.aborts, 0);
	});

	it("ignores key release and repeat events and other keys", async () => {
		const { state, press } = await setup();
		assert.equal(await press("\x1b[27;1:3u"), undefined, "release");
		assert.equal(await press("\x1b[27;1:2u"), undefined, "repeat");
		assert.equal(await press("\x1b[A"), undefined, "arrow");
		assert.equal(await press("a"), undefined);
		assert.equal(state.confirms.length, 0);
	});

	it("closes the question when the run ends by itself, and does not abort a run that already ended", async () => {
		let answer!: (value: boolean) => void;
		const { pi, ctx, state, press } = await setup({ answer: () => new Promise<boolean>((resolve) => (answer = resolve)) });
		await press();
		ctx.idle = true;
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(state.confirms[0].signal?.aborted, true);
		answer(true);
		await press("x");
		assert.equal(state.aborts, 0);
	});

	it("does nothing outside the TUI (rpc, print) or without a UI", async () => {
		for (const options of [{ mode: "rpc" }, { mode: "print" }, { hasUI: false }]) {
			const { state } = await setup(options);
			assert.equal(state.input, undefined, JSON.stringify(options));
		}
	});

	it("is off with `ui.confirmStop: false` in brigadev.json (Escape aborts at once again)", async () => {
		writeFileSync(join(root, "brigadev.json"), JSON.stringify({ ui: { confirmStop: false } }));
		const { state } = await setup();
		assert.equal(state.input, undefined);
	});

	it("does nothing in a subagent session", async () => {
		process.env.BRIGADEV_CHILD = "1";
		try {
			const { state } = await setup();
			assert.equal(state.input, undefined);
		} finally {
			delete process.env.BRIGADEV_CHILD;
		}
	});
});
