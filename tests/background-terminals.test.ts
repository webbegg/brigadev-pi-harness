// extensions/background-terminals.ts loaded for real, against recording fakes of Pi's API (tests/helpers). Pi's runtime
// packages are stubbed by a test-only module loader; the processes are real shells (POSIX), stopped after every test.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { BG_EXIT_MESSAGE_TYPE } from "../lib/bg-delivery.ts";
import { createFakeCtx, createFakePi, type FakeCtx, type FakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

let root: string;
let cwd: string;
let savedEnv: NodeJS.ProcessEnv;
let uninstall: () => void;
let extension: (pi: any) => void;
const sessions: Array<{ pi: FakePi; ctx: FakeCtx }> = [];

before(async () => {
	// The extension is inert in a child session (BRIGADEV_CHILD=1), and the writer that runs this test is one: start from no BRIGADEV_* at all.
	savedEnv = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-bg-ext-")));
	cwd = path.join(root, "proj");
	fs.mkdirSync(path.join(cwd, "sub"), { recursive: true });
	process.env.BRIGADEV_HOME = path.join(root, "home");
	process.env.PI_CODING_AGENT_DIR = path.join(root, "pi-agent");
	uninstall = installPiStubs();
	extension = (await import("../extensions/background-terminals.ts")).default;
});

afterEach(async () => {
	for (const { pi, ctx } of sessions.splice(0)) await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
});

after(() => {
	uninstall();
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	fs.rmSync(root, { recursive: true, force: true });
});

type Run = (name: string, params?: Record<string, unknown>) => Promise<any>;

const load = async (options: { hasUI?: boolean; idle?: boolean } = {}) => {
	const pi = createFakePi();
	extension(pi);
	const ctx = createFakeCtx({ cwd, hasUI: options.hasUI ?? false, idle: options.idle ?? true });
	sessions.push({ pi, ctx });
	await pi.fire("session_start", { type: "session_start" }, ctx);
	const run: Run = (name, params = {}) => pi.tool(name).execute("call", params, undefined, undefined, ctx);
	return { pi, ctx, run };
};
const text = (result: { content: Array<{ text: string }> }) => result.content.map((c) => c.text).join("\n");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean | Promise<boolean>, ms = 5000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await sleep(20);
	}
	return check();
}

/** Polls `bg_status` (which marks a settled process as seen) until its text matches. */
async function statusMatching(run: Run, id: string, pattern: RegExp): Promise<string> {
	let status = "";
	await until(async () => ((status = text(await run("bg_status", { id }))), pattern.test(status)));
	return status;
}

/** Polls `bg_list` (which marks nothing as seen) until the process is no longer running. */
const listShows = (run: Run, pattern: RegExp) => until(async () => pattern.test(text(await run("bg_list"))));

const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

describe("registration", () => {
	it("registers the four tools, /brigadev:ps, and the lifecycle hooks", async () => {
		const { pi } = await load();
		assert.deepEqual([...pi.tools.keys()].sort(), ["bg_kill", "bg_list", "bg_start", "bg_status"]);
		assert.ok(pi.commands.has("brigadev:ps"));
		for (const event of ["session_start", "session_shutdown", "agent_settled"]) assert.ok(pi.handlers.has(event), event);
		assert.deepEqual([...pi.renderers.keys()], [BG_EXIT_MESSAGE_TYPE]);
	});

	it("registers nothing in a child session (S1c)", () => {
		process.env.BRIGADEV_CHILD = "1";
		try {
			const pi = createFakePi();
			extension(pi);
			assert.equal(pi.tools.size, 0);
			assert.equal(pi.handlers.size, 0);
			assert.equal(pi.commands.size, 0);
			assert.equal(pi.shortcuts.size, 0);
		} finally {
			delete process.env.BRIGADEV_CHILD;
		}
	});
});

