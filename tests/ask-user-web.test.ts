// extensions/ask-user.ts on the bus: ask_user_choice is answerable from the web as well as the TUI, with the same result texts.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { after, before, describe, it } from "node:test";
import { BUS, type PromptState } from "../lib/bus.ts";
import { createFakeCtx, createFakePi, type FakeCtx, type FakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let uninstall: () => void;
let askUser: (pi: any) => void;

before(async () => {
	for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
	const stubs = installPiStubs();
	// The shared pi-tui stub lacks `Editor` and `wrapTextWithAnsi`, which ask-user imports: add them on top.
	const tui = pathToFileURL(join(import.meta.dirname, "helpers", "pi-stubs", "pi-tui.ts")).href;
	const extra = `data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(tui)}; export class Editor { setText() {} handleInput() {} render() { return []; } } export const wrapTextWithAnsi = (text) => [text];`)}`;
	const hook = registerHooks({ resolve: (specifier, context, next) => (specifier === "@earendil-works/pi-tui" ? { url: extra, shortCircuit: true } : next(specifier, context)) });
	uninstall = () => {
		hook.deregister();
		stubs();
	};
	askUser = (await import("../extensions/ask-user.ts")).default;
});
after(() => {
	uninstall();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
});

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
const options = [{ label: "SQLite", description: "file" }, { label: "Postgres" }];

/** A TUI session: `ui.custom` builds the real component and stays open until it calls `done`. */
function session() {
	const pi: FakePi = createFakePi();
	askUser(pi);
	const ctx: FakeCtx = createFakeCtx({ cwd: process.cwd() });
	(ctx as any).mode = "tui";
	let component: { handleInput(data: string): void } | undefined;
	(ctx.ui as any).custom = (factory: Function) =>
		new Promise((resolve) => {
			component = factory({ requestRender() {} }, theme, undefined, resolve);
		});
	const prompts = () => pi.emitted.filter((e) => e.channel === BUS.prompt).map((e) => e.data as PromptState);
	const run = (params: object = {}) => pi.tool("ask_user_choice").execute("t1", { question: "Which database?", options, ...params }, undefined, undefined, ctx);
	const answer = (value: unknown) => pi.events.emit(BUS.action, { action: "answer", id: prompts()[0].id, value });
	return { pi, ctx, prompts, run, answer, key: (data: string) => component!.handleInput(data) };
}

describe("ask_user_choice on the bus", () => {
	it("publishes the question as an open choice prompt, and the TUI answer settles it", async () => {
		const s = session();
		const result = s.run({ recommended: 2 });
		const open = s.prompts()[0];
		assert.equal(open.kind, "choice");
		assert.equal(open.source, "ask");
		assert.equal(open.title, "Which database?");
		assert.deepEqual(open.options, options);
		assert.equal(open.recommended, 2);
		assert.equal(open.status, "open");

		s.key("2");
		const r = await result;
		assert.equal(r.content[0].text, "The user chose: 2. Postgres");
		assert.deepEqual(r.details, { question: "Which database?", options: ["SQLite", "Postgres"], answer: "Postgres", wasCustom: undefined });
		assert.deepEqual([s.prompts().at(-1)!.status, s.prompts().at(-1)!.answer, s.prompts().at(-1)!.by], ["answered", "Postgres", "tui"]);
	});

	it("a web answer by label closes the TUI and returns the same text as a TUI choice", async () => {
		const s = session();
		const result = s.run();
		s.answer("Postgres");
		const r = await result;
		assert.equal(r.content[0].text, "The user chose: 2. Postgres");
		assert.equal(r.details.answer, "Postgres");
		assert.equal(s.prompts().at(-1)!.by, "web");
		assert.equal(s.prompts().at(-1)!.status, "answered");
	});

	it("a web free-text answer returns the custom-answer text", async () => {
		const s = session();
		const result = s.run();
		s.answer("DuckDB");
		const r = await result;
		assert.equal(r.content[0].text, "The user answered: DuckDB");
		assert.deepEqual([r.details.answer, r.details.wasCustom], ["DuckDB", true]);
	});

	it("allowOther: false ignores a free-text web answer", async () => {
		const s = session();
		const result = s.run({ allowOther: false });
		s.answer("DuckDB");
		assert.equal(s.prompts().length, 1);
		s.key("1");
		assert.equal((await result).content[0].text, "The user chose: 1. SQLite");
	});

	it("Esc in the TUI is a dismissal, published as dismissed", async () => {
		const s = session();
		const result = s.run();
		s.key("escape");
		const r = await result;
		assert.equal(r.content[0].text, "The user dismissed the question without answering. Stop and wait for them.");
		assert.equal(r.details.answer, null);
		assert.equal(s.prompts().at(-1)!.status, "dismissed");
	});

	it("an aborted run (the tool's signal) closes the question in the TUI and the web; a late web answer has no effect", async () => {
		const s = session();
		const run = new AbortController();
		const result = s.pi.tool("ask_user_choice").execute("t1", { question: "Which database?", options }, run.signal, undefined, s.ctx);
		assert.equal(s.prompts()[0].status, "open");
		run.abort();
		const r = await result;
		assert.equal(r.content[0].text, "The user dismissed the question without answering. Stop and wait for them.");
		assert.equal(s.prompts().at(-1)!.status, "dismissed");
		const count = s.prompts().length;
		s.answer("Postgres");
		assert.equal(s.prompts().length, count);
	});

	describe("in an RPC client (T3 Code, any front end over `pi --mode rpc`): Pi's standard dialogs", () => {
		/** An RPC session: `ui.select` and `ui.input` stay open until the test answers them, or their signal aborts. */
		function rpc(hasUI = true) {
			const s = session();
			Object.assign(s.ctx as any, { mode: "rpc", hasUI });
			const dialogs: Array<{ kind: string; title: string; items?: string[]; signal?: AbortSignal; answer(value: string | undefined): void }> = [];
			const open = (kind: string, title: string, items: string[] | undefined, opts?: { signal?: AbortSignal }) =>
				new Promise<string | undefined>((resolve) => {
					dialogs.push({ kind, title, items, signal: opts?.signal, answer: resolve });
					opts?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
				});
			(s.ctx.ui as any).select = (title: string, items: string[], opts?: { signal?: AbortSignal }) => open("select", title, items, opts);
			(s.ctx.ui as any).input = (title: string, _placeholder?: string, opts?: { signal?: AbortSignal }) => open("input", title, undefined, opts);
			(s.ctx.ui as any).custom = () => assert.fail("an RPC client cannot show a custom component");
			return { ...s, dialogs };
		}
		const tick = () => new Promise((resolve) => setImmediate(resolve));

		it("asks with a select of numbered options, the recommended one marked, and the free-text entry last", async () => {
			const s = rpc();
			const result = s.run({ recommended: 2 });
			await tick();
			assert.equal(s.dialogs.length, 1);
			assert.equal(s.dialogs[0].kind, "select");
			assert.equal(s.dialogs[0].title, "Which database?");
			assert.deepEqual(s.dialogs[0].items, ["1. SQLite — file", "2. Postgres (recommended)", "3. Something else…"]);
			s.dialogs[0].answer("2. Postgres (recommended)");
			const r = await result;
			assert.equal(r.content[0].text, "The user chose: 2. Postgres");
			assert.equal(r.details.answer, "Postgres");
			assert.deepEqual([s.prompts().at(-1)!.status, s.prompts().at(-1)!.by], ["answered", "tui"]);
		});

		it("the free-text entry asks for the answer with an input", async () => {
			const s = rpc();
			const result = s.run();
			await tick();
			s.dialogs[0].answer("3. Something else…");
			await tick();
			assert.equal(s.dialogs[1].kind, "input");
			assert.equal(s.dialogs[1].title, "Which database?");
			s.dialogs[1].answer("  DuckDB ");
			const r = await result;
			assert.equal(r.content[0].text, "The user answered: DuckDB");
			assert.deepEqual([r.details.answer, r.details.wasCustom], ["DuckDB", true]);
		});

		it("allowOther: false has no free-text entry", async () => {
			const s = rpc();
			const result = s.run({ allowOther: false });
			await tick();
			assert.deepEqual(s.dialogs[0].items, ["1. SQLite — file", "2. Postgres"]);
			s.dialogs[0].answer("1. SQLite — file");
			assert.equal((await result).content[0].text, "The user chose: 1. SQLite");
		});

		it("a dismissed select, or an empty free-text answer, is a dismissal", async () => {
			const s = rpc();
			const result = s.run();
			await tick();
			s.dialogs[0].answer(undefined);
			assert.match((await result).content[0].text, /dismissed the question/);
			const t = rpc();
			const other = t.run();
			await tick();
			t.dialogs[0].answer("3. Something else…");
			await tick();
			t.dialogs[1].answer("   ");
			assert.match((await other).content[0].text, /dismissed the question/);
		});

		it("a web answer closes the open dialog and wins", async () => {
			const s = rpc();
			const result = s.run();
			await tick();
			s.answer("Postgres");
			const r = await result;
			assert.equal(r.content[0].text, "The user chose: 2. Postgres");
			assert.equal(s.dialogs[0].signal?.aborted, true);
			assert.equal(s.prompts().at(-1)!.by, "web");
		});

		it("an RPC session without a UI keeps the chat fallback", async () => {
			const s = rpc(false);
			assert.match((await s.run()).content[0].text, /^No interactive UI/);
			assert.equal(s.dialogs.length, 0);
		});
	});

	it("outside the TUI the chat fallback stays and nothing is published", async () => {
		const s = session();
		(s.ctx as any).mode = "print";
		const r = await s.run();
		assert.match(r.content[0].text, /^No interactive UI/);
		assert.equal(s.prompts().length, 0);
	});
});
