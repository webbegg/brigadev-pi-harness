// S5 regression (real binaries, skipped when missing): a chain of symlinks, a symlink nested in a subdirectory, and a
// file symlink to a secret are judged on the real location; the `.env` family keeps `.env.example` visible only.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { executeSearch, resolveOnPath, type SearchContext } from "../lib/file-search.ts";

const fd = resolveOnPath(["fd", "fdfind"]);
const rg = resolveOnPath(["rg"]);

describe("fd/rg: symlink chains, file symlinks, and the .env family (S5)", { skip: !fd || !rg ? "fd or rg not on PATH" : false }, () => {
	let dir: string;
	let project: string;
	const context = (cwd: string): SearchContext => ({ cwd, projectRoot: cwd, isChild: false, confirm: async () => false });
	const settle = (promise: Promise<{ text: string }>) => promise.catch((error: Error) => ({ text: `blocked: ${error.message}` }));

	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-search-chain-")));
		project = join(dir, "project");
		const creds = join(dir, "home", ".aws");
		const agent = join(dir, "home", ".pi", "agent");
		mkdirSync(join(project, "deep"), { recursive: true });
		mkdirSync(creds, { recursive: true });
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(creds, "credentials"), "aws_secret_access_key = TOPSECRET\n");
		writeFileSync(join(agent, "auth.json"), '{"token":"TOPSECRET"}\n');
		symlinkSync(creds, join(project, "awsdir"));
		symlinkSync("awsdir", join(project, "chain2"));
		symlinkSync("chain2", join(project, "chain1"));
		symlinkSync(agent, join(project, "agentdir"));
		symlinkSync("../agentdir", join(project, "deep", "hop"));
		for (const name of [".env", ".env.local", ".env.staging", ".env.test", ".env.production"]) writeFileSync(join(project, name), "TOKEN=TOPSECRET\n");
		writeFileSync(join(project, ".env.example"), "TOKEN=PLACEHOLDER\n");
		symlinkSync(".env", join(project, "notes.txt"));
		symlinkSync(join(creds, "credentials"), join(project, "cred.txt"));
	});

	after(() => rmSync(dir, { recursive: true, force: true }));

	for (const path of ["chain1", "deep/hop"]) {
		it(`rg and fd through ${path} do not reveal the secret`, async () => {
			const rgOut = await settle(executeSearch("rg", rg!, { pattern: "TOPSECRET", path, hidden: true }, context(project)));
			assert.doesNotMatch(rgOut.text, /TOPSECRET/);
			const fdOut = await settle(executeSearch("fd", fd!, { path, hidden: true }, context(project)));
			assert.doesNotMatch(fdOut.text, /credentials|auth\.json/);
		});
	}

	it("a whole-project rg does not read through file symlinks to a secret", async () => {
		const out = await executeSearch("rg", rg!, { pattern: "TOPSECRET", hidden: true }, context(project));
		assert.doesNotMatch(out.text, /TOPSECRET/);
	});

	for (const path of ["notes.txt", "cred.txt"]) {
		it(`an explicit file symlink to a secret (${path}) asks like read, and is blocked without a yes`, async () => {
			await assert.rejects(executeSearch("rg", rg!, { pattern: "TOPSECRET", path }, context(project)), /declined access to sensitive file/);
		});
	}

	it(".env.example is visible; .env, .env.local, .env.staging, .env.test, .env.production are not", async () => {
		const fdOut = await executeSearch("fd", fd!, { pattern: "env", hidden: true }, context(project));
		const names = fdOut.text.split("\n").filter((line) => line.startsWith(".env"));
		assert.deepEqual(names, [".env.example"]);
		const rgOut = await executeSearch("rg", rg!, { pattern: "TOKEN", hidden: true }, context(project));
		assert.match(rgOut.text, /^\.env\.example:1:TOKEN=PLACEHOLDER$/m);
		assert.doesNotMatch(rgOut.text, /TOPSECRET/);
	});
});