describe("tool schemas", () => {
	it("bg_start: command required; cwd and name optional", async () => {
		const schema = (await load()).pi.tool("bg_start").parameters;
		assert.deepEqual(Object.keys(schema.properties).sort(), ["command", "cwd", "name"]);
		assert.deepEqual(schema.required, ["command"]);
		assert.match(schema.properties.cwd.description, /inside the project/i);
	});

	it("bg_status and bg_kill take an id; bg_list takes nothing", async () => {
		const { pi } = await load();
		for (const name of ["bg_status", "bg_kill"]) {
			assert.deepEqual(Object.keys(pi.tool(name).parameters.properties), ["id"], name);
			assert.deepEqual(pi.tool(name).parameters.required, ["id"], name);
		}
		assert.deepEqual(Object.keys(pi.tool("bg_list").parameters.properties), []);
	});
});

describe("tools", () => {
	it("bg_start runs a command; bg_status shows its output; bg_list lists it; bg_kill stops it", async () => {
		const { run } = await load();
		const started = await run("bg_start", { command: "echo hello-bg; sleep 30", name: "greeter" });
		assert.match(text(started), /^Started background process bg-1 "greeter" \(pid \d+\)/);
		assert.equal(started.details.id, "bg-1");
		const status = await statusMatching(run, "bg-1", /hello-bg/);
		assert.match(status, /^bg-1 "greeter": running for \d+s/);
		assert.match(text(await run("bg_list")), /^bg-1 "greeter": running/);
		const killed = await run("bg_kill", { id: "bg-1" });
		assert.match(text(killed), /^Killed bg-1 "greeter": killed/);
		assert.equal(killed.details.state, "killed");
		assert.match(text(await run("bg_list")), /bg-1 "greeter": killed/);
	});

	it("bg_list says so when nothing was started", async () => {
		assert.equal(text(await (await load()).run("bg_list")), "No background processes.");
	});

	it("an unknown id is an error naming the known ones", async () => {
		const { run } = await load();
		await run("bg_start", { command: "sleep 30" });
		for (const name of ["bg_status", "bg_kill"]) await assert.rejects(() => run(name, { id: "bg-9" }), /Unknown background process "bg-9"\. Known: bg-1\./, name);
		const fresh = await load();
		await assert.rejects(() => fresh.run("bg_status", { id: "bg-1" }), /Known: none\./);
	});

	it("rejects an empty command", async () => {
		const { run } = await load();
		await assert.rejects(() => run("bg_start", { command: "  " }), /command/i);
	});

	it("runs in the session cwd by default and in a relative cwd when given; a cwd that is not a directory is an error", async () => {
		const { run } = await load();
		const first = await run("bg_start", { command: "pwd" });
		const second = await run("bg_start", { command: "pwd", cwd: "sub" });
		assert.equal(second.details.cwd, path.join(cwd, "sub"));
		assert.match(await statusMatching(run, first.details.id, /done \(exit 0\)/), new RegExp(`\\n${cwd}$`));
		assert.match(await statusMatching(run, second.details.id, /done \(exit 0\)/), new RegExp(`\\n${path.join(cwd, "sub")}$`));
		await assert.rejects(() => run("bg_start", { command: "pwd", cwd: "missing" }), /not a directory/);
		fs.writeFileSync(path.join(cwd, "afile"), "x");
		await assert.rejects(() => run("bg_start", { command: "pwd", cwd: "afile" }), /not a directory/);
	});

	it("runs the command like Pi's bash tool: Pi's bin dir first on PATH", async () => {
		const { run } = await load();
		const { details } = await run("bg_start", { command: "echo path=$PATH" });
		const status = await statusMatching(run, details.id, /^path=/m);
		assert.ok(status.includes(`\npath=${path.join(process.env.PI_CODING_AGENT_DIR!, "bin")}${path.delimiter}`), status);
	});

	it("allows at most 8 running", async () => {
		const { run } = await load();
		for (let i = 0; i < 8; i++) await run("bg_start", { command: "sleep 30" });
		await assert.rejects(() => run("bg_start", { command: "sleep 30" }), /at most 8|Too many/i);
	});

	it("starts with no stdin", async () => {
		const { run } = await load();
		const { details } = await run("bg_start", { command: "cat; echo eof-seen" });
		assert.match(await statusMatching(run, details.id, /eof-seen/), /eof-seen/);
	});
});

