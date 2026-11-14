import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

// Pi 1.5.0 gives commands a no-op UI when ctx.hasUI is false (print/json mode):
// notify() and confirm() do nothing (runner.js noOpUIContext). S9: "no UI → print
// the manual instruction instead of writing".
const noOpUi = { notify: () => {}, confirm: async () => false };

async function loadHandler() {
	const commands: Record<string, { handler: (args: string, ctx: unknown) => Promise<unknown> }> = {};
	const mod = await import(`../extensions/tidy.ts?${Math.random()}`);
	mod.default({ registerCommand: (name: string, command: never) => (commands[name] = command) } as never);
	return commands["brigadev:tidy"].handler;
}

async function captureOutput(run: () => Promise<unknown>): Promise<string> {
	const out = process.stdout.write, err = process.stderr.write;
	const origLog = console.log, origError = console.error;
	let text = "";
	const sink = (chunk: unknown) => ((text += String(chunk)), true);
	process.stdout.write = sink as never;
	process.stderr.write = sink as never;
	console.log = (...a: unknown[]) => void (text += a.join(" ") + "\n");
	console.error = console.log;
	try {
		await run();
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
		console.log = origLog;
		console.error = origError;
	}
	return text;
}

describe("/brigadev:tidy without UI", () => {
	let dir: string;
	let saved: { agent?: string; child?: string };
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "tidy-cmd-"));
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

	it("prints the manual instruction (not only a no-op notify) and does not write", async () => {
		const path = join(dir, "settings.json");
		const original = '{"theme":"dark","tidy":{"enabled":true}}';
		writeFileSync(path, original);
		const handler = await loadHandler();
		const printed = await captureOutput(() => handler("", { hasUI: false, mode: "print", ui: noOpUi }));
		assert.match(printed, /tidy\.alwaysShowTools/);
		assert.match(printed, /\["edit","write","subagent"\]|\["edit", "write", "subagent"\]/);
		assert.equal(readFileSync(path, "utf8"), original);
		assert.deepEqual(readdirSync(dir), ["settings.json"]);
	});

	it("prints the refusal for an invalid file without UI and does not write", async () => {
		const path = join(dir, "settings.json");
		writeFileSync(path, '{"theme":');
		const handler = await loadHandler();
		const printed = await captureOutput(() => handler("", { hasUI: false, mode: "print", ui: noOpUi }));
		assert.match(printed, /not valid JSON/);
		assert.equal(readFileSync(path, "utf8"), '{"theme":');
	});
});
