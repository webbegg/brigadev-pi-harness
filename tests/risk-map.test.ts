// S1-S4: path-based risk map: classification, default globs, additive config, and the branch's changed paths.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { branchRisk, classifyPaths, DEFAULT_RISK_MAP, formatRiskLine, mergeRiskMap, riskNotice, resetRiskNotices } from "../lib/risk-map.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";

const classify = (...paths: string[]) => classifyPaths(paths, DEFAULT_RISK_MAP);

describe("classifyPaths (S1, S2)", () => {
	const table: Array<[string[], string, string[], string[]]> = [
		// paths, tier, categories, lenses
		[[], "T0", [], []],
		[["tests/a.test.ts", "tests/fixtures/x.json"], "T0", [], []],
		[["README.md", "docs/guide.md", "LICENSE", "CHANGELOG.md"], "T0", [], []],
		[["src/render.ts"], "T1", [], ["R3"]],
		[["src/guard.ts"], "T2", ["security"], ["R1", "R3"]],
		[["src/auth/login.ts"], "T2", ["security"], ["R1", "R3"]],
		[["db/migrations/001_init.sql"], "T2", ["data"], ["R3", "R4"]],
		[["api/openapi.yaml"], "T2", ["contract"], ["R3"]],
		[["schemas/run.schema.json"], "T2", ["contract"], ["R3"]],
		[["src/job-queue.ts"], "T1", ["concurrency"], ["R3", "R4"]],
		[["package.json"], "T1", ["delivery"], ["R1", "R3"]],
		[[".github/workflows/ci.yml"], "T1", ["delivery"], ["R1", "R3"]],
		[["Dockerfile"], "T1", ["delivery"], ["R1", "R3"]],
		[["assets/agents/reviewer.md"], "T1", [], ["R2", "R3"]],
		[["skills/review/SKILL.md", "AGENTS.md"], "T1", [], ["R2", "R3"]],
		[["assets/agents/reviewer.md", "src/render.ts"], "T1", [], ["R3"]],
		[["src/store.ts", "src/guard.ts"], "T2", ["data", "security"], ["R1", "R3", "R4"]],
		[["tests/guard.test.ts", "README.md"], "T0", [], []],
		[["tests/guard.test.ts", "src/render.ts"], "T1", [], ["R3"]],
	];
	for (const [paths, tier, categories, lenses] of table) {
		it(`${JSON.stringify(paths)} -> ${tier}`, () => {
			const c = classifyPaths(paths, DEFAULT_RISK_MAP);
			assert.equal(c.tier, tier);
			assert.deepEqual(Object.keys(c.categories).sort(), categories);
			assert.deepEqual(c.lenses, lenses);
		});
	}

	it("test paths are neutral even when another glob matches them", () => {
		for (const path of ["tests/guard.test.ts", "tests/auth/session.test.ts", "src/__tests__/migrations/x.ts", "fixtures/package.json", "lib/auth.spec.ts"]) {
			assert.equal(classify(path).tier, "T0", path);
		}
	});
	it("lists the matching paths per category", () => {
		assert.deepEqual(classify("src/guard.ts", "src/auth/a.ts", "src/x.ts").categories, { security: ["src/guard.ts", "src/auth/a.ts"] });
	});
	it("normalizes ./ and backslashes and ignores case", () => {
		assert.equal(classify("./src/Guard.ts").tier, "T2");
		assert.equal(classify("src\\guard.ts").tier, "T2");
		assert.equal(classify("DOCKERFILE").tier, "T1");
	});
	it("a documentation file is not raised by a category glob", () => {
		assert.equal(classify("docs/auth-design.md").tier, "T0");
	});
});