describe("exit delivery", () => {
	it("delivers the exit once, at once when the session is idle", async () => {
		const { pi, ctx, run } = await load({ idle: true });
		await run("bg_start", { command: "echo final-words; exit 3", name: "job" });
		assert.ok(await until(() => pi.messages.length === 1));
		const { message, options } = pi.messages[0];
		assert.equal(message.customType, BG_EXIT_MESSAGE_TYPE);
		assert.equal(message.display, true);
		assert.match(message.content, /Background process bg-1 "job" finished: failed \(exit 3\)/);
		assert.match(message.content, /final-words/);
		assert.deepEqual(options, { triggerTurn: true, deliverAs: "steer" });
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(pi.messages.length, 1, "never twice");
	});

	it("holds the exit while the session is busy and delivers every held one as one message when it settles", async () => {
		const { pi, ctx, run } = await load({ idle: false });
		await run("bg_start", { command: "echo one" });
		await run("bg_start", { command: "echo two" });
		assert.ok(await listShows(run, /bg-1 .*: done[\s\S]*bg-2 .*: done/));
		assert.equal(pi.messages.length, 0);
		ctx.idle = true;
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(pi.messages.length, 1);
		// In the order they exited, which two near-simultaneous processes do not fix.
		assert.match(pi.messages[0].message.content, /^2 background processes finished \(bg-[12], bg-[12]\)/);
		for (const id of ["bg-1", "bg-2"]) assert.ok(pi.messages[0].message.content.includes(`## ${id} `), id);
	});

	it("does not deliver an exit the model already saw through bg_status", async () => {
		const { pi, ctx, run } = await load({ idle: false });
		await run("bg_start", { command: "echo seen" });
		await run("bg_start", { command: "echo unseen" });
		assert.ok(await listShows(run, /bg-1 .*: done[\s\S]*bg-2 .*: done/));
		await run("bg_status", { id: "bg-1" });
		ctx.idle = true;
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(pi.messages.length, 1);
		assert.match(pi.messages[0].message.content, /Background process bg-2/);
		assert.ok(!pi.messages[0].message.content.includes("bg-1"));
	});

	it("does not deliver the exit of a process the model killed itself", async () => {
		const { pi, ctx, run } = await load({ idle: true });
		await run("bg_start", { command: "sleep 30" });
		await run("bg_kill", { id: "bg-1" });
		await sleep(100);
		await pi.fire("agent_settled", {}, ctx);
		assert.equal(pi.messages.length, 0);
	});

	it("does not deliver after the session shut down", async () => {
		const { pi, ctx, run } = await load({ idle: false });
		await run("bg_start", { command: "sleep 0.2; echo late" });
		await pi.fire("session_shutdown", {}, ctx);
		ctx.idle = true;
		await pi.fire("agent_settled", {}, ctx);
		await sleep(300);
		assert.equal(pi.messages.length, 0);
	});
});

describe("status line", () => {
	it("shows `bg: N running` while any run and clears it after, under its own key", async () => {
		const { ctx, run } = await load({ hasUI: true });
		await run("bg_start", { command: "sleep 30" });
		await run("bg_start", { command: "sleep 30" });
		assert.deepEqual(ctx.statuses.at(-1), { key: "brigadev-bg", text: "bg: 2 running" });
		await run("bg_kill", { id: "bg-1" });
		assert.deepEqual(ctx.statuses.at(-1), { key: "brigadev-bg", text: "bg: 1 running" });
		await run("bg_kill", { id: "bg-2" });
		assert.deepEqual(ctx.statuses.at(-1), { key: "brigadev-bg", text: undefined });
		assert.ok(ctx.statuses.every((s) => s.key === "brigadev-bg"));
	});

	it("sets nothing without a UI", async () => {
		const { ctx, run } = await load({ hasUI: false });
		await run("bg_start", { command: "sleep 30" });
		assert.deepEqual(ctx.statuses, []);
	});
});

