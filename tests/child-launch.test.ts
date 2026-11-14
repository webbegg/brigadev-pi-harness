import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { childLaunch, type ChildLaunchInput } from "../lib/child-launch.ts";
import { CHILD_ENV, EVIDENCE_EXTENSION_PATH, GUARD_EXTENSION_PATH, STRUCTURED_OUTPUT_EXTENSION_PATH } from "../lib/runtime.ts";
import { STRUCTURED_OUTPUT_TOOL } from "../lib/structured-output.ts";

const input = (over: Partial<ChildLaunchInput> = {}): ChildLaunchInput => ({
	agent: { name: "brigadev-explore", writer: false },
	allowedEditSurfaces: undefined,
	route: { model: undefined, thinking: undefined },
	cwd: "/work/repo",
	parentEnv: { PATH: "/usr/bin" },
	...over,
});

const pairs = (args: string[], flag: string) => args.flatMap((a, i) => (a === flag ? [args[i + 1]] : []));

describe("childLaunch: a child can never ask for permission and hang (S0)", () => {
	const variants: Array<[string, Partial<ChildLaunchInput>]> = [
		["read-only", {}],
		["writer with surfaces", { agent: { name: "w", writer: true }, allowedEditSurfaces: ["lib/a.ts"] }],
		["routed model and tools", { route: { model: "anthropic/x", thinking: "high" }, agent: { name: "t", writer: false, tools: ["read", "grep"] } }],
		["structured output", { structured: true, agent: { name: "s", writer: false, outputSchema: "/schemas/s.json" } }],
		["system prompt", { systemPromptPath: "/tmp/system.md" }],
		["parent env says it is not a child", { parentEnv: { [CHILD_ENV.CHILD]: "0" } }],
	];
	for (const [name, over] of variants) {
		// RPC mode keeps stdin open so a running child can be steered. A child extension's UI request is then answered by the
		// parent with a cancellation (lib/child-rpc.ts), so nothing a child asks can wait for a person.
		it(`RPC mode without a session, guard + evidence, stdin piped, no positional task, child env: ${name}`, () => {
			const { args, env, stdio } = childLaunch(input(over));
			assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
			assert.ok(!args.includes("json") && !args.includes("-p") && !args.includes("--print"));
			assert.ok(!args.includes("--no-extensions"), "the user's own extensions still load");
			assert.deepEqual(pairs(args, "-e").slice(0, 2), [GUARD_EXTENSION_PATH, EVIDENCE_EXTENSION_PATH]);
			assert.deepEqual(stdio, ["pipe", "pipe", "pipe"]);
			assert.equal(env[CHILD_ENV.CHILD], "1");
		});

		it(`sends the task as an RPC prompt, never in argv (rpc.md:20): ${name}`, () => {
			const { args } = childLaunch(input(over));
			// Every argument is a flag or the value of a value-taking flag: no bare positional remains.
			const valueFlags = new Set(["--mode", "-e", "--model", "--thinking", "--tools", "--append-system-prompt"]);
			const positional = args.filter((a, i) => !a.startsWith("-") && !valueFlags.has(args[i - 1]));
			assert.deepEqual(positional, []);
		});
	}
});

describe("childLaunch: arguments", () => {
	it("ends with the system prompt flag; the task is not an argument", () => {
		const { args } = childLaunch(input({ systemPromptPath: "/tmp/system.md" }));
		assert.deepEqual(args.slice(-2), ["--append-system-prompt", "/tmp/system.md"]);
	});

	it("omits the system prompt flag without a prompt file", () => {
		const { args } = childLaunch(input());
		assert.ok(!args.includes("--append-system-prompt"));
		assert.deepEqual(args.slice(0, 3), ["--mode", "rpc", "--no-session"]);
	});

	it("passes model, thinking and agent tools", () => {
		const { args } = childLaunch(input({ route: { model: "anthropic/x", thinking: "high" }, agent: { name: "a", writer: false, tools: ["read", "grep"] } }));
		assert.deepEqual(pairs(args, "--model"), ["anthropic/x"]);
		assert.deepEqual(pairs(args, "--thinking"), ["high"]);
		assert.deepEqual(pairs(args, "--tools"), ["read,grep"]);
	});

	it("adds the structured output extension and tool only for structured runs", () => {
		const plain = childLaunch(input({ agent: { name: "a", writer: false, tools: ["read"] } }));
		assert.ok(!plain.args.includes(STRUCTURED_OUTPUT_EXTENSION_PATH));
		const structured = childLaunch(input({ structured: true, agent: { name: "a", writer: false, tools: ["read"], outputSchema: "/s.json" } }));
		assert.deepEqual(pairs(structured.args, "-e"), [GUARD_EXTENSION_PATH, EVIDENCE_EXTENSION_PATH, STRUCTURED_OUTPUT_EXTENSION_PATH]);
		assert.deepEqual(pairs(structured.args, "--tools"), [`read,${STRUCTURED_OUTPUT_TOOL}`]);
	});
});

describe("childLaunch: environment", () => {
	it("carries the child contract and the parent environment", () => {
		const { env } = childLaunch(input({ agent: { name: "brigadev-explore", writer: false } }));
		assert.equal(env.PATH, "/usr/bin");
		assert.equal(env.PWD, "/work/repo");
		assert.equal(env[CHILD_ENV.AGENT], "brigadev-explore");
		assert.equal(env[CHILD_ENV.PROJECT_ROOT], "/work/repo");
		assert.equal(env[CHILD_ENV.READ_ONLY], "1");
	});

	it("a writer gets its surfaces; a stale inherited value never leaks to read-only agents", () => {
		const writer = childLaunch(input({ agent: { name: "w", writer: true }, allowedEditSurfaces: ["lib/a.ts", "tests/*.ts"] }));
		assert.equal(writer.env[CHILD_ENV.READ_ONLY], "0");
		assert.deepEqual(JSON.parse(writer.env[CHILD_ENV.ALLOWED_SURFACES]!), ["lib/a.ts", "tests/*.ts"]);
		const reader = childLaunch(input({ parentEnv: { [CHILD_ENV.ALLOWED_SURFACES]: '["x"]', [CHILD_ENV.OUTPUT_SCHEMA]: "/old.json" } }));
		assert.ok(!(CHILD_ENV.ALLOWED_SURFACES in reader.env));
		assert.ok(!(CHILD_ENV.OUTPUT_SCHEMA in reader.env));
	});

	it("sets the output schema only for structured runs", () => {
		const { env } = childLaunch(input({ structured: true, agent: { name: "s", writer: false, outputSchema: "/schemas/s.json" } }));
		assert.equal(env[CHILD_ENV.OUTPUT_SCHEMA], "/schemas/s.json");
	});

	it("does not mutate the parent environment", () => {
		const parentEnv = { PATH: "/usr/bin" };
		childLaunch(input({ parentEnv }));
		assert.deepEqual(parentEnv, { PATH: "/usr/bin" });
	});
});
