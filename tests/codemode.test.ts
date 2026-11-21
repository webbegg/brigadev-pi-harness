// Codemode in the workflow: the parent learns when to script tool calls, read-only subagents get the tool,
// and a subagent's script reaches only the tools its agent definition lists.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PACKAGE_AGENTS_DIR } from "../lib/runtime.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const saved = { ...process.env };
let dir: string, repo: string, agentDir: string;
let uninstall: () => void;
let orchestrator: (pi: any) => void;
let guard: (pi: any) => void;

before(async () => {
	dir = realpathSync(mkdtempSync(join(tmpdir(), "codemode-")));
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

/** `installed`: the tools the host Pi has at all (`pi.getAllTools()`); by default a Pi that ships codemode. */
function withActiveTools(initial: string[], installed: string[] = [...initial, "grep", "find", "ls", "codemode"]) {
	const pi: any = createFakePi();
	let active = [...initial];
	pi.getActiveTools = () => [...active];
	pi.setActiveTools = (names: string[]) => void (active = [...names]);
	pi.getAllTools = () => installed.map((name) => ({ name }));
	return pi;
}

describe("codemode guidance in the orchestrator prompt", () => {
	async function promptWith(initial: string[], setting?: boolean) {
		writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify(setting === undefined ? {} : { codemode: setting }));
		const pi = withActiveTools(initial);
		orchestrator(pi);
		const ctx = createFakeCtx({ cwd: repo, hasUI: false });
		await pi.fire("session_start", {}, ctx);
		const event = { systemPromptOptions: {} as { appendSystemPrompt?: string } };
		await pi.fire("before_agent_start", event, ctx);
		return { pi, ctx, event, prompt: event.systemPromptOptions.appendSystemPrompt ?? "" };
	}

	it("adds the codemode block while codemode is active: explore batches and git/PR/CI digests in one script", async () => {
		const { prompt } = await promptWith(["read"]);
		assert.match(prompt, /## Codemode/);
		assert.match(prompt, /grep/);
		assert.match(prompt, /gh pr checks/);
		assert.match(prompt, /--log-failed/);
	});

	it("leaves it out when codemode is not active", async () => {
		const { prompt } = await promptWith(["read"], false);
		assert.match(prompt, /# brigadev/);
		assert.doesNotMatch(prompt, /## Codemode/);
	});

	it("follows /brigadev:codemode off on the next prompt", async () => {
		const s = await promptWith(["read"]);
		await s.pi.commands.get("brigadev:codemode").handler("off", s.ctx);
		const event = { systemPromptOptions: {} as { appendSystemPrompt?: string } };
		await s.pi.fire("before_agent_start", event, s.ctx);
		assert.doesNotMatch(event.systemPromptOptions.appendSystemPrompt ?? "", /## Codemode/);
	});
});

describe("codemode is activated only when the host Pi has the tool", () => {
	async function session(initial: string[], installed: string[] | undefined, setting?: boolean) {
		writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify(setting === undefined ? {} : { codemode: setting }));
		const pi = withActiveTools(initial, installed);
		orchestrator(pi);
		const ctx = createFakeCtx({ cwd: repo, hasUI: true });
		await pi.fire("session_start", {}, ctx);
		const event = { systemPromptOptions: {} as { appendSystemPrompt?: string } };
		await pi.fire("before_agent_start", event, ctx);
		return { pi, ctx, prompt: event.systemPromptOptions.appendSystemPrompt ?? "", active: () => pi.getActiveTools() as string[] };
	}

	it("a Pi without the tool keeps its tools as they were (the search tools still come), and the prompt has no codemode block", async () => {
		const s = await session(["read", "bash"], ["read", "bash", "grep", "find", "ls"]);
		assert.deepEqual(s.active().sort(), ["bash", "find", "grep", "ls", "read"]);
		assert.doesNotMatch(s.prompt, /## Codemode/);
	});

	it("a Pi without getAllTools is treated as not having it", async () => {
		writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify({}));
		const pi = withActiveTools(["read"]);
		delete pi.getAllTools;
		orchestrator(pi);
		await pi.fire("session_start", {}, createFakeCtx({ cwd: repo, hasUI: false }));
		assert.ok(!pi.getActiveTools().includes("codemode"));
	});

	it("/brigadev:codemode says so: the setting is on, but the tool is not in this Pi", async () => {
		const s = await session(["read"], ["read", "grep", "find", "ls"]);
		await s.pi.commands.get("brigadev:codemode").handler("", s.ctx);
		assert.match(s.ctx.notifications.at(-1)!.message, /codemode: on \(not available: this Pi has no codemode tool\)/);
		await s.pi.commands.get("brigadev:codemode").handler("on", s.ctx);
		assert.match(s.ctx.notifications.at(-1)!.message, /this Pi has no codemode tool/);
		assert.ok(!s.active().includes("codemode"), "on does not activate what is not there");
	});

	it("a Pi that has the tool gets it, and the status says active", async () => {
		const s = await session(["read"], ["read", "grep", "find", "ls", "codemode"]);
		assert.ok(s.active().includes("codemode"));
		assert.match(s.prompt, /## Codemode/);
		await s.pi.commands.get("brigadev:codemode").handler("", s.ctx);
		assert.match(s.ctx.notifications.at(-1)!.message, /codemode: on \(active in this session\)/);
	});
});

describe("a subagent's script reaches only its agent's tools", () => {
	async function childGuard(active: string[]) {
		process.env.BRIGADEV_CHILD = "1";
		process.env.BRIGADEV_READ_ONLY = "1";
		process.env.BRIGADEV_AGENT = "brigadev-explore";
		process.env.BRIGADEV_PROJECT_ROOT = repo;
		const pi = withActiveTools(active);
		try {
			guard(pi);
		} finally {
			for (const k of ["BRIGADEV_CHILD", "BRIGADEV_AGENT", "BRIGADEV_PROJECT_ROOT"]) delete process.env[k];
		}
		const ctx = createFakeCtx({ cwd: repo, hasUI: false });
		await pi.fire("session_start", {}, ctx);
		let id = 0;
		return async (toolName: string, input: Record<string, unknown>, parent?: string) => {
			process.env.BRIGADEV_READ_ONLY = "1";
			process.env.BRIGADEV_AGENT = "brigadev-explore";
			try {
				for (const h of pi.handlers.get("tool_call") ?? []) {
					const r = await h({ toolName, toolCallId: parent ? `${parent}/${++id}` : String(++id), parentToolCallId: parent, input }, ctx);
					if (r?.block) return String(r.reason);
				}
				return undefined;
			} finally {
				delete process.env.BRIGADEV_READ_ONLY;
				delete process.env.BRIGADEV_AGENT;
			}
		};
	}

	it("blocks a script's call to a tool the agent does not list, such as an MCP tool", async () => {
		const run = await childGuard(["read", "grep", "find", "ls", "codemode"]);
		const reason = await run("mcp__jira__create_issue", { title: "x" }, "c1");
		assert.match(reason ?? "", /brigadev-explore.*mcp__jira__create_issue/);
	});

	it("lets a script call the agent's own tools", async () => {
		const run = await childGuard(["read", "grep", "find", "ls", "codemode"]);
		assert.equal(await run("read", { path: "src/a.ts" }, "c1"), undefined);
		assert.equal(await run("grep", { pattern: "x", path: "src" }, "c1"), undefined);
		assert.equal(await run("codemode", { code: "return 1" }), undefined);
	});

	it("still blocks a write from a read-only agent's script", async () => {
		const run = await childGuard(["read", "write", "codemode"]);
		assert.match((await run("write", { path: join(repo, "a.ts"), content: "x" }, "c1")) ?? "", /read-only/);
	});
});

describe("read-only agents carry codemode", () => {
	const toolsOf = (name: string) => {
		const line = readFileSync(join(PACKAGE_AGENTS_DIR, `${name}.md`), "utf8").match(/^tools:\s*(.+)$/m)?.[1] ?? "";
		return line.split(",").map((t) => t.trim());
	};
	for (const name of ["brigadev-explore", "review-4r", "brigadev-verify"]) {
		it(`${name} lists codemode and its prompt says when to use it`, () => {
			assert.ok(toolsOf(name).includes("codemode"), `${name}: ${toolsOf(name).join(", ")}`);
			assert.match(readFileSync(join(PACKAGE_AGENTS_DIR, `${name}.md`), "utf8"), /`codemode`/);
		});
	}
	it("the worker does not (its edits stay direct calls the parent can follow)", () => {
		assert.ok(!toolsOf("brigadev-worker").includes("codemode"));
	});
});