describe("lifecycle", () => {
	it("session_shutdown stops every process, even one that ignores SIGTERM, within a bound", async () => {
		const { pi, ctx, run } = await load();
		const a = await run("bg_start", { command: "sleep 300" });
		const b = await run("bg_start", { command: "trap '' TERM; while :; do sleep 0.2; done" });
		await sleep(300);
		const started = Date.now();
		await pi.fire("session_shutdown", { type: "session_shutdown" }, ctx);
		assert.ok(Date.now() - started < 9000, "bounded");
		assert.ok(await until(() => !alive(a.details.pid) && !alive(b.details.pid), 2000));
	});

	it("session_start forgets the finished ones of the previous session", async () => {
		const { pi, ctx, run } = await load();
		await run("bg_start", { command: "echo x" });
		assert.ok(await listShows(run, /: done/));
		await pi.fire("session_start", { type: "session_start" }, ctx);
		assert.equal(text(await run("bg_list")), "No background processes.");
	});
});

describe("/brigadev:ps", () => {
	it("without the interactive UI it notifies the list", async () => {
		const { pi, ctx, run } = await load({ hasUI: true });
		const ps = pi.commands.get("brigadev:ps");
		await ps.handler("", ctx);
		assert.match(ctx.notifications.at(-1)!.message, /No background processes/);
		await run("bg_start", { command: "sleep 30", name: "w" });
		await ps.handler("", ctx);
		assert.match(ctx.notifications.at(-1)!.message, /^bg-1 "w": running/);
	});

	const overlay = (ctx: FakeCtx) => {
		const state: { options?: any; component?: any; closed: boolean } = { closed: false };
		ctx.mode = "tui";
		(ctx.ui as any).custom = async (factory: Function, options: unknown) => {
			state.options = options;
			const tui = { terminal: { rows: 20 }, requestRender: () => {} };
			const theme = { fg: (_tone: string, s: string) => s, bold: (s: string) => s };
			state.component = await factory(tui, theme, {}, () => void (state.closed = true));
		};
		return state;
	};

	it("in the interactive UI it opens a full-screen overlay that shows the output and kills the selected process", async () => {
		const { pi, ctx, run } = await load({ hasUI: true });
		const view = overlay(ctx);
		await run("bg_start", { command: "echo overlay-text; sleep 300", name: "watcher" });
		await run("bg_start", { command: "sleep 300", name: "second" });
		await pi.commands.get("brigadev:ps").handler("", ctx);
		assert.deepEqual(view.options, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } });

		let screen = "";
		assert.ok(await until(() => ((screen = view.component.render(120).join("\n")), /overlay-text/.test(screen))));
		for (const wanted of [/bg-1/, /watcher/, /bg-2/, /second/]) assert.match(screen, wanted);

		view.component.handleInput("x");
		assert.ok(await listShows(run, /bg-1 "watcher": killed/));
		assert.match(text(await run("bg_list")), /bg-2 "second": running/);

		view.component.handleInput("j");
		view.component.handleInput("x");
		assert.ok(await listShows(run, /bg-2 "second": killed/));

		view.component.handleInput("q");
		assert.equal(view.closed, true);
	});

	it("a process the user killed in the overlay is still reported to the model once", async () => {
		const { pi, ctx, run } = await load({ hasUI: true, idle: true });
		const view = overlay(ctx);
		await run("bg_start", { command: "sleep 300", name: "victim" });
		await pi.commands.get("brigadev:ps").handler("", ctx);
		view.component.handleInput("x");
		assert.ok(await until(() => pi.messages.length === 1));
		assert.match(pi.messages[0].message.content, /Background process bg-1 "victim" finished: killed/);
	});

	it("says there is nothing to show instead of opening an empty overlay", async () => {
		const { pi, ctx } = await load({ hasUI: true });
		const view = overlay(ctx);
		await pi.commands.get("brigadev:ps").handler("", ctx);
		assert.equal(view.component, undefined);
		assert.match(ctx.notifications.at(-1)!.message, /No background processes/);
	});
});
