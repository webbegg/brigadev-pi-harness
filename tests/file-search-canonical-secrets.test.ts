// S5 regression (real binaries, skipped when missing): a sensitive file reached through a symlinked directory or from a
// working directory inside a credentials folder is still excluded, as `read` (which decides on the canonical path) asks.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { executeSearch, resolveOnPath, type SearchContext } from "../lib/file-search.ts";

const fd = resolveOnPath(["fd", "fdfind"]);
const rg = resolveOnPath(["rg"]);

describe("fd/rg never show a sensitive file through its canonical path (S5)", { skip: !fd || !rg ? "fd or rg not on PATH" : false }, () => {
	let dir: string;
	let project: string;
	let creds: string;
	let agent: string;
	const context = (cwd: string): SearchContext => ({ cwd, projectRoot: cwd, isChild: false, confirm: async () => false });

	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-search-canonical-")));
		project = join(dir, "project");
		creds = join(dir, "home", ".aws");
		agent = join(dir, "home", ".pi", "agent");
		mkdirSync(project, { recursive: true });
		mkdirSync(creds, { recursive: true });
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(creds, "credentials"), "aws_secret_access_key = TOPSECRET\n");
		writeFileSync(join(agent, "auth.json"), '{"token":"TOPSECRET"}\n');
		writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
		symlinkSync(creds, join(project, "awsdir"));
		symlinkSync(agent, join(project, "agentdir"));
	});

	after(() => rmSync(dir, { recursive: true, force: true }));

	for (const link of ["awsdir", "agentdir"]) {
		it(`rg through a symlinked directory (${link}) does not return the secret's contents`, async () => {
			const out = await executeSearch("rg", rg!, { pattern: "TOPSECRET", path: link }, context(project)).catch((error: Error) => ({ text: `blocked: ${error.message}` }));
			assert.doesNotMatch(out.text, /TOPSECRET/);
		});

		it(`fd through a symlinked directory (${link}) does not list the secret file`, async () => {
			const out = await executeSearch("fd", fd!, { path: link, hidden: true }, context(project)).catch((error: Error) => ({ text: `blocked: ${error.message}` }));
			assert.doesNotMatch(out.text, /credentials|auth\.json/);
		});
	}

	for (const [label, cwd] of [["~/.aws", () => creds], ["~/.pi/agent", () => agent]] as const) {
		it(`a session whose cwd is ${label} does not get the secret from rg or fd`, async () => {
			const rgOut = await executeSearch("rg", rg!, { pattern: "TOPSECRET", hidden: true }, context(cwd()));
			assert.doesNotMatch(rgOut.text, /TOPSECRET/);
			const fdOut = await executeSearch("fd", fd!, { hidden: true }, context(cwd()));
			assert.doesNotMatch(fdOut.text, /credentials|auth\.json/);
		});
	}
});
