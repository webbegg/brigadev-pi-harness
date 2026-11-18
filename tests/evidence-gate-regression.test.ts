// Evidence gate blind spots: forged passes, flags that run no tests, and commits the gate must still judge.
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

describe("checkOutcome: exit 0 must belong to the test", () => {
	for (const command of [`echo npm test`, `grep -n "node --test" package.json`, `true # npm test`, `: npm test`, `! npm test`, `true || npm test`, `exit 0 && npm test`, `echo pipefail; npm test | cat`]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	it("still passes a plain run and an && chain", () => {
		assert.equal(checkOutcome("npm test", 0), "pass");
		assert.equal(checkOutcome("npm run build && npm test", 0), "pass");
	});
});

describe("checkOutcome: help and version flags run no tests", () => {
	for (const command of [
		"npm test --help", "npm test -h", "npm run test --help", "yarn test --help", "pnpm test --help",
		"node --test --help", "node --test --version", "node --test -v",
		"npx vitest --help", "pytest --version", "go test -h", "cargo test --help",
		"npm test -- --help", "pytest --collect-only", "jest --listTests", "npm test --dry-run",
	]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of [
		"npm test -v", "npm run test -v", "yarn test -v", "pnpm test -v",
		"npm test --help=true", "npm test --version=true", "npm test -H", "npm test -?", "npm test --usage", "npm test --h",
		"node --test --help=true", "node --test --v8-options", "npx vitest -v", "npx jest -v",
	]) {
		it(`is not a pass (near-variant): ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	it("still passes npm's own output flags", () => {
		assert.equal(checkOutcome("npm test --silent", 0), "pass");
		assert.equal(checkOutcome("npm test -s", 0), "pass");
	});
	for (const command of ["npm --help test", "cargo test --no-run", "go test -list .", "npx jest --showConfig", "npm test -- --help=true"]) {
		it(`is not a pass (listing, config, or flag before test): ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of ["npm test --workspace=pkg-a", "pnpm test --filter api"]) {
		it(`is not a pass (options before -- are not trusted, by user decision): ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of [
		"npm test", "npm test -- --test-name-pattern=x", "go test -v ./...", "pytest -v",
		"cargo test -v", "npx vitest run", "node --test tests/*.test.ts", "npm run build && npm test",
	]) {
		it(`still passes: ${command}`, () => assert.equal(checkOutcome(command, 0), "pass"));
	}
	it("still passes runner arguments that run tests", () => {
		assert.equal(checkOutcome("npm test -- --test-name-pattern=gate", 0), "pass");
		assert.equal(checkOutcome("node --test tests/evidence.test.ts", 0), "pass");
		assert.equal(checkOutcome("go test -v ./...", 0), "pass");
		assert.equal(checkOutcome("pytest -v", 0), "pass");
	});
});

describe("checkOutcome: package-manager option values and npm config env never vouch for a pass", () => {
	// npm prints help or its version, exits 0, and runs no script for each of these.
	for (const command of [
		// `-F` / `--filter` are pnpm options; npm does not take a value for them, so the next word is read as an option.
		"npm test -F --help", "npm test --filter --help", "npm test -F -v", "npm run test -F --help", "npm test --filter --usage",
		// npm reads `--color=<value>` and still acts on a flag-like value.
		"npm test --color=-v", "npm test --color=--help", "npm test --color=--usage",
		// npm reads its config from the environment: `usage` prints the usage and skips the script.
		"npm_config_usage=true npm test", "NPM_CONFIG_USAGE=true npm test", "npm_config_usage=1 npm test",
		"export npm_config_usage=true && npm test",
		// Options before `--` are not trusted, by user decision: only `-s` / `--silent` pass.
		"npm test --color=always", "npm test -w pkg", "npm test --workspace=pkg", "npm test --loglevel warn", "pnpm test --filter pkg",
		// Other ways to set npm config in an earlier segment.
		"npm_config_usage=true true && npm test", "pnpm_config_x=1 pnpm test", "yarn_config_x=1 yarn test",
	]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of ["NODE_ENV=test npm test", "npm -s test", "export NODE_ENV=test && npm test"]) {
		it(`still passes: ${command}`, () => assert.equal(checkOutcome(command, 0), "pass"));
	}
});

describe("commit gate wiring", () => {
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

describe("commit gate in nested repositories and subdirectories", () => {
	let dir: string;
	let parent: string;
	let nested: string;
	let repo: string;
	const saved = { ...process.env };
	const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
	const initRepo = (path: string, branch: string) => {
		mkdirSync(join(path, "sub"), { recursive: true });
		git(path, "init", "-q", "-b", branch);
		writeFileSync(join(path, "sub", "src.ts"), "1\n");
		git(path, "add", "-A");
		git(path, "commit", "-qm", "init");
	};

	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-gate-nested-"));
		for (const key of ["BRIGADEV_CHILD", "BRIGADEV_AGENT", "BRIGADEV_READ_ONLY", "BRIGADEV_PROJECT_ROOT"]) delete process.env[key];
		process.env.BRIGADEV_HOME = join(dir, "home");
		parent = join(dir, "parent"); // no repository
		nested = join(parent, "nested");
		repo = join(dir, "repo");
		initRepo(nested, "feat/n");
		initRepo(repo, "feat/r");
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
					return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), stderr: "", code: 0 };
				} catch (error: any) {
					return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
				}
			},
		};
		(await import(`../extensions/guard.ts?${Math.random()}`)).default(pi);
		(await import(`../extensions/evidence.ts?${Math.random()}`)).default(pi);
		// Yolo mode: a commit is not confirmed, so only the evidence gate decides.
		const yolo = [{ type: "custom", customType: "brigadev-mode", data: { mode: "yolo" } }];
		const ctx: any = { cwd, hasUI: false, sessionManager: { getBranch: () => yolo }, ui: { confirm: async () => false, notify: () => {}, setStatus: () => {} } };
		for (const handler of handlers.session_start ?? []) await handler({}, ctx);
		let id = 0;
		return {
			async call(command: string) {
				for (const handler of handlers.tool_call ?? []) {
					const result = await handler({ toolName: "bash", toolCallId: "c", input: { command } }, ctx);
					if (result?.block) return result.reason as string;
				}
				return undefined;
			},
			/** A test run through the handlers: tool_call, then a passing tool_result, so the recorder logs it. */
			async passingRun(command: string) {
				const toolCallId = String(++id);
				for (const handler of handlers.tool_call ?? []) await handler({ toolName: "bash", toolCallId, input: { command } }, ctx);
				for (const handler of handlers.tool_result ?? []) await handler({ toolName: "bash", toolCallId, input: { command }, content: [{ type: "text", text: "ok" }], structuredContent: { exit_code: 0, output: "ok" } }, ctx);
			},
		};
	}

	const forms = (path: string) => [`git -C ${path} commit -am x`, `cd ${path} && git commit -am x`];

	it("blocks a commit into a nested repository with no passing run there (the normal gate message)", async () => {
		appendFileSync(join(nested, "sub", "src.ts"), "2\n");
		const s = await session(parent);
		for (const command of forms("nested")) assert.match(String(await s.call(command)), /no passing test is recorded/, command);
	});

	it("lets `git -C nested commit` and `cd nested && git commit` through once a passing run is recorded in that repository", async () => {
		const s = await session(parent);
		await s.passingRun("cd nested && npm test");
		for (const command of forms("nested")) assert.equal(await s.call(command), undefined, command);
	});

	it("a later edit in the nested repository invalidates that run again", async () => {
		appendFileSync(join(nested, "sub", "src.ts"), "3\n");
		const s = await session(parent);
		for (const command of forms("nested")) assert.match(String(await s.call(command)), /no passing test is recorded/, command);
	});

	it("`cd sub && git commit` inside the same repository is judged by that repository's runs", async () => {
		appendFileSync(join(repo, "sub", "src.ts"), "2\n");
		const s = await session(repo);
		assert.match(String(await s.call("cd sub && git commit -am x")), /no passing test is recorded/);
		await s.passingRun("npm test");
		assert.equal(await s.call("cd sub && git commit -am x"), undefined);
	});

	it("an unresolvable directory still blocks", async () => {
		const s = await session(parent);
		await s.passingRun("cd nested && npm test");
		for (const command of ["cd $TARGET && git commit -am x", "git -C \"$TARGET\" commit -am x", "git --git-dir=nested/.git commit -am x"]) {
			assert.match(String(await s.call(command)), /another directory/, command);
		}
	});
});
