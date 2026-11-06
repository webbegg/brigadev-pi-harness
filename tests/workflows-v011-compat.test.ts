import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type FrontmatterParser } from "../lib/agents.ts";
import { ASSETS_ROOT } from "../lib/runtime.ts";
import { discoverWorkflows, RESERVED_KEYS, resolveWorkflow } from "../lib/workflows.ts";

/** Reads `name: "value"` lines only; an empty value is null, as in real YAML. */
const parse: FrontmatterParser = (content) => {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	const frontmatter: Record<string, unknown> = {};
	for (const line of match![1].split("\n")) {
		const top = /^(\w+):(.*)$/.exec(line);
		if (top) frontmatter[top[1]] = top[2].trim() === "" ? null : JSON.parse(top[2]);
	}
	return { frontmatter, body: match![2].trim() };
};

const NEWLY_RESERVED = ["c", "e", "h", "o", "s", "t", "y"];
const SHIPPED_KEYS = ["n", "b", "r", "p", "f", "i", "u", "x", "d"];

describe("v0.11.0 workflow files under the new reserved letters", () => {
	let scratch: string;
	const userDir = () => join(scratch, "user");
	before(() => {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-v011-compat-"));
		mkdirSync(userDir());
		for (const letter of "abcdefghijklmnopqrstuvwxyz") {
			writeFileSync(join(userDir(), `mine-${letter}.md`), `---\nname: "Mine ${letter}"\ndescription: "d"\nkey: "${letter}"\n---\nDo ${letter}.\n`);
		}
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	it("reserves exactly g a m k q plus c e h o s t y", () => {
		assert.deepEqual([...RESERVED_KEYS].sort(), ["a", "c", "e", "g", "h", "k", "m", "o", "q", "s", "t", "y"]);
	});

	it("warns about a user file only for a reserved letter, and loads every file", () => {
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), userDir: userDir(), parse });
		assert.equal(workflows.filter((w) => w.source === "user").length, 26);
		const warned = warnings.flatMap((w) => /mine-([a-z])\.md:/.exec(w)?.[1] ?? []).sort();
		assert.deepEqual(warned, [...RESERVED_KEYS].sort());
		// Shipped keys: the user layer is higher, so the user file keeps the key and the package workflow loses it.
		for (const letter of SHIPPED_KEYS) assert.equal(resolveWorkflow(workflows, letter).name, `Mine ${letter}`);
	});

	it("a newly reserved key still starts by name and file id, not by the letter", () => {
		const { workflows, warnings } = discoverWorkflows({ packageDir: join(ASSETS_ROOT, "workflows"), userDir: userDir(), parse });
		for (const letter of NEWLY_RESERVED) {
			assert.ok(warnings.some((w) => w.endsWith(`mine-${letter}.md: key "${letter}" is reserved for the dashboard tools; "Mine ${letter}" has no key`)), letter);
			assert.equal(resolveWorkflow(workflows, `Mine ${letter}`).name, `Mine ${letter}`);
			assert.equal(resolveWorkflow(workflows, `mine-${letter}`).name, `Mine ${letter}`);
			assert.throws(() => resolveWorkflow(workflows, letter), new RegExp(`Unknown workflow "${letter}"`));
		}
	});
});
