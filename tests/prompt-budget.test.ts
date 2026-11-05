// Everything here is sent to the model on every orchestrator turn. The
// budgets are ceilings with a little headroom over the measured size; raise
// one deliberately, with the reason in the commit, never to make a test pass.

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { MODE_PROMPT } from "../lib/permission-policy.ts";

const root = join(import.meta.dirname, "..");
const bytes = (s: string) => Buffer.byteLength(s, "utf8");

const ORCHESTRATOR_MAX_BYTES = 4_900;
const SKILL_DESCRIPTION_MAX_CHARS = 120;
const MODEL_VISIBLE_SKILLS_MAX = 6;
const MODE_LINE_MAX_BYTES = 220;

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

	it(`lists at most ${MODEL_VISIBLE_SKILLS_MAX} skills to the model; explicit-only skills stay hidden`, () => {
		const all = skills();
		assert.ok(all.filter((s) => !s.hidden).length <= MODEL_VISIBLE_SKILLS_MAX);
		for (const name of ["brigadev-judgment-day", "brigadev-skill-creator"]) {
			assert.equal(all.find((s) => s.name === name)?.hidden, true, `${name} should be explicit-only`);
		}
	});

	it(`keeps each permission-mode line under ${MODE_LINE_MAX_BYTES} bytes`, () => {
		for (const [mode, line] of Object.entries(MODE_PROMPT)) assert.ok(bytes(line) <= MODE_LINE_MAX_BYTES, `${mode}: ${bytes(line)} bytes`);
	});
});
