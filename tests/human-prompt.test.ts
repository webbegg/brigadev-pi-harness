// lib/human-prompt.ts: a prompt answerable from the TUI or from the bus; the first answer wins, the other side is cancelled.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BUS, createBus, type PromptState } from "../lib/bus.ts";
import { askChoice, askConfirm, type ChoiceAnswer } from "../lib/human-prompt.ts";

/** A bus that records every prompt snapshot. */
function setup() {
	const bus = createBus();
	const snapshots: PromptState[] = [];
	bus.on(BUS.prompt, (data) => void snapshots.push(data as PromptState));
	const answer = (id: string, value: unknown) => bus.emit(BUS.action, { action: "answer", id, value });
	return { bus, snapshots, answer };
}

/** A ctx whose confirm dialog stays open until the test settles it; records the options it was given. */
function tuiConfirm() {
	const calls: Array<{ title: string; body: string; signal?: AbortSignal }> = [];
	let settle: (value: boolean) => void = () => {};
	let fail: (error: unknown) => void = () => {};
	const ctx = {
		ui: {
			confirm: (title: string, body: string, opts?: { signal?: AbortSignal }) => {
				calls.push({ title, body, signal: opts?.signal });
				return new Promise<boolean>((resolve, reject) => {
					settle = resolve;
					fail = reject;
				});
			},
		},
	};
	return { ctx, calls, resolve: (value: boolean) => settle(value), reject: (error: unknown) => fail(error) };
}

const spec = { source: "guard", title: "brigadev: sensitive file", body: "read .env\n\nAllow?" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe("askConfirm", () => {
	it("TUI answer wins: published open, then answered by tui; a later web answer is ignored", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		assert.equal(snapshots.length, 1);
		assert.deepEqual({ ...snapshots[0], at: 0, id: "" }, { id: "", kind: "confirm", source: "guard", title: spec.title, body: spec.body, status: "open", at: 0 });
		assert.equal(tui.calls[0].title, spec.title);
		assert.equal(tui.calls[0].body, spec.body);
		assert.equal(tui.calls[0].signal?.aborted, false);

		tui.resolve(true);
		assert.equal(await result, true);
		assert.equal(snapshots.length, 2);
		assert.equal(snapshots[1].id, snapshots[0].id);
		assert.equal(snapshots[1].status, "answered");
		assert.equal(snapshots[1].answer, true);
		assert.equal(snapshots[1].by, "tui");

		answer(snapshots[0].id, false);
		assert.equal(snapshots.length, 2, "the listener is gone once the prompt settled");
	});

	it("Esc (the dialog answers false) is a TUI answer of false", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		tui.resolve(false);
		assert.equal(await result, false);
		assert.deepEqual([snapshots[1].status, snapshots[1].answer, snapshots[1].by], ["answered", false, "tui"]);
	});

	it("a web answer wins: the TUI dialog is aborted, and its late result is ignored", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		answer(snapshots[0].id, true);
		assert.equal(await result, true);
		assert.equal(tui.calls[0].signal?.aborted, true);
		assert.deepEqual([snapshots[1].status, snapshots[1].answer, snapshots[1].by], ["answered", true, "web"]);

		tui.resolve(false);
		await tick();
		assert.equal(snapshots.length, 2, "the aborted dialog's late result publishes nothing");
	});

	it("a TUI dialog that rejects after the abort is ignored", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		answer(snapshots[0].id, false);
		tui.reject(new Error("aborted"));
		assert.equal(await result, false);
		await tick();
		assert.equal(snapshots.length, 2);
	});

	it("a web answer of the wrong type is ignored", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		answer(snapshots[0].id, "yes");
		assert.equal(snapshots.length, 1);
		assert.equal(tui.calls[0].signal?.aborted, false);
		tui.resolve(true);
		assert.equal(await result, true);
		assert.equal(snapshots[1].by, "tui");
	});

	it("an answer for another id is ignored", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		answer("not-this-prompt", true);
		assert.equal(snapshots.length, 1);
		assert.equal(tui.calls[0].signal?.aborted, false);
		tui.resolve(false);
		assert.equal(await result, false);
	});

	it("an answer that arrives while the open snapshot is still being published wins", async () => {
		const { bus, snapshots, answer } = setup();
		bus.on(BUS.prompt, (data) => {
			const prompt = data as PromptState;
			if (prompt.status === "open") answer(prompt.id, true);
		});
		const tui = tuiConfirm();
		assert.equal(await askConfirm(bus, tui.ctx, spec), true);
		assert.equal(snapshots.at(-1)?.by, "web");
		assert.equal(tui.calls[0]?.signal?.aborted ?? true, true);
	});

	it("prompts get distinct ids", async () => {
		const { bus, snapshots } = setup();
		const a = tuiConfirm();
		const b = tuiConfirm();
		const first = askConfirm(bus, a.ctx, spec);
		const second = askConfirm(bus, b.ctx, spec);
		assert.notEqual(snapshots[0].id, snapshots[1].id);
		a.resolve(true);
		b.resolve(true);
		await Promise.all([first, second]);
	});

	it("a dialog that throws leaves no prompt open: the caller sees the error, the snapshot is dismissed", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiConfirm();
		const result = askConfirm(bus, tui.ctx, spec);
		tui.reject(new Error("boom"));
		await assert.rejects(result, /boom/);
		assert.equal(snapshots.length, 2);
		assert.equal(snapshots[1].status, "dismissed");
	});

	it("without a bus it is the plain dialog", async () => {
		const calls: unknown[][] = [];
		const ctx = { ui: { confirm: async (...args: unknown[]) => (calls.push(args), true) } };
		assert.equal(await askConfirm(undefined, ctx, spec), true);
		assert.deepEqual(calls, [[spec.title, spec.body]]);
	});

	it("a listener that throws does not break the prompt", async () => {
		const bus = createBus();
		bus.on(BUS.prompt, () => {
			throw new Error("listener");
		});
		const tui = tuiConfirm();
		const result = askConfirm({ emit: (c, d) => bus.emit(c, d), on: bus.on }, tui.ctx, spec);
		tui.resolve(true);
		assert.equal(await result, true);
	});
});

