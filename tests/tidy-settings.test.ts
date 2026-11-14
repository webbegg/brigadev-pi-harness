import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { commitTidyPlan, describePlan, planAlwaysShow, readTidyPlan } from "../lib/tidy-settings.ts";

const write = (raw: string | undefined, tool?: string) => {
	const plan = planAlwaysShow(raw, tool);
	assert.equal(plan.kind, "write", JSON.stringify(plan));
	return plan as Extract<typeof plan, { kind: "write" }>;
};

describe("planAlwaysShow: key choice", () => {
	it("creates tidy in an empty object, starting from pi-tidy's default", () => {
		const plan = write("{}");
		assert.equal(plan.key, "tidy");
		assert.equal(plan.before, undefined);
		assert.deepEqual(plan.after, ["edit", "write", "subagent"]);
		assert.equal(plan.nextText, `${JSON.stringify({ tidy: { alwaysShowTools: ["edit", "write", "subagent"] } }, null, 2)}\n`);
	});

	it("plans a new file with just the tidy key when the file is missing", () => {
		const plan = write(undefined);
		assert.equal(plan.key, "tidy");
		assert.deepEqual(JSON.parse(plan.nextText), { tidy: { alwaysShowTools: ["edit", "write", "subagent"] } });
		assert.ok(plan.nextText.endsWith("}\n"));
	});

	it("existing tidy without alwaysShowTools keeps its other fields", () => {
		const plan = write('{"tidy":{"enabled":true}}');
		assert.equal(plan.key, "tidy");
		assert.deepEqual(JSON.parse(plan.nextText), { tidy: { enabled: true, alwaysShowTools: ["edit", "write", "subagent"] } });
	});

	it("existing tidy with alwaysShowTools appends", () => {
		const plan = write('{"tidy":{"alwaysShowTools":["bash"]}}');
		assert.deepEqual(plan.before, ["bash"]);
		assert.deepEqual(plan.after, ["bash", "subagent"]);
	});

	it("a non-array alwaysShowTools starts from the default", () => {
		const plan = write('{"tidy":{"alwaysShowTools":"edit"}}');
		assert.equal(plan.before, undefined);
		assert.deepEqual(plan.after, ["edit", "write", "subagent"]);
	});

	it("legacy toolbox only: writes into toolbox and never adds tidy", () => {
		const plan = write('{"toolbox":{"enabled":true,"alwaysShowTools":["read"]}}');
		assert.equal(plan.key, "toolbox");
		const parsed = JSON.parse(plan.nextText);
		assert.equal("tidy" in parsed, false);
		assert.deepEqual(parsed.toolbox, { enabled: true, alwaysShowTools: ["read", "subagent"] });
	});

	it("both tidy and toolbox: tidy wins, toolbox untouched", () => {
		const raw = '{"toolbox":{"alwaysShowTools":["read"]},"tidy":{"alwaysShowTools":["bash"]}}';
		const plan = write(raw);
		assert.equal(plan.key, "tidy");
		assert.deepEqual(JSON.parse(plan.nextText), { toolbox: { alwaysShowTools: ["read"] }, tidy: { alwaysShowTools: ["bash", "subagent"] } });
	});

	it("tidy: null falls through to toolbox, like `tidy ?? toolbox`", () => {
		assert.equal(write('{"tidy":null,"toolbox":{}}').key, "toolbox");
		assert.equal(write('{"tidy":null}').key, "tidy");
	});

	it("honors a custom tool name", () => {
		assert.deepEqual(write("{}", "bash").after, ["edit", "write", "bash"]);
	});
});

describe("planAlwaysShow: noop and refuse", () => {
	it("already present is a noop", () => {
		const plan = planAlwaysShow('{"tidy":{"alwaysShowTools":["edit","subagent"]}}');
		assert.deepEqual(plan, { kind: "noop", key: "tidy", current: ["edit", "subagent"] });
	});

	it("refuses invalid JSON, empty text, non-object top level and non-object key", () => {
		for (const raw of ["{nope", "", "[]", "[1]", '"x"', "null", "3", '{"tidy":"x"}', '{"tidy":[]}', '{"toolbox":5}', '{"tidy":true}']) {
			const plan = planAlwaysShow(raw);
			assert.equal(plan.kind, "refuse", raw);
			assert.ok(plan.kind === "refuse" && plan.reason.length > 0);
		}
	});

	it("accepts a UTF-8 BOM like Pi does", () => {
		assert.equal(planAlwaysShow(`﻿{"a":1}`).kind, "write");
	});
});

