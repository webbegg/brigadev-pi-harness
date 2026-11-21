// S6: the parent session has Pi's grep, find, and ls, and the guard decides their `path` like a read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, agentDir: string;
let uninstall: () => void;
let orchestrator: (pi: any) => void;
let guard: (pi: any) => void;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "parent-tools-")));
	repo = join(dir, "repo");
	agentDir = join(dir, "home", ".pi", "agent");
	mkdirSync(repo, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
	process.env.BRIGADEV_HOME = join(dir, "home", ".brigadev");
	process.env.PI_CODING_AGENT_DIR = agentDir;
	uninstall = installPiStubs();
	orchestrator = (await import("../extensions/orchestrator.ts")).default;
	guard = (await import("../extensions/guard.ts")).default;
});
after(() => {
	uninstall();
	for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
	Object.assign(process.env, saved);
	rmSync(dir, { recursive: true, force: true });
});

/** The fake pi plus the active-tool calls of Pi's real API. */
function withActiveTools(initial: string[]) {
	const pi: any = createFakePi();
	let active = [...initial];
	pi.setCalls = [] as string[][];
	pi.getActiveTools = () => [...active];
	pi.setActiveTools = (names: string[]) => {
		pi.setCalls.push(names);
		active = [...names];
	};
	return pi;
}

function asChild<T>(build: () => T): T {
	process.env.BRIGADEV_CHILD = "1";
	try {
		return build();
	} finally {
		delete process.env.BRIGADEV_CHILD;
	}
}

describe("parent search tools", () => {
	it("activates grep, find, and ls at session start and keeps the other active tools", async () => {
		const pi = withActiveTools(["read", "bash", "edit", "write", "other_pkg_tool"]);
		orchestrator(pi);
		await pi.fire("session_start", {}, createFakeCtx({ cwd: repo, hasUI: false }));
		assert.deepEqual(new Set(pi.getActiveTools()), new Set(["read", "bash", "edit", "write", "other_pkg_tool", "grep", "find", "ls", "codemode"]));
	});

	it("sets the tools once: a second session start or a turn changes nothing", async () => {
		const pi = withActiveTools(["read", "bash"]);
		orchestrator(pi);
		const ctx = createFakeCtx({ cwd: repo, hasUI: false });
		await pi.fire("session_start", {}, ctx);
		await pi.fire("session_start", {}, ctx);
		await pi.fire("before_agent_start", { systemPromptOptions: {} }, ctx);
		assert.equal(pi.setCalls.length, 1);
	});

	it("leaves a child session alone (children get explicit --tools)", async () => {
		const pi = withActiveTools(["read"]);
		asChild(() => orchestrator(pi));
		await pi.fire("session_start", {}, createFakeCtx({ cwd: repo, hasUI: false }));
		assert.equal(pi.setCalls.length, 0);
	});
});

describe("codemode on by default", () => {
	const settingsFile = () => join(agentDir, "brigadev.json");
	const setSetting = (value: unknown) => writeFileSync(settingsFile(), JSON.stringify(value === undefined ? {} : { codemode: value }));
	const savedSetting = () => JSON.parse(readFileSync(settingsFile(), "utf8")).codemode;

	async function started(initial: string[]) {
		const pi = withActiveTools(initial);
		orchestrator(pi);
		const ctx: any = createFakeCtx({ cwd: repo, hasUI: true });
		const notes: string[] = [];
		ctx.ui.notify = (text: string) => notes.push(text);
		await pi.fire("session_start", {}, ctx);
		return { pi, ctx, notes, run: (args: string) => pi.commands.get("brigadev:codemode").handler(args, ctx) };
	}

	it("activates codemode at session start unless the setting turns it off", async () => {
		setSetting(undefined);
		assert.ok((await started(["read"])).pi.getActiveTools().includes("codemode"));
		setSetting(true);
		assert.ok((await started(["read"])).pi.getActiveTools().includes("codemode"));
		setSetting(false);
		assert.ok(!(await started(["read"])).pi.getActiveTools().includes("codemode"));
	});

	it("with the setting off, leaves codemode enabled by Pi's own settings alone", async () => {
		setSetting(false);
		assert.ok((await started(["read", "codemode"])).pi.getActiveTools().includes("codemode"));
	});

	it("/brigadev:codemode off saves the setting and removes the tool now; on brings both back", async () => {
		setSetting(undefined);
		const s = await started(["read", "bash"]);
		await s.run("off");
		assert.equal(savedSetting(), false);
		assert.deepEqual(new Set(s.pi.getActiveTools()), new Set(["read", "bash", "grep", "find", "ls"]));
		assert.match(s.notes.at(-1) ?? "", /codemode off/);
		await s.run("on");
		assert.equal(savedSetting(), true);
		assert.ok(s.pi.getActiveTools().includes("codemode"));
		assert.match(s.notes.at(-1) ?? "", /codemode on/);
	});

	it("/brigadev:codemode without on|off reports the state and the usage, and changes nothing", async () => {
		setSetting(undefined);
		const s = await started(["read"]);
		const calls = s.pi.setCalls.length;
		await s.run("");
		await s.run("maybe");
		assert.equal(s.pi.setCalls.length, calls);
		assert.match(s.notes.at(-1) ?? "", /codemode: on[\s\S]*Usage: \/brigadev:codemode on\|off/);
	});

	it("a child session gets no codemode and no command", async () => {
		setSetting(undefined);
		const pi = withActiveTools(["read"]);
		asChild(() => orchestrator(pi));
		await pi.fire("session_start", {}, createFakeCtx({ cwd: repo, hasUI: false }));
		assert.ok(!pi.getActiveTools().includes("codemode"));
		assert.equal(pi.commands.get("brigadev:codemode"), undefined);
	});
});