describe("mergeRiskMap (S3)", () => {
	it("adds globs from risk.paths and the repo's risk.repos entry, never removing defaults", () => {
		const { map, invalid } = mergeRiskMap(DEFAULT_RISK_MAP, { paths: { security: ["lib/x.ts"] }, repos: { me: { data: ["lib/db.ts"] }, other: { contract: ["lib/y.ts"] } } }, "me");
		assert.deepEqual(invalid, []);
		assert.equal(classifyPaths(["lib/x.ts"], map).tier, "T2");
		assert.equal(classifyPaths(["lib/db.ts"], map).categories.data?.[0], "lib/db.ts");
		assert.equal(classifyPaths(["lib/y.ts"], map).tier, "T1");
		assert.deepEqual(map.security.slice(0, DEFAULT_RISK_MAP.security.length), DEFAULT_RISK_MAP.security);
		assert.equal(classify("src/guard.ts").tier, "T2");
		assert.ok(!DEFAULT_RISK_MAP.security.includes("lib/x.ts"), "defaults are not mutated");
	});
	it("config cannot lower a tier: test and prompt are not configurable", () => {
		const { map, invalid } = mergeRiskMap(DEFAULT_RISK_MAP, { paths: { test: ["src/**"], prompt: ["src/**"] } }, "me");
		assert.equal(invalid.length, 2);
		assert.deepEqual(map, DEFAULT_RISK_MAP);
	});
	it("ignores and reports invalid entries but keeps the valid ones", () => {
		const { map, invalid } = mergeRiskMap(DEFAULT_RISK_MAP, { paths: { bogus: ["a"], security: ["ok.ts", 5, "", null], data: "nope" }, repos: { me: "x", you: { delivery: [1] } } }, "me");
		assert.equal(classifyPaths(["ok.ts"], map).tier, "T2");
		assert.equal(invalid.length, 7);
		assert.match(invalid.join("\n"), /risk\.paths\.bogus: unknown category/);
		assert.match(invalid.join("\n"), /risk\.paths\.security\[1\]/);
		assert.match(invalid.join("\n"), /risk\.paths\.data: not a list/);
		assert.match(invalid.join("\n"), /risk\.repos\.me: not an object/);
		assert.match(invalid.join("\n"), /risk\.repos\.you\.delivery\[0\]/);
	});
	it("treats a missing risk as nothing and a non-object risk as invalid", () => {
		assert.deepEqual(mergeRiskMap(DEFAULT_RISK_MAP, undefined, "me"), { map: DEFAULT_RISK_MAP, invalid: [] });
		assert.deepEqual(mergeRiskMap(DEFAULT_RISK_MAP, "x", "me").invalid, ["risk: not an object"]);
		assert.deepEqual(mergeRiskMap(DEFAULT_RISK_MAP, { paths: [] }, "me").invalid, ["risk.paths: not an object"]);
	});
});

describe("formatRiskLine", () => {
	it("T2 names the categories, the verify and the lenses", () => {
		assert.equal(formatRiskLine(classify("lib/guard-rules.ts")), "risk T2 security(lib/guard-rules.ts) → before PR: brigadev-verify + R1,R3");
	});
	it("shows at most two paths per category with +N and stays short", () => {
		const line = formatRiskLine(classify("a/auth/one.ts", "a/auth/two.ts", "a/auth/three.ts", "a/auth/four.ts", "db/migrations/1.sql"));
		assert.match(line, /^risk T2 security\(a\/auth\/one\.ts, a\/auth\/two\.ts \+2\) data\(db\/migrations\/1\.sql\) → before PR: brigadev-verify \+ R1,R3,R4$/);
		assert.ok(formatRiskLine(classify("x".repeat(200) + "/guard.ts", "y".repeat(200) + "/store.ts")).length <= 140);
	});
	it("T1 and T0", () => {
		assert.equal(formatRiskLine(classify("src/render.ts")), "risk T1 → before PR: review R3");
		assert.equal(formatRiskLine(classify("package.json")), "risk T1 delivery(package.json) → before PR: review R1,R3");
		assert.equal(formatRiskLine(classify("README.md")), "risk T0 → tests only");
	});
});

