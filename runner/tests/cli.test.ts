// A6: the CLI's refusal paths. No model is ever called: every case ends before a runner opens.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, it } from "node:test";
import { main } from "../src/cli.ts";
import { docText } from "./fixture.ts";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "brigadev-runner-cli-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function cli(args: string[], env: Record<string, string | undefined> = {}) {
	let stdout = "";
	let stderr = "";
	const code = await main(args, env, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) });
	return { code, stdout, stderr };
}

function writeDoc(lines: string[]): string {
	const path = join(dir, "feature.md");
	writeFileSync(path, docText(lines));
	return path;
}

const VALID = "- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending";

describe("brigadev-runner start", () => {
	it("exits 1 and prints the errors for an invalid doc (no ticket list)", async () => {
		const path = join(dir, "feature.md");
		writeFileSync(path, "# Feature\n\n## Specs\n- S1: x\n");
		const result = await cli(["start", path], { BRIGADEV_RUNNER_UNGUARDED: "1" });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /no tickets under ## Tasks/);
	});

	it("lists every error, including the runner-only `done: is not a command`", async () => {
		const path = writeDoc([VALID, "- T2 [S1] inline: x deps: none done: it looks right — pending", "- T3 [S1] inline: y deps: T9 — pending"]);
		const result = await cli(["start", path], { BRIGADEV_RUNNER_UNGUARDED: "1" });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /T2 done: is not a command/);
		assert.match(result.stderr, /T3 has no done: check/);
		assert.match(result.stderr, /T3 depends on unknown T9/);
	});

	it("validates before checking the guard flag", async () => {
		const path = writeDoc(["- T1 [S1] inline: x deps: none — pending"]);
		const result = await cli(["start", path], {});
		assert.equal(result.code, 1);
		assert.match(result.stderr, /T1 has no done: check/);
		assert.doesNotMatch(result.stderr, /UNGUARDED/);
	});

	it("refuses a valid doc unless BRIGADEV_RUNNER_UNGUARDED=1, and says why", async () => {
		const path = writeDoc([VALID]);
		for (const env of [{}, { BRIGADEV_RUNNER_UNGUARDED: "0" }, { BRIGADEV_RUNNER_UNGUARDED: "true" }]) {
			const result = await cli(["start", path], env);
			assert.equal(result.code, 1);
			assert.match(result.stderr, /BRIGADEV_RUNNER_UNGUARDED=1/);
			assert.match(result.stderr, /guard/i);
			assert.equal(result.stdout, "");
		}
	});

	it("refuses to run without ANTHROPIC_API_KEY, before opening any storage", async () => {
		const path = writeDoc([VALID]);
		const result = await cli(["start", path], { BRIGADEV_RUNNER_UNGUARDED: "1", HOME: dir });
		assert.equal(result.code, 1);
		assert.match(result.stderr, /ANTHROPIC_API_KEY/);
	});

	it("exits 1 for a missing doc and 2 for usage errors", async () => {
		assert.equal((await cli(["start", join(dir, "missing.md")])).code, 1);
		const usage = await cli(["start"]);
		assert.equal(usage.code, 2);
		assert.match(usage.stderr, /usage: brigadev-runner start <feature-doc>/);
		assert.equal((await cli(["frobnicate"])).code, 2);
	});

	it("runs as a script: `node runner/src/cli.ts start <doc>` exits 1 for an invalid doc", () => {
		const path = join(dir, "feature.md");
		writeFileSync(path, "# Feature\n");
		const script = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
		const result = spawnSync(process.execPath, [script, "start", path], { encoding: "utf8", env: { PATH: process.env.PATH ?? "" } });
		assert.equal(result.status, 1);
		assert.match(result.stderr, /no tickets under ## Tasks/);
	});
});
