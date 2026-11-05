import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { effectiveProfile, PROFILE_ENTRY, readProfiles, sessionBinding, writePiDefaultModel, writeProfiles } from "../lib/profiles-store.ts";

const bind = (name: string | null) => ({ type: "custom", customType: PROFILE_ENTRY, data: { name } });
const file = { version: 1 as const, active: "balanced", profiles: { balanced: { "brigadev-explore": { model: "a/cheap" } }, deep: {} } };

describe("session binding", () => {
	it("takes the latest binding on the branch; null clears", () => {
		assert.equal(sessionBinding([]), undefined);
		assert.equal(sessionBinding([bind("deep"), { type: "message" }]), "deep");
		assert.equal(sessionBinding([bind("deep"), bind(null)]), null);
	});

	it("resolves session > default > none and reports a deleted bound profile", () => {
		assert.equal(effectiveProfile(file, [bind("deep")]).source, "session");
		assert.equal(effectiveProfile(file, []).name, "balanced");
		assert.equal(effectiveProfile(file, [bind(null)]).name, "balanced");
		assert.equal(effectiveProfile({ version: 1, profiles: {} }, []).source, "none");
		const missing = effectiveProfile(file, [bind("gone")]);
		assert.deepEqual([missing.missing, missing.name, missing.source], ["gone", "balanced", "default"]);
	});
});

describe("files", () => {
	let dir: string;
	const previous = process.env.PI_CODING_AGENT_DIR;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-test-"));
		process.env.PI_CODING_AGENT_DIR = dir;
	});
	after(() => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips the profiles file", () => {
		assert.equal(readProfiles().exists, false);
		writeProfiles(file);
		const { file: read, problems, exists } = readProfiles();
		assert.deepEqual([read, problems, exists], [file, [], true]);
	});

	it("reports an unreadable profiles file instead of throwing", () => {
		writeFileSync(join(dir, "brigadev-profiles.json"), "{oops");
		assert.match(readProfiles().problems[0], /cannot read/);
	});

	it("writes Pi's default model while preserving other settings", () => {
		writeFileSync(join(dir, "settings.json"), JSON.stringify({ packages: ["npm:x"], defaultModel: "old" }));
		writePiDefaultModel("claude-bridge", "claude-opus-5-5", "high");
		assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")), {
			packages: ["npm:x"],
			defaultModel: "claude-opus-5-5",
			defaultProvider: "claude-bridge",
			defaultThinkingLevel: "high",
		});
	});

	it("refuses to overwrite settings it cannot parse", () => {
		writeFileSync(join(dir, "settings.json"), "[1,2]");
		assert.throws(() => writePiDefaultModel("p", "m"), /not a JSON object/);
		assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), "[1,2]");
	});
});
