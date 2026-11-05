import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clampSelection, commandLine, filterEntries, moveSelection, normalizeEntries, PALETTE_COMMAND } from "../lib/command-palette.ts";

const entries = [
	{ name: "brigadev:changes", description: "Browse uncommitted changes (working tree vs HEAD)" },
	{ name: "brigadev:cost", description: "Show session cost" },
	{ name: "brigadev:runs", description: "Agents viewer: every subagent run" },
	{ name: "brigadev:usage", description: "Provider usage windows" },
];

describe("normalizeEntries", () => {
	it("keeps only brigadev commands, sorted, with descriptions", () => {
		const out = normalizeEntries([
			{ name: "brigadev:usage", description: "Usage" },
			{ name: "model", description: "Switch model" },
			{ name: "brigadev:cost" },
			{ name: "/brigadev:doctor", description: "Doctor" },
		]);
		assert.deepEqual(out, [
			{ name: "brigadev:cost", description: "" },
			{ name: "brigadev:doctor", description: "Doctor" },
			{ name: "brigadev:usage", description: "Usage" },
		]);
	});

	it("excludes the palette itself, duplicates, and malformed items", () => {
		const out = normalizeEntries([{ name: PALETTE_COMMAND, description: "x" }, { name: "brigadev:cost", description: "a" }, { name: "brigadev:cost", description: "b" }, null, 3, { description: "no name" }]);
		assert.deepEqual(out, [{ name: "brigadev:cost", description: "a" }]);
	});
});

describe("normalizeEntries with prompt templates", () => {
	const own = (path: string) => path.startsWith("/pkg/prompts/");
	const prompt = (name: string, path: string, description = "d") => ({ name, description, source: "prompt", sourceInfo: { path } });

	it("includes the package's own prompt templates next to brigadev commands", () => {
		const out = normalizeEntries(
			[
				{ name: "brigadev:cost", description: "Cost", source: "extension" },
				prompt("review", "/pkg/prompts/review.md", "4R review"),
				prompt("track", "/pkg/prompts/track.md", "Track work"),
			],
			own,
		);
		assert.deepEqual(out.map((e) => e.name), ["brigadev:cost", "review", "track"]);
		assert.equal(out[1].description, "4R review");
	});

	it("ignores prompt templates from elsewhere and non-prompt sources", () => {
		const out = normalizeEntries(
			[
				prompt("deploy", "/home/u/.pi/prompts/deploy.md"),
				{ name: "review", description: "x", source: "extension", sourceInfo: { path: "/pkg/prompts/review.md" } },
				{ name: "track", description: "x", source: "prompt" },
			],
			own,
		);
		assert.deepEqual(out, []);
	});

	it("lists no prompt templates without an ownership check", () => {
		assert.deepEqual(normalizeEntries([prompt("review", "/pkg/prompts/review.md")]), []);
	});

	it("runs a prompt template as a slash command", () => {
		assert.equal(commandLine({ name: "review", description: "" }), "/review");
	});

	it("filters prompt templates by name and description", () => {
		const list = [
			{ name: "brigadev:cost", description: "Show session cost" },
			{ name: "review", description: "brigadev 4R review of a frozen candidate" },
			{ name: "track", description: "Track this work as a large ODD task" },
		];
		assert.deepEqual(filterEntries(list, "rev").map((e) => e.name), ["review"]);
		assert.deepEqual(filterEntries(list, "odd").map((e) => e.name), ["track"]);
		assert.deepEqual(filterEntries(list, "cost").map((e) => e.name), ["brigadev:cost"]);
	});
});

describe("filterEntries", () => {
	it("returns everything for an empty query", () => {
		assert.deepEqual(filterEntries(entries, "  "), entries);
	});

	it("matches name and description, case-insensitively", () => {
		assert.deepEqual(filterEntries(entries, "SUBAGENT").map((e) => e.name), ["brigadev:runs"]);
		assert.deepEqual(filterEntries(entries, "cost").map((e) => e.name), ["brigadev:cost"]);
	});

	it("ranks name matches before description-only matches", () => {
		const list = [
			{ name: "brigadev:alpha", description: "mentions usage here" },
			{ name: "brigadev:usage", description: "Provider windows" },
		];
		assert.deepEqual(filterEntries(list, "usage").map((e) => e.name), ["brigadev:usage", "brigadev:alpha"]);
	});

	it("requires every token to match", () => {
		assert.deepEqual(filterEntries(entries, "changes head").map((e) => e.name), ["brigadev:changes"]);
		assert.deepEqual(filterEntries(entries, "changes zzz"), []);
	});
});

describe("selection", () => {
	it("clamps into range and to 0 when empty", () => {
		assert.equal(clampSelection(5, 3), 2);
		assert.equal(clampSelection(-1, 3), 0);
		assert.equal(clampSelection(2, 0), 0);
	});

	it("moves within bounds without wrapping", () => {
		assert.equal(moveSelection(0, -1, 3), 0);
		assert.equal(moveSelection(1, 1, 3), 2);
		assert.equal(moveSelection(2, 1, 3), 2);
	});
});

describe("commandLine", () => {
	it("builds the slash command Enter runs", () => {
		assert.equal(commandLine(entries[1]), "/brigadev:cost");
	});
});
