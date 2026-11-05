import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AgentDefinition } from "../lib/agents.ts";
import { admitLaunch, buildChildTask, writerConflicts } from "../lib/delegation.ts";
import { isWithinSurfaces, surfacesOverlap, validateSurfaces } from "../lib/edit-surfaces.ts";

const agent = (overrides: Partial<AgentDefinition>): AgentDefinition => ({
	name: "x",
	description: "x",
	writer: false,
	systemPrompt: "",
	source: "package",
	filePath: "/x.md",
	...overrides,
});
const explore = agent({ name: "brigadev-explore" });
const worker = agent({ name: "brigadev-worker", writer: true });
const verify = agent({ name: "brigadev-verify", admission: "risk" });
const all = [explore, worker, verify];

describe("edit surfaces", () => {
	it("rejects broad or escaping surfaces", () => {
		assert.equal(validateSurfaces(undefined).length, 1);
		assert.equal(validateSurfaces(["."]).length, 1);
		assert.equal(validateSurfaces(["/etc/hosts"]).length, 1);
		assert.equal(validateSurfaces(["../other"]).length, 1);
		assert.deepEqual(validateSurfaces(["src/auth/**", "tests/auth.test.ts"]), []);
	});

	it("matches files, directories, and globs", () => {
		assert.equal(isWithinSurfaces("src/auth/login.ts", ["src/auth"]), true);
		assert.equal(isWithinSurfaces("src/authz.ts", ["src/auth"]), false);
		assert.equal(isWithinSurfaces("src/auth/deep/x.ts", ["src/auth/**"]), true);
		assert.equal(isWithinSurfaces("src/a.ts", ["src/*.ts"]), true);
		assert.equal(isWithinSurfaces("src/sub/a.ts", ["src/*.ts"]), false);
		assert.equal(isWithinSurfaces("./tests/a.test.ts", ["tests/a.test.ts"]), true);
	});

	it("detects overlap conservatively", () => {
		assert.equal(surfacesOverlap(["src/a.ts"], ["src/b.ts"]), undefined);
		assert.equal(surfacesOverlap(["src/auth/**"], ["src/billing/**"]), undefined);
		assert.ok(surfacesOverlap(["src/**"], ["src/a.ts"]));
		assert.ok(surfacesOverlap(["src/auth"], ["src/auth/login.ts"]));
	});
});

describe("admitLaunch", () => {
	it("requires a reason for every launch", () => {
		assert.ok(admitLaunch({ agent: "brigadev-explore", task: "map auth", reason: "" }, explore, all).length > 0);
		assert.deepEqual(admitLaunch({ agent: "brigadev-explore", task: "map auth", reason: "evidence budget exceeded" }, explore, all), []);
	});

	it("admits the verifier only for a named risk item", () => {
		assert.ok(admitLaunch({ agent: "brigadev-verify", task: "t", reason: "double-check" }, verify, all).length > 0);
		assert.deepEqual(admitLaunch({ agent: "brigadev-verify", task: "t", reason: "Risk: item 2 (auth guard)" }, verify, all), []);
	});

	it("requires valid surfaces for writers and forbids them for readers", () => {
		assert.ok(admitLaunch({ agent: "brigadev-worker", task: "t", reason: "independent units" }, worker, all).length > 0);
		assert.deepEqual(admitLaunch({ agent: "brigadev-worker", task: "t", reason: "independent units", allowedEditSurfaces: ["src/a"] }, worker, all), []);
		assert.ok(admitLaunch({ agent: "brigadev-explore", task: "t", reason: "r", allowedEditSurfaces: ["src"] }, explore, all).length > 0);
	});

	it("reports unknown agents with the available list", () => {
		assert.match(admitLaunch({ agent: "nope", task: "t", reason: "r" }, undefined, all)[0], /brigadev-explore/);
	});
});

describe("writerConflicts", () => {
	it("rejects overlapping parallel writers and running writers", () => {
		assert.equal(writerConflicts([{ agent: worker, surfaces: ["src/a"] }, { agent: worker, surfaces: ["src/b"] }], []).length, 0);
		assert.equal(writerConflicts([{ agent: worker, surfaces: ["src/**"] }, { agent: worker, surfaces: ["src/b"] }], []).length, 1);
		assert.equal(writerConflicts([{ agent: worker, surfaces: ["src/a"] }], [{ id: "w1", agent: "brigadev-worker", surfaces: ["src/a/x.ts"] }]).length, 1);
		assert.equal(writerConflicts([{ agent: explore, surfaces: [] }, { agent: explore, surfaces: [] }], []).length, 0);
	});
});

describe("buildChildTask", () => {
	it("passes the spec by reference, resolved skills, and surfaces", () => {
		const { text, missingSkills } = buildChildTask(
			{ agent: "brigadev-worker", task: "Do T2; S1, S3.", reason: "independent units", featureDoc: "odd/tasks/auth.md", skills: ["brigadev-work-unit-commits", "missing"], allowedEditSurfaces: ["src/auth/**"] },
			worker,
			[{ name: "brigadev-work-unit-commits", filePath: "/pkg/skills/brigadev-work-unit-commits/SKILL.md" }],
		);
		assert.match(text, /Read `odd\/tasks\/auth\.md` from the top until `## Log`/);
		assert.match(text, /- brigadev-work-unit-commits: \/pkg\/skills/);
		assert.match(text, /## Allowed edit surfaces\n- src\/auth\/\*\*/);
		assert.deepEqual(missingSkills, ["missing"]);
	});
});