describe("planAlwaysShow: preservation", () => {
	it("keeps every other key and their order", () => {
		const raw = JSON.stringify({ z: 1, theme: "dark", tidy: { alwaysShowTools: ["edit"], x: [1, { y: 2 }] }, packages: ["a"], a: null }, null, 4);
		const plan = write(raw);
		const next = JSON.parse(plan.nextText);
		assert.deepEqual(Object.keys(next), ["z", "theme", "tidy", "packages", "a"]);
		assert.deepEqual(Object.keys(next.tidy), ["alwaysShowTools", "x"]);
		assert.deepEqual(next.tidy.x, [1, { y: 2 }]);
		assert.ok(plan.nextText.includes('\n  "z": 1'), "2-space indent");
		assert.ok(plan.nextText.endsWith("\n") && !plan.nextText.endsWith("\n\n"));
	});

	it("appends the new tidy key last when created", () => {
		assert.deepEqual(Object.keys(JSON.parse(write('{"b":1,"a":2}').nextText)), ["b", "a", "tidy"]);
	});
});

describe("describePlan", () => {
	it("shows path, key and before → after", () => {
		const text = describePlan(write('{"tidy":{"alwaysShowTools":["bash"]}}'), "/x/settings.json");
		assert.match(text, /\/x\/settings\.json/);
		assert.match(text, /tidy\.alwaysShowTools/);
		assert.match(text, /\["bash"\] → \["bash", "subagent"\]/);
	});

	it("says (not set) when there was no list, and describes noop and refuse", () => {
		assert.match(describePlan(write("{}"), "/p"), /\(not set\) → \["edit", "write", "subagent"\]/);
		assert.match(describePlan(planAlwaysShow('{"tidy":{"alwaysShowTools":["subagent"]}}'), "/p"), /no change/i);
		assert.match(describePlan(planAlwaysShow("{nope"), "/p"), /not changing|refus/i);
	});
});

describe("write helper", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-tidy-"));
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("missing file: reads as undefined and creates it atomically (no temp files left)", () => {
		const path = join(dir, "new", "settings.json");
		const shown = readTidyPlan(path);
		assert.equal(shown.raw, undefined);
		assert.equal(shown.plan.kind, "write");
		assert.deepEqual(commitTidyPlan(path, shown), { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { tidy: { alwaysShowTools: ["edit", "write", "subagent"] } });
		assert.deepEqual(readdirSync(join(dir, "new")), ["settings.json"]);
	});

	it("rewrites an existing file preserving other keys and file mode", () => {
		const path = join(dir, "mode.json");
		writeFileSync(path, '{"theme":"dark"}\n');
		chmodSync(path, 0o600);
		const shown = readTidyPlan(path);
		assert.deepEqual(commitTidyPlan(path, shown), { ok: true });
		assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { theme: "dark", tidy: { alwaysShowTools: ["edit", "write", "subagent"] } });
		assert.equal(statSync(path).mode & 0o777, 0o600);
		assert.ok(!readdirSync(dir).some((f) => f.endsWith(".tmp")));
	});

	it("refuses when the file changed between plan and write, leaving it untouched", () => {
		const path = join(dir, "race.json");
		writeFileSync(path, '{"a":1}');
		const shown = readTidyPlan(path);
		writeFileSync(path, '{"a":2}');
		const result = commitTidyPlan(path, shown);
		assert.equal(result.ok, false);
		assert.match((result as { reason: string }).reason, /changed/i);
		assert.equal(readFileSync(path, "utf8"), '{"a":2}');
	});

	it("refuses when the file appears after a missing-file plan", () => {
		const path = join(dir, "appears.json");
		const shown = readTidyPlan(path);
		writeFileSync(path, "{}");
		assert.equal(commitTidyPlan(path, shown).ok, false);
		assert.equal(readFileSync(path, "utf8"), "{}");
	});

	it("never writes for a refuse or noop plan", () => {
		const bad = join(dir, "bad.json");
		writeFileSync(bad, "{nope");
		assert.equal(commitTidyPlan(bad, readTidyPlan(bad)).ok, false);
		assert.equal(readFileSync(bad, "utf8"), "{nope");
		const same = join(dir, "same.json");
		writeFileSync(same, '{"tidy":{"alwaysShowTools":["subagent"]}}');
		assert.equal(commitTidyPlan(same, readTidyPlan(same)).ok, false);
		assert.equal(readFileSync(same, "utf8"), '{"tidy":{"alwaysShowTools":["subagent"]}}');
	});

	it("an unreadable path (a directory) plans a refuse", () => {
		assert.equal(readTidyPlan(dir).plan.kind, "refuse");
	});

	it("writes through a symlink instead of replacing it", () => {
		const real = join(dir, "real.json");
		const link = join(dir, "link.json");
		writeFileSync(real, "{}");
		symlinkSync(real, link);
		assert.deepEqual(commitTidyPlan(link, readTidyPlan(link)), { ok: true });
		assert.equal(JSON.parse(readFileSync(real, "utf8")).tidy.alwaysShowTools.at(-1), "subagent");
		assert.ok(readFileSync(link, "utf8").includes("subagent"));
	});
});
