import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// S9 "no UI → print the manual instruction instead of writing": in print/json mode
// the text must reach stderr and leave stdout (json event stream) untouched.
const noOpUi = { notify: () => {}, confirm: async () => false };

async function loadHandler() {
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
	const mod = await import(`../extensions/tidy.ts?${Math.random()}`);
	mod.default({ registerCommand: (name: string, command: never) => (commands[name] = command) } as never);
	return commands["brigadev:tidy"].handler;
}

async function capture(run: () => Promise<unknown>) {
	const out = process.stdout.write, err = process.stderr.write;
	let stdout = "", stderr = "";
	process.stdout.write = ((c: unknown) => ((stdout += String(c)), true)) as never;
	process.stderr.write = ((c: unknown) => ((stderr += String(c)), true)) as never;
	try {
		await run();
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
	}
	return { stdout, stderr };
}

describe("/brigadev:tidy without UI writes to stderr only", () => {
	let dir: string;
	let saved: { agent?: string; child?: string };
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "tidy-streams-"));
		saved = { agent: process.env.PI_CODING_AGENT_DIR, child: process.env.BRIGADEV_CHILD };
		process.env.PI_CODING_AGENT_DIR = dir;
		delete process.env.BRIGADEV_CHILD;
	});
	after(() => {
		if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = saved.agent;
		if (saved.child !== undefined) process.env.BRIGADEV_CHILD = saved.child;
		rmSync(dir, { recursive: true, force: true });
	});

	const cases: Array<[string, string, RegExp]> = [
		["change", '{"a":1}', /tidy\.alwaysShowTools to \["edit","write","subagent"\]/],
		["refuse", '{"a":1,', /not valid JSON/],
		["noop", '{"tidy":{"alwaysShowTools":["edit","subagent"]}}', /No change: subagent is already in tidy\.alwaysShowTools/],
		["legacy toolbox", '{"toolbox":{"enabled":true}}', /toolbox\.alwaysShowTools to \["edit","write","subagent"\]/],
	];
	for (const [name, original, expected] of cases) {
		it(`${name}: message on stderr, nothing on stdout, file byte-identical, no temp files`, async () => {
			const path = join(dir, "settings.json");
			writeFileSync(path, original);
			const handler = await loadHandler();
			const { stdout, stderr } = await capture(() => handler("", { hasUI: false, mode: "print", ui: noOpUi }));
			assert.equal(stdout, "");
			assert.match(stderr, expected);
			assert.equal(readFileSync(path, "utf8"), original);
			assert.deepEqual(readdirSync(dir), ["settings.json"]);
		});
	}

	it("missing settings file: prints the instruction and creates nothing", async () => {
		rmSync(join(dir, "settings.json"), { force: true });
		const handler = await loadHandler();
		const { stdout, stderr } = await capture(() => handler("", { hasUI: false, mode: "print", ui: noOpUi }));
		assert.equal(stdout, "");
		assert.match(stderr, /Not written \(no UI to confirm\)/);
		assert.deepEqual(readdirSync(dir), []);
	});
});
