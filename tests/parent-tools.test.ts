// S6: the parent session has Pi's grep, find, and ls, and the guard decides their `path` like a read.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
		assert.deepEqual(new Set(pi.getActiveTools()), new Set(["read", "bash", "edit", "write", "other_pkg_tool", "grep", "find", "ls"]));
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