const choice = { source: "ask", question: "Which database?", options: [{ label: "SQLite", description: "file" }, { label: "Postgres" }], recommended: 1 };

/** A TUI runner that stays open until the test answers; records whether the harness closed it. */
function tuiChoice() {
	let settle: (value: ChoiceAnswer | null) => void = () => {};
	let fail: (error: unknown) => void = () => {};
	const state = { closed: 0 };
	const run = (onClose: (close: () => void) => void) =>
		new Promise<ChoiceAnswer | null>((resolve, reject) => {
			settle = resolve;
			fail = reject;
			// A closed component resolves with null, as Pi's `done(null)` does.
			onClose(() => {
				state.closed++;
				resolve(null);
			});
		});
	return { run, state, resolve: (value: ChoiceAnswer | null) => settle(value), reject: (error: unknown) => fail(error) };
}

describe("askChoice", () => {
	it("publishes the options, then the TUI answer", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiChoice();
		const result = askChoice(bus, choice, tui.run);
		assert.equal(snapshots[0].kind, "choice");
		assert.equal(snapshots[0].source, "ask");
		assert.equal(snapshots[0].title, "Which database?");
		assert.deepEqual(snapshots[0].options, choice.options);
		assert.equal(snapshots[0].recommended, 1);
		assert.equal(snapshots[0].status, "open");

		tui.resolve({ answer: "Postgres", wasCustom: false });
		assert.deepEqual(await result, { answer: "Postgres", wasCustom: false });
		assert.deepEqual([snapshots[1].status, snapshots[1].answer, snapshots[1].by], ["answered", "Postgres", "tui"]);
		assert.equal(tui.state.closed, 0);
	});

	it("a web answer by label wins and closes the TUI component", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiChoice();
		const result = askChoice(bus, choice, tui.run);
		answer(snapshots[0].id, "SQLite");
		assert.deepEqual(await result, { answer: "SQLite", wasCustom: false });
		assert.equal(tui.state.closed, 1);
		assert.deepEqual([snapshots[1].status, snapshots[1].answer, snapshots[1].by], ["answered", "SQLite", "web"]);
		await tick();
		assert.equal(snapshots.length, 2, "the closed component's null result publishes nothing");
	});

	it("a web free-text answer is a custom answer", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiChoice();
		const result = askChoice(bus, choice, tui.run);
		answer(snapshots[0].id, "  DuckDB  ");
		assert.deepEqual(await result, { answer: "DuckDB", wasCustom: true });
		assert.equal(snapshots[1].answer, "DuckDB");
		assert.equal(snapshots[1].by, "web");
	});

	it("allowOther: false rejects free text and boolean answers, but still takes a label", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiChoice();
		const result = askChoice(bus, { ...choice, allowOther: false }, tui.run);
		assert.equal(snapshots[0].allowOther, false);
		answer(snapshots[0].id, "DuckDB");
		answer(snapshots[0].id, true);
		assert.equal(snapshots.length, 1);
		assert.equal(tui.state.closed, 0);
		answer(snapshots[0].id, "Postgres");
		assert.deepEqual(await result, { answer: "Postgres", wasCustom: false });
	});

	it("a TUI dismiss (null) publishes dismissed", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiChoice();
		const result = askChoice(bus, choice, tui.run);
		tui.resolve(null);
		assert.equal(await result, null);
		assert.equal(snapshots.length, 2);
		assert.equal(snapshots[1].status, "dismissed");
		assert.equal(snapshots[1].answer, undefined);
	});

	it("a TUI that throws leaves no prompt open", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiChoice();
		const result = askChoice(bus, choice, tui.run);
		tui.reject(new Error("render failed"));
		await assert.rejects(result, /render failed/);
		assert.equal(snapshots.at(-1)?.status, "dismissed");
	});

	it("without a bus it is the TUI alone", async () => {
		assert.deepEqual(await askChoice(undefined, choice, async () => ({ answer: "SQLite", wasCustom: false })), { answer: "SQLite", wasCustom: false });
	});
});