describe("branchRisk (S4)", () => {
	let dir: string, repo: string;
	const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
	const write = (path: string, text = "x\n") => {
		mkdirSync(join(repo, path, ".."), { recursive: true });
		writeFileSync(join(repo, path), text);
	};
	const exec: ExecFn = async (command, args, options) => {
		try {
			return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), stderr: "", code: 0 };
		} catch (error: any) {
			return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: error.status ?? 1 };
		}
	};

	before(() => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "risk-map-")));
		repo = join(dir, "my-repo");
		mkdirSync(repo);
		git("init", "-q", "-b", "main");
		write("src/render.ts");
		write("README.md");
		git("add", "-A");
		git("commit", "-q", "-m", "init");
	});
	after(() => rmSync(dir, { recursive: true, force: true }));

	it("is undefined outside a git repository", async () => {
		assert.equal(await branchRisk(exec, dir, DEFAULT_RISK_MAP), undefined);
	});
	it("is T0 on a clean default branch", async () => {
		const result = await branchRisk(exec, repo, DEFAULT_RISK_MAP);
		assert.equal(result?.tier, "T0");
		assert.equal(result?.branch, "main");
		assert.equal(result?.root, repo);
	});
	it("sees committed branch changes against main and the working tree", async () => {
		git("checkout", "-q", "-b", "feat/x");
		write("src/guard.ts");
		git("add", "-A");
		git("commit", "-q", "-m", "guard");
		write("package.json", "{}\n");
		const result = await branchRisk(exec, repo, DEFAULT_RISK_MAP);
		assert.equal(result?.tier, "T2");
		assert.deepEqual(result?.categories, { security: ["src/guard.ts"], delivery: ["package.json"] });
		assert.equal(result?.branch, "feat/x");
		assert.ok(result?.base && /^[0-9a-f]{40}$/.test(result.base));
	});
	it("handles renames: both the old and the new path count", async () => {
		git("add", "-A");
		git("commit", "-q", "-m", "pkg");
		git("checkout", "-q", "main");
		git("checkout", "-q", "-b", "feat/rename");
		renameSync(join(repo, "src/render.ts"), join(repo, "src/auth-render.ts"));
		git("add", "-A");
		const result = await branchRisk(exec, repo, DEFAULT_RISK_MAP);
		assert.deepEqual(result?.categories.security, ["src/auth-render.ts"]);
		git("reset", "-q", "--hard");
	});
	it("uses the repo slug (top-level folder name) to pick the config, and falls back to master", async () => {
		git("checkout", "-q", "main");
		git("branch", "-q", "-m", "main", "master");
		git("checkout", "-q", "-b", "feat/slug");
		write("src/render.ts", "changed\n");
		const slugs: string[] = [];
		const result = await branchRisk(exec, repo, (slug) => (slugs.push(slug), mergeRiskMap(DEFAULT_RISK_MAP, { repos: { "my-repo": { data: ["src/render.ts"] } } }, slug).map));
		assert.deepEqual(slugs, ["my-repo"]);
		assert.equal(result?.tier, "T2");
		assert.deepEqual(result?.categories, { data: ["src/render.ts"] });
		git("checkout", "-q", "--", ".");
	});
	it("with no base ref only the working tree counts, and a git failure does not throw", async () => {
		const bare = join(dir, "bare");
		mkdirSync(bare);
		execFileSync("git", ["init", "-q", "-b", "trunk"], { cwd: bare });
		writeFileSync(join(bare, "guard.ts"), "x");
		const result = await branchRisk(exec, bare, DEFAULT_RISK_MAP);
		assert.equal(result?.tier, "T2");
		assert.equal(result?.base, undefined);
		const failing: ExecFn = async () => {
			throw new Error("boom");
		};
		assert.equal(await branchRisk(failing, repo, DEFAULT_RISK_MAP), undefined);
	});

	it("riskNotice (S5 engine) shows the first time, then only when the tier or categories change", async () => {
		resetRiskNotices();
		git("checkout", "-q", "-b", "feat/notice");
		write("src/render.ts", "n1\n");
		const first = await riskNotice(exec, repo, {});
		assert.equal(first, "risk T1 → before PR: review R3");
		assert.equal(await riskNotice(exec, repo, {}), undefined);
		write("src/render.ts", "n2\n");
		assert.equal(await riskNotice(exec, repo, {}), undefined, "same tier and categories");
		write("src/guard.ts");
		assert.match((await riskNotice(exec, repo, {})) ?? "", /^risk T2 security\(src\/guard\.ts\)/);
		assert.equal(await riskNotice(exec, repo, {}), undefined);
		write("src/store.ts");
		assert.match((await riskNotice(exec, repo, {})) ?? "", /data\(src\/store\.ts\)/, "a new category");
		// Another branch has its own memory.
		git("checkout", "-q", "-b", "feat/other");
		assert.match((await riskNotice(exec, repo, {})) ?? "", /^risk T2/);
		assert.equal(await riskNotice(exec, dir, {}), undefined, "no git: nothing");
		const failing: ExecFn = async () => {
			throw new Error("boom");
		};
		assert.equal(await riskNotice(failing, repo, {}), undefined);
	});
});