async function guarded(o: { answer?: boolean; child?: boolean } = {}) {
	const pi: any = createFakePi();
	pi.exec = async () => ({ stdout: "", stderr: "", code: 1, killed: false });
	asChild(() => (o.child ? guard(pi) : undefined));
	if (!o.child) guard(pi);
	const asked: string[] = [];
	const ctx: any = createFakeCtx({ cwd: repo, hasUI: true });
	ctx.ui.confirm = async (title: string) => (asked.push(title), o.answer ?? false);
	await pi.fire("session_start", {}, ctx);
	let id = 0;
	return {
		asked,
		/** The text a tool_result handler leaves for the model, or undefined when it keeps the output as it is. */
		async result(toolName: string, input: Record<string, unknown>, text: string) {
			const event: any = { toolName, toolCallId: String(++id), input, content: [{ type: "text", text }], isError: false };
			let out: string | undefined;
			for (const h of pi.handlers.get("tool_result") ?? []) {
				const r = await h(event, ctx);
				if (r?.content) {
					out = r.content.map((c: any) => c.text).join("");
					event.content = r.content;
				}
			}
			return out;
		},
		/** The block reason of a tool_call, or undefined when it may run. */
		async run(toolName: string, input: Record<string, unknown>) {
			for (const h of pi.handlers.get("tool_call") ?? []) {
				const r = await h({ toolName, toolCallId: String(++id), input }, ctx);
				if (r?.block) return String(r.reason);
			}
			return undefined;
		},
	};
}

describe("guard on the path of grep, find, and ls", () => {
	for (const tool of ["grep", "find", "ls"]) {
		it(`${tool}: the parent is asked about a sensitive path, and a refusal blocks it`, async () => {
			const s = await guarded({ answer: false });
			const reason = await s.run(tool, { path: "~/.ssh", pattern: "x" });
			assert.deepEqual(s.asked, ["brigadev: sensitive file"]);
			assert.match(reason ?? "", /declined access to sensitive file ~\/\.ssh/);
		});

		it(`${tool}: the parent may allow a sensitive path`, async () => {
			const s = await guarded({ answer: true });
			assert.equal(await s.run(tool, { path: join(repo, ".ssh"), pattern: "x" }), undefined);
			assert.equal(s.asked.length, 1);
		});

		it(`${tool}: a child is blocked without a question`, async () => {
			const s = await guarded({ child: true, answer: true });
			const reason = await s.run(tool, { path: "~/.ssh", pattern: "x" });
			assert.match(reason ?? "", /may hold secrets/);
			assert.deepEqual(s.asked, []);
		});

		it(`${tool}: an ordinary path, or no path, runs without a question`, async () => {
			const s = await guarded();
			assert.equal(await s.run(tool, { path: "src", pattern: "x" }), undefined);
			assert.equal(await s.run(tool, { pattern: "x" }), undefined);
			assert.deepEqual(s.asked, []);
		});
	}

	it("a single sensitive file is asked about too", async () => {
		const s = await guarded({ answer: false });
		assert.match((await s.run("grep", { path: ".env", pattern: "x" })) ?? "", /declined/);
		assert.deepEqual(s.asked, ["brigadev: sensitive file"]);
	});
});

describe("search results never show sensitive files", () => {
	async function resultOf(toolName: string, input: Record<string, unknown>, text: string, o: { child?: boolean; answer?: boolean } = {}) {
		const s = await guarded(o);
		return s.result(toolName, input, text);
	}

	it("grep: drops lines of sensitive files, keeps the rest and the trailing notice, and says how many were hidden", async () => {
		const text = "src/a.ts:3: BEGIN here\n.env:1: BEGIN SECRET\nkeys/id_rsa:2: BEGIN PRIVATE\nkeys/id_rsa-3- context line\nsrc/b.ts:9: BEGIN again\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]";
		for (const child of [false, true]) {
			const out = await resultOf("grep", { pattern: "BEGIN", path: "." }, text, { child });
			assert.equal(out, "src/a.ts:3: BEGIN here\nsrc/b.ts:9: BEGIN again\n\n[100 matches limit reached. Use limit=200 for more, or refine pattern]\n(3 results from sensitive files hidden)");
		}
	});

	it("find and ls: drop sensitive entries", async () => {
		assert.equal(await resultOf("find", { pattern: "*", path: "." }, "a.ts\n.env\nsub/.env.local\nsub/b.ts"), "a.ts\nsub/b.ts\n(2 results from sensitive files hidden)");
		assert.equal(await resultOf("ls", { path: "." }, ".env\n.ssh/\nsrc/\nREADME.md"), "src/\nREADME.md\n(2 results from sensitive files hidden)");
	});

	it("resolves lines against the tool's path, not the working directory", async () => {
		assert.equal(await resultOf("find", { pattern: "*", path: "~/.ssh/.." }, "id_rsa\nnotes.txt"), "notes.txt\n(1 result from sensitive files hidden)");
	});

	it("leaves results untouched when nothing is sensitive, and other tools alone", async () => {
		assert.equal(await resultOf("grep", { pattern: "x", path: "src" }, "a.ts:1: x"), undefined);
		assert.equal(await resultOf("bash", { command: "cat .env" }, ".env:1: x"), undefined);
	});

	it("does not hide what the user just allowed: a search rooted in a sensitive folder", async () => {
		assert.equal(await resultOf("grep", { pattern: "x", path: join(repo, ".ssh") }, "id_rsa:1: x", { answer: true }), undefined);
	});
});
