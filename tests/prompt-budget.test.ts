// Everything here is sent to the model on every orchestrator turn. The
// budgets are ceilings with a little headroom over the measured size; raise
// one deliberately, with the reason in the commit, never to make a test pass.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, it } from "node:test";
import { MODE_PROMPT } from "../lib/permission-policy.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const root = join(import.meta.dirname, "..");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const ORCHESTRATOR_MAX_BYTES = 2_600;
const SKILL_DESCRIPTION_MAX_CHARS = 120;
const MODEL_VISIBLE_SKILLS_MAX = 6;
const MODE_LINE_MAX_BYTES = 220;
// Measured 4,478 chars (subagent, todo, ask_user_choice, bg_start, bg_status, bg_list, bg_kill) without the removed fd/rg tools.
const TOOL_DEFINITIONS_MAX_CHARS = 5_300;

/** Every tool the package's extensions register, sized the way the model sees it: name, description, parameters, snippet, guidelines. */
async function toolDefinitionSizes(): Promise<Map<string, number>> {
	const uninstallStubs = installPiStubs();
	// The shared stubs lack two values the other extensions import (`StringEnum` for todo, `Editor` and `wrapTextWithAnsi` for ask-user): add them on top.
	const onTop = (stub: string, source: string) =>
		`data:text/javascript,${encodeURIComponent(`export * from ${JSON.stringify(pathToFileURL(join(root, "tests", "helpers", "pi-stubs", stub)).href)}; ${source}`)}`;
	const extras = new Map([
		["@earendil-works/pi-ai", onTop("pi-ai.ts", 'export const StringEnum = (values, options) => ({ type: "string", enum: [...values], ...options });')],
		["@earendil-works/pi-tui", onTop("pi-tui.ts", "export class Editor {} export const wrapTextWithAnsi = (text) => [text];")],
	]);
	const extra = registerHooks({ resolve: (specifier, context, next) => (extras.has(specifier) ? { url: extras.get(specifier)!, shortCircuit: true } : next(specifier, context)) });
	// Measure the parent session's tools: a child process (BRIGADEV_CHILD=1) registers fewer, so load as the parent would.
	const saved = Object.entries(process.env).filter(([key]) => key.startsWith("BRIGADEV_"));
	for (const [key] of saved) delete process.env[key];
	const uninstall = () => {
		for (const [key, value] of saved) process.env[key] = value;
		extra.deregister();
		uninstallStubs();
	};
	try {
		const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { pi: { extensions: string[] } };
		const pi = createFakePi();
		// The fake records what these tests need; any other Pi call an extension makes while loading is a no-op.
		const api = new Proxy(pi, { get: (target, key) => (key in target ? Reflect.get(target, key) : () => undefined) });
		for (const file of manifest.pi.extensions) (await import(join(root, file))).default(api);
		const sizes = new Map<string, number>();
		for (const tool of pi.tools.values()) {
			const { name, description, parameters, promptSnippet, promptGuidelines } = tool as Record<string, unknown>;
			sizes.set(String(name), JSON.stringify({ name, description, parameters, promptSnippet, promptGuidelines }).length);
		}
		return sizes;
	} finally {
		uninstall();
	}
}

function skills() {
	return readdirSync(join(root, "skills"), { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => {
			const text = readFileSync(join(root, "skills", e.name, "SKILL.md"), "utf8");
			const description = /^description:\s*"(.*)"\s*$/m.exec(text)?.[1] ?? "";
			return { name: e.name, description, hidden: /^disable-model-invocation:\s*true\s*$/m.test(text) };
		});
}

describe("prompt budget", () => {
	it(`keeps the orchestrator prompt under ${ORCHESTRATOR_MAX_BYTES} bytes`, () => {
		const size = bytes(readFileSync(join(root, "assets", "orchestrator.md"), "utf8"));
		assert.ok(size <= ORCHESTRATOR_MAX_BYTES, `orchestrator.md is ${size} bytes`);
	});

	it(`keeps model-visible skill descriptions under ${SKILL_DESCRIPTION_MAX_CHARS} chars`, () => {
		for (const s of skills().filter((x) => !x.hidden)) {
			assert.ok(s.description.length > 0, `${s.name} has no description`);
			assert.ok(s.description.length <= SKILL_DESCRIPTION_MAX_CHARS, `${s.name}: ${s.description.length} chars`);
		}
	});

	it(`lists at most ${MODEL_VISIBLE_SKILLS_MAX} skills to the model`, () => {
		assert.ok(skills().filter((s) => !s.hidden).length <= MODEL_VISIBLE_SKILLS_MAX);
	});

	it("asks for no narration between tool calls and a fixed closing shape", () => {
		const prompt = readFileSync(join(root, "assets", "orchestrator.md"), "utf8");
		assert.match(prompt, /no narration between tool calls/);
		assert.match(prompt, /`Done:`.*`Tests:`.*`Risk:`.*`Next:`/);
	});

	it(`keeps the brigadev tool definitions under ${TOOL_DEFINITIONS_MAX_CHARS} chars in total`, async () => {
		const sizes = await toolDefinitionSizes();
		const total = [...sizes.values()].reduce((sum, n) => sum + n, 0);
		assert.ok(sizes.size > 0, "no tools were registered");
		assert.ok(total <= TOOL_DEFINITIONS_MAX_CHARS, `tool definitions are ${total} chars: ${[...sizes].map(([k, v]) => `${k}=${v}`).join(", ")}`);
	});

	it(`keeps each permission-mode line under ${MODE_LINE_MAX_BYTES} bytes`, () => {
		for (const [mode, line] of Object.entries(MODE_PROMPT)) assert.ok(bytes(line) <= MODE_LINE_MAX_BYTES, `${mode}: ${bytes(line)} bytes`);
	});
});
