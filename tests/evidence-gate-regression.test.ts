// Regression probes from brigadev-verify (S3/S4): forged passes and gate blind spots.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { checkOutcome } from "../lib/evidence.ts";

// The extensions import the Pi package at runtime; tests run without it.
const STUB = `data:text/javascript,export const isToolCallEventType=(n,e)=>e.toolName===n;export const getAgentDir=()=>"/nonexistent";export const parseFrontmatter=()=>({});export const getMarkdownTheme=()=>({});`;
registerHooks({ resolve: (spec, ctx, next) => (spec === "@earendil-works/pi-coding-agent" ? { url: STUB, shortCircuit: true } : next(spec, ctx)) });

describe("checkOutcome: exit 0 must belong to the test (S4)", () => {
	for (const command of [`echo npm test`, `grep -n "node --test" package.json`, `true # npm test`, `: npm test`, `! npm test`, `true || npm test`, `exit 0 && npm test`, `echo pipefail; npm test | cat`]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	it("still passes a plain run and an && chain", () => {
		assert.equal(checkOutcome("npm test", 0), "pass");
		assert.equal(checkOutcome("npm run build && npm test", 0), "pass");
	});
});

describe("commit gate wiring (S4)", () => {
	let dir: string;
	let repo: string;
	const saved = { ...process.env };
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-gate-reg-"));
		repo = join(dir, "repo");
		mkdirSync(join(repo, "docs"), { recursive: true });
		for (const key of ["BRIGADEV_CHILD", "BRIGADEV_AGENT", "BRIGADEV_READ_ONLY", "BRIGADEV_PROJECT_ROOT"]) delete process.env[key];
		process.env.BRIGADEV_HOME = join(dir, "home");
		git("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
		writeFileSync(join(repo, "docs", "guide.md"), "# g\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	});
	after(() => {
		process.env = saved;
		rmSync(dir, { recursive: true, force: true });
	});

	async function session(cwd: string) {
		const handlers: Record<string, Function[]> = {};
		const pi: any = {
			on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
			registerCommand: () => {},
			registerShortcut: () => {},
			appendEntry: () => {},
			exec: async (command: string, args: string[], options: { cwd: string }) => {
				try {
					return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }), stderr: "", code: 0 };
				} catch (error: any) {
					return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
				}
			},
		};
		(await import(`../extensions/guard.ts?${Math.random()}`)).default(pi);
		(await import(`../extensions/evidence.ts?${Math.random()}`)).default(pi);
		const ctx: any = { cwd, hasUI: false, sessionManager: { getBranch: () => [] }, ui: { confirm: async () => false, notify: () => {}, setStatus: () => {} } };
		let id = 0;
		return {
			async call(command: string) {
				for (const handler of handlers.tool_call ?? []) {
					const result = await handler({ toolName: "bash", toolCallId: String(++id), input: { command } }, ctx);
					if (result?.block) return result.reason as string;
				}
				return undefined;
			},
			async result(command: string, exitCode: number) {
				for (const handler of handlers.tool_result ?? []) await handler({ toolName: "bash", toolCallId: String(++id), input: { command }, content: [{ type: "text", text: "ok" }], structuredContent: { exit_code: exitCode, output: "ok" } }, ctx);
			},
		};
	}

	it("blocks an untested source change at the repo root when the session runs in a subdirectory", async () => {
		appendFileSync(join(repo, "src.ts"), "export const b = 2;\n");
		const s = await session(join(repo, "docs"));
		const reason = await s.call("git commit -am change");
		assert.match(String(reason), /evidence gate/);
	});

	it("does not vouch for an edit made while the test ran (parallel tool call or `test && edit`)", async () => {
		const s = await session(repo);
		assert.equal(await s.call("npm test"), undefined);
		appendFileSync(join(repo, "src.ts"), "export const c = 3;\n"); // lands before the test's tool_result
		await s.result("npm test", 0);
		const reason = await s.call("git commit -am change");
		assert.match(String(reason), /evidence gate/);
	});
});
