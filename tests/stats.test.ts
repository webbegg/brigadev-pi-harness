import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { after, before, describe, it } from "node:test";
import statsExtension from "../extensions/stats.ts";
import { classifyBash, classifyTurn, computeStats, parseJsonl, percentile, readEvidenceDir, renderStats, sessionFiles, type SessionLog } from "../lib/stats.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const FIXTURES = join(import.meta.dirname, "fixtures", "stats");
const readLog = (name: string): SessionLog => ({ id: name, entries: parseJsonl(readFileSync(join(FIXTURES, "sessions", `${name}.jsonl`), "utf8")) });
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} !== ${expected}`);
const evidence = () => readEvidenceDir(join(FIXTURES));

describe("parseJsonl", () => {
	it("skips blank, torn, and non-object lines", () => {
		assert.deepEqual(parseJsonl('{"a":1}\n\nnot json\n42\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
	});
});

describe("percentile", () => {
	it("uses the nearest rank", () => {
		assert.equal(percentile([5, 1, 3, 2, 4, 10, 9, 8, 7, 6], 50), 5);
		assert.equal(percentile([5, 1, 3, 2, 4, 10, 9, 8, 7, 6], 90), 9);
		assert.equal(percentile([], 50), undefined);
	});
});

describe("phase classification", () => {
	const bash = (command: string) => classifyBash(command);

	it("classifies read-like bash as explore", () => {
		for (const command of ["cat a.ts", "sed -n 1,5p a.ts", "head -5 a", "tail -f x", "rg foo src", "grep -rn x .", "find . -name x", "ls -la", "git status", "git diff --stat | head -20", "git -C ../x log -3", "git show HEAD", "cd lib && cat a | wc -l"]) {
			assert.equal(bash(command), "explore", command);
		}
	});

	it("classifies test and build commands as verify", () => {
		for (const command of ["npm test", "node --test tests/*.test.ts", "npm run build", "pnpm run lint", "npx tsc --noEmit", "pytest -q", "cargo test", "go test ./..."]) {
			assert.equal(bash(command), "verify", command);
		}
	});

	it("classifies commit, push, gh, and release as deliver", () => {
		for (const command of ["git commit -m x", "git push -u origin x", "gh pr create", "./release.sh", "git -C d commit -am x"]) assert.equal(bash(command), "deliver", command);
	});

	it("classifies sleep as poll and anything else as other", () => {
		assert.equal(bash("sleep 30"), "poll");
		assert.equal(bash("gh run watch && sleep 5"), "poll");
		assert.equal(bash("mkdir out"), "other");
		assert.equal(bash("sed -i s/a/b/ f"), "other");
	});

	it("classifies a turn by its highest-priority tool call; no tool call is text-only", () => {
		const call = (name: string, command?: string) => ({ name, arguments: command === undefined ? {} : { command } });
		assert.equal(classifyTurn([]), "text-only");
		assert.equal(classifyTurn([call("read"), call("grep"), call("ls"), call("find")]), "explore");
		assert.equal(classifyTurn([call("read"), call("edit")]), "implement");
		assert.equal(classifyTurn([call("write")]), "implement");
		assert.equal(classifyTurn([call("check")]), "verify");
		assert.equal(classifyTurn([call("subagent"), call("todo")]), "delegate");
		assert.equal(classifyTurn([call("todo")]), "coordinate");
		assert.equal(classifyTurn([call("ask_user_choice")]), "coordinate");
		assert.equal(classifyTurn([call("bash", "npm test"), call("edit")]), "implement");
		assert.equal(classifyTurn([call("bash", "npm test"), call("bash", "git commit -m x")]), "deliver");
		assert.equal(classifyTurn([call("bash", "sleep 3"), call("bash", "git commit -m x")]), "poll");
		assert.equal(classifyTurn([call("mystery")]), "other");
	});
});

describe("computeStats on the fixture session", () => {
	const stats = computeStats([readLog("a")], evidence());

	it("totals turns, user messages, cost, tokens, and cache hit rate (aborted empty turns are not turns)", () => {
		assert.equal(stats.sessions, 1);
		assert.equal(stats.turns, 10);
		assert.equal(stats.userMessages, 2);
		near(stats.cost, 4.76);
		assert.equal(stats.input, 240);
		assert.equal(stats.output, 290);
		assert.equal(stats.cacheRead, 1_082_000);
		assert.equal(stats.cacheWrite, 160_570);
		near(stats.cacheHitRate ?? 0, 1_082_000 / (240 + 1_082_000 + 160_570));
	});

	it("reports context percentiles per turn and the cost share of turns above 200k", () => {
		assert.deepEqual(stats.context, { p50: 50_020, p75: 250_000, p90: 250_500, max: 251_000 });
		assert.equal(stats.turnsOver200k, 3);
		near(stats.costShareOver200k, 2.9 / 4.76);
	});

	it("counts cache rebuilds, their cost, and those that followed a gap over 60 minutes", () => {
		assert.equal(stats.rebuilds.count, 2);
		near(stats.rebuilds.cost, 1.6);
		assert.equal(stats.rebuilds.afterGap, 1);
	});

	it("splits cost by phase", () => {
		const cost = (phase: keyof typeof stats.phases) => stats.phases[phase].cost;
		const turns = (phase: keyof typeof stats.phases) => stats.phases[phase].turns;
		near(cost("explore"), 0.6);
		assert.equal(turns("explore"), 3);
		near(cost("implement"), 0.02);
		near(cost("verify"), 0.03);
		near(cost("deliver"), 1.0);
		near(cost("delegate"), 0.5);
		near(cost("poll"), 2.0);
		near(cost("coordinate"), 0.6);
		near(cost("text-only"), 0.01);
		assert.equal(stats.phases.other.turns, 0);
	});

	it("ranks tool calls", () => {
		assert.deepEqual(stats.tools[0], ["bash", 4]);
		assert.equal(stats.tools.length, 7);
		assert.ok(stats.tools.some(([name, count]) => name === "subagent" && count === 1));
	});

	it("counts gate blocks from tool results and evidence runs and forces inside the session window", () => {
		assert.equal(stats.blocks, 1);
		assert.deepEqual(stats.evidence, { pass: 1, fail: 1, unknown: 1, forces: 1 });
	});
});

describe("computeStats across sessions", () => {
	const stats = computeStats([readLog("a"), readLog("b")], evidence());

	it("adds the sessions up and tolerates empty turns", () => {
		assert.equal(stats.sessions, 2);
		assert.equal(stats.turns, 11);
		assert.equal(stats.userMessages, 3);
		near(stats.cost, 5.26);
		assert.equal(stats.phases.explore.turns, 4);
		assert.equal(stats.sessionRows.length, 2);
		assert.equal(stats.sessionRows[0].id, "aaaa1111");
		assert.equal(stats.sessionRows[0].turns, 10);
	});

	it("does not call the first turn of a session a rebuild", () => {
		assert.equal(stats.rebuilds.count, 2);
	});

	it("widens the evidence window to every selected session", () => {
		assert.deepEqual(stats.evidence, { pass: 2, fail: 1, unknown: 1, forces: 1 });
	});
});

describe("computeStats edge cases", () => {
	it("reports an empty selection without throwing", () => {
		const stats = computeStats([], []);
		assert.equal(stats.turns, 0);
		assert.equal(stats.context, undefined);
		assert.equal(stats.cacheHitRate, undefined);
		assert.equal(stats.evidence, undefined);
		assert.ok(renderStats(stats, "nothing").join("\n").includes("No sessions"));
	});
});

describe("renderStats", () => {
	const lines = renderStats(computeStats([readLog("a"), readLog("b")], evidence()), "all sessions of this project");
	const text = lines.join("\n");

	it("renders plain lines for each metric", () => {
		assert.ok(lines.length > 15);
		assert.ok(lines.every((line) => !line.includes("\n")));
		assert.match(text, /all sessions of this project/);
		assert.match(text, /2 sessions · 11 assistant turns · 3 user messages · \$5\.26/);
		assert.match(text, /cache hit 8\d%/);
		assert.match(text, /context\/turn\s+p50 50k\s+p75 250k\s+p90 25[01]k\s+max 251k/);
		assert.match(text, /turns >200k: 3 \(55% of cost\)/);
		assert.match(text, /rebuilds: 2 turns · \$1\.60 · 1 after a gap >60 min/);
		assert.match(text, /explore\s+4 turns · \$1\.10 · 21%/);
		assert.match(text, /bash ×5/);
		assert.match(text, /runs: 2 pass · 1 fail · 1 unknown · forces 1 · blocks 1/);
	});
});

describe("sessionFiles", () => {
	let dir: string;
	before(() => {
		dir = mkdtempSync(join(tmpdir(), "brigadev-stats-"));
		cpSync(join(FIXTURES, "sessions"), dir, { recursive: true });
		writeFileAge(join(dir, "a.jsonl"), 30);
		writeFileAge(join(dir, "b.jsonl"), 1);
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	function writeFileAge(file: string, days: number) {
		const at = new Date(Date.now() - days * 86_400_000);
		utimesSync(file, at, at);
	}

	it("lists every jsonl file, or only those modified in the last N days", () => {
		assert.deepEqual(sessionFiles(dir).map((f) => basename(f)).sort(), ["a.jsonl", "b.jsonl"]);
		assert.deepEqual(sessionFiles(dir, 7).map((f) => basename(f)), ["b.jsonl"]);
		assert.deepEqual(sessionFiles(join(dir, "missing")), []);
	});
});

describe("/brigadev:stats", () => {
	const saved = process.env.BRIGADEV_HOME;
	const savedChild = process.env.BRIGADEV_CHILD;
	let root: string;
	let sessions: string;
	let cwd: string;

	before(() => {
		root = mkdtempSync(join(tmpdir(), "brigadev-stats-cmd-"));
		sessions = join(root, "sessions");
		cwd = join(root, "demo");
		mkdirSync(cwd);
		cpSync(join(FIXTURES, "sessions"), sessions, { recursive: true });
		const home = join(root, "home");
		cpSync(join(FIXTURES, "evidence"), join(home, "demo", "evidence"), { recursive: true });
		process.env.BRIGADEV_HOME = home;
		delete process.env.BRIGADEV_CHILD; // the suite may itself run inside a brigadev child
		utimesSync(join(sessions, "a.jsonl"), new Date(Date.now() - 30 * 86_400_000), new Date(Date.now() - 30 * 86_400_000));
	});
	after(() => {
		if (saved === undefined) delete process.env.BRIGADEV_HOME;
		else process.env.BRIGADEV_HOME = saved;
		if (savedChild !== undefined) process.env.BRIGADEV_CHILD = savedChild;
		rmSync(root, { recursive: true, force: true });
	});

	const run = async (args: string) => {
		const pi = createFakePi();
		statsExtension(pi as never);
		const ctx = createFakeCtx({ cwd });
		ctx.sessionManager = {
			getBranch: () => [],
			getSessionDir: () => sessions,
			getSessionFile: () => join(sessions, "a.jsonl"),
			getEntries: () => readLog("a").entries,
		};
		await pi.commands.get("brigadev:stats").handler(args, ctx);
		return { pi, text: ctx.notifications.map((n) => n.message).join("\n") };
	};

	it("registers only the command: no tools, no hooks that could add prompt text", async () => {
		const { pi } = await run("");
		assert.equal(pi.tools.size, 0);
		assert.equal(pi.handlers.size, 0);
		assert.equal(pi.messages.length, 0);
		assert.deepEqual([...pi.commands.keys()], ["brigadev:stats"]);
	});

	it("reports the current session by default", async () => {
		const { text } = await run("");
		assert.match(text, /current session/);
		assert.match(text, /1 session · 10 assistant turns · 2 user messages · \$4\.76/);
		assert.match(text, /runs: 1 pass · 1 fail · 1 unknown · forces 1 · blocks 1/);
	});

	it("`all` reads every session file of the project and counts the current session once", async () => {
		const { text } = await run("all");
		assert.match(text, /2 sessions · 11 assistant turns/);
	});

	it("`<N>d` keeps sessions modified in the last N days; the current session always counts", async () => {
		const { text } = await run("7d");
		assert.match(text, /last 7 days/);
		assert.match(text, /2 sessions · 11 assistant turns/);
	});

	it("shows usage for an unknown argument", async () => {
		const { text } = await run("weekly");
		assert.match(text, /Usage: \/brigadev:stats \[all\|<N>d\]/);
	});
});