describe("an aborted run closes a pending prompt", () => {
	it("askConfirm: abort closes the TUI dialog, publishes dismissed, answers false, and a late web answer does nothing", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiConfirm();
		const run = new AbortController();
		const result = askConfirm(bus, tui.ctx, spec, run.signal);
		assert.equal(snapshots[0].status, "open");
		assert.equal(tui.calls[0].signal?.aborted, false);

		run.abort();
		assert.equal(await result, false);
		assert.equal(tui.calls[0].signal?.aborted, true, "the TUI dialog got the abort");
		assert.deepEqual([snapshots.length, snapshots[1].status, snapshots[1].answer], [2, "dismissed", undefined]);

		answer(snapshots[0].id, true);
		assert.equal(snapshots.length, 2, "the listener is gone: a late answer has no effect");
		tui.resolve(true);
		await tick();
		assert.equal(snapshots.length, 2);
	});

	it("askConfirm: a signal that is already aborted asks nothing and answers false", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiConfirm();
		const run = new AbortController();
		run.abort();
		assert.equal(await askConfirm(bus, tui.ctx, spec, run.signal), false);
		assert.equal(tui.calls.length, 0);
		assert.equal(snapshots.length, 0);
	});

	it("askConfirm: a settled prompt stops listening to the signal", async () => {
		const { bus, snapshots } = setup();
		const tui = tuiConfirm();
		const run = new AbortController();
		const result = askConfirm(bus, tui.ctx, spec, run.signal);
		tui.resolve(true);
		assert.equal(await result, true);
		run.abort();
		assert.equal(snapshots.length, 2);
	});

	it("askChoice: abort closes the component, resolves null and publishes dismissed; a late web answer does nothing", async () => {
		const { bus, snapshots, answer } = setup();
		const tui = tuiChoice();
		const run = new AbortController();
		const result = askChoice(bus, choice, tui.run, run.signal);
		run.abort();
		assert.equal(await result, null);
		assert.equal(tui.state.closed, 1);
		assert.equal(snapshots.at(-1)?.status, "dismissed");
		const count = snapshots.length;
		answer(snapshots[0].id, "SQLite");
		assert.equal(snapshots.length, count);
	});

	it("askChoice: a signal that is already aborted shows nothing", async () => {
		const { bus, snapshots } = setup();
		let shown = 0;
		const run = new AbortController();
		run.abort();
		assert.equal(await askChoice(bus, choice, async () => (shown++, null), run.signal), null);
		assert.deepEqual([shown, snapshots.length], [0, 0]);
	});
});
