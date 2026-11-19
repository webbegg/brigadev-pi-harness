// S17: doctor warns about competing delegation tools and large foreign tool definitions.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { analyzeTools, riskWarnings, TOOL_CHARS_LIMIT, type ToolInfo } from "../lib/doctor.ts";
import { PACKAGE_ROOT } from "../lib/runtime.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const own = (name: string, description = "x"): ToolInfo => ({ name, description, parameters: {}, sourceInfo: { path: join(PACKAGE_ROOT, "extensions", `${name}.ts`), source: "local" } });
const foreign = (name: string, description = "does a thing", parameters: unknown = {}, pkg = "/home/u/.pi/agent/git/github.com/acme/pkg"): ToolInfo => ({ name, description, parameters, sourceInfo: { path: `${pkg}/extensions/${name}.ts`, source: "git:github.com/acme/pkg" } });
const builtin = (name: string): ToolInfo => ({ name, description: "x".repeat(20_000), parameters: {}, sourceInfo: { path: `builtin:${name}`, source: "builtin" } });

describe("analyzeTools", () => {
	it("ignores brigadev's own and Pi's built-in tools, including its own subagent", () => {
		const r = analyzeTools([own("subagent", "Delegate work to a subagent"), builtin("read"), foreign("weather")]);
		assert.deepEqual(r.delegation, []);
		assert.equal(r.foreign.length, 1);
		assert.equal(r.oversized, false);
		assert.deepEqual(r.warnings, []);
	});
	it("warns about another package's delegation-like tool (by name)", () => {
		const byName = analyzeTools([own("subagent"), foreign("subagent")]);
		assert.deepEqual(byName.delegation.map((t) => t.name), ["subagent"]);
		assert.equal(analyzeTools([foreign("delegate_task")]).delegation.length, 1);
		assert.equal(analyzeTools([foreign("spawn_agents")]).delegation.length, 1);
		assert.equal(byName.warnings.length, 1);
		assert.match(byName.warnings[0], /delegation tool.*subagent/);
	});
	it("LOOP R3-006: a description that merely mentions delegation does not flag a tool whose name does not", () => {
		const r = analyzeTools([foreign("run_helper", "Spawn agent to do work in parallel"), foreign("notes", "Notes the subagent output and delegates nothing")]);
		assert.deepEqual(r.delegation, []);
		assert.deepEqual(r.warnings, []);
	});

	it("LOOP R3-006: brigadev's own tools are recognized by name when Pi gives no source path", () => {
		const bare = (name: string, description = "x"): ToolInfo => ({ name, description, parameters: {} });
		const r = analyzeTools([bare("subagent", "Delegate work to a subagent"), bare("todo"), bare("ask_user_choice"), bare("check"), bare("bg_start"), bare("bg_status"), bare("bg_list"), bare("bg_kill")]);
		assert.deepEqual(r.delegation, []);
		assert.deepEqual(r.foreign, []);
		// Another package's tool by the same name still counts: it has its own path.
		assert.equal(analyzeTools([foreign("subagent")]).delegation.length, 1);
		// An unknown tool without a path is not assumed to be brigadev's.
		assert.equal(analyzeTools([bare("delegate_task")]).delegation.length, 1);
	});

	it("warns when other packages' definitions exceed 8,000 chars in total", () => {
		const small = analyzeTools([foreign("a", "x".repeat(3000)), foreign("b", "y".repeat(3000))]);
		assert.equal(small.oversized, false);
		const big = analyzeTools([foreign("a", "x".repeat(5000)), foreign("b", "y".repeat(4000))]);
		assert.equal(big.oversized, true);
		assert.ok(big.totalChars > TOOL_CHARS_LIMIT);
		assert.match(big.warnings.join("\n"), /8,000/);
		assert.match(big.warnings.join("\n"), /a \d/);
	});
	it("does not count brigadev or built-in definitions toward the limit", () => {
		assert.equal(analyzeTools([own("big", "x".repeat(20_000)), builtin("bash")]).oversized, false);
	});
});

describe("riskWarnings (S3)", () => {
	it("is empty for no risk config or a valid one", () => {
		assert.deepEqual(riskWarnings(undefined), []);
		assert.deepEqual(riskWarnings({ paths: { security: ["lib/x.ts"] }, repos: { r: { data: ["db/**"] } } }), []);
	});
	it("names each invalid entry as ignored", () => {
		const warnings = riskWarnings({ paths: { bogus: ["a"], security: [1] } });
		assert.equal(warnings.length, 2);
		assert.match(warnings[0], /risk\.paths\.bogus: unknown category.*ignored/);
		assert.match(warnings[1], /risk\.paths\.security\[0\].*ignored/);
		assert.equal(riskWarnings("x").length, 1);
	});
});

describe("doctor command", () => {
	const saved = { ...process.env };
	let dir: string, uninstall: () => void, doctor: (pi: any) => void;
	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "doctor-")));
		const agentDir = join(dir, "agent");
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "brigadev.json"), "{}");
		for (const k of Object.keys(process.env)) if (k.startsWith("BRIGADEV_")) delete process.env[k];
		process.env.PI_CODING_AGENT_DIR = agentDir;
		process.env.BRIGADEV_HOME = join(dir, "home");
		uninstall = installPiStubs();
		doctor = (await import("../extensions/doctor.ts")).default;
	});
	after(() => {
		uninstall();
		for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	async function run(tools: ToolInfo[] | undefined): Promise<string> {
		const pi: any = createFakePi();
		if (tools) pi.getAllTools = () => tools;
		doctor(pi);
		const ctx = createFakeCtx({ cwd: dir });
		await pi.commands.get("brigadev:doctor").handler("", ctx);
		return ctx.notifications.map((n) => n.message).join("\n");
	}

	it("lists a competing delegation tool and large definitions as warnings, with the context-control state", async () => {
		const text = await run([own("subagent"), foreign("subagent"), foreign("big", "z".repeat(9000))]);
		assert.match(text, /⚠ tools: .*delegation tool.*subagent/);
		assert.match(text, /⚠ tools: .*8,000/);
		assert.match(text, /context control: compact at 160k/);
	});
	it("shows a short ok line when nothing competes", async () => {
		const text = await run([own("subagent"), builtin("read"), foreign("weather")]);
		assert.match(text, /✓ tools: 1 from other packages/);
		assert.doesNotMatch(text, /⚠ tools/);
	});
	it("still works when pi has no getAllTools", async () => {
		assert.match(await run(undefined), /model:/);
	});
	it("reports invalid risk entries as warnings, and nothing for a valid config", async () => {
		const file = join(dir, "agent", "brigadev.json");
		try {
			writeFileSync(file, JSON.stringify({ risk: { paths: { security: ["lib/x.ts"] } } }));
			assert.doesNotMatch(await run(undefined), /risk/);
			writeFileSync(file, JSON.stringify({ risk: { paths: { nonsense: ["a"], data: [5] } } }));
			const text = await run(undefined);
			assert.match(text, /⚠ risk: risk\.paths\.nonsense: unknown category/);
			assert.match(text, /⚠ risk: risk\.paths\.data\[0\]/);
		} finally {
			writeFileSync(file, "{}");
		}
	});
});
