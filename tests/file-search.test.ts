import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import {
	buildFdArgs,
	buildRgArgs,
	decideSearchPath,
	executeSearch,
	filterFdLines,
	filterRgLines,
	resolveOnPath,
	runBounded,
	type RunResult,
	type SearchContext,
	type SearchRunner,
} from "../lib/file-search.ts";
import { isSensitivePath, SENSITIVE_GLOBS } from "../lib/permission-policy.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

const done = (stdout: string, extra: Partial<RunResult> = {}): RunResult => ({ stdout, stderr: "", code: 0, timedOut: false, capped: false, ...extra });

function onPath(binary: string): boolean {
	try {
		execFileSync(binary, ["--version"], { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

let root: string;
let project: string;
let savedEnv: NodeJS.ProcessEnv;
let uninstall: () => void;

before(() => {
	// A subagent runs with BRIGADEV_CHILD=1, which changes the path rule under test: start from none.
	savedEnv = { ...process.env };
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
	root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-fs-")));
	project = path.join(root, "proj");
	fs.mkdirSync(project);
	uninstall = installPiStubs();
});

after(() => {
	uninstall();
	for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
	Object.assign(process.env, savedEnv);
	fs.rmSync(root, { recursive: true, force: true });
});

const context = (extra: Partial<SearchContext> = {}): SearchContext => ({
	cwd: project,
	projectRoot: project,
	isChild: false,
	confirm: async () => false,
	...extra,
});

describe("argument building", () => {
	it("builds rg argv with the pattern after `--` and the sensitive excludes after any model glob", () => {
		const args = buildRgArgs({ pattern: "-rf; echo hi", path: "src", glob: "*.ts", file_type: "ts", fixed_strings: true, hidden: true, context: 99, limit: 5000 });
		assert.ok(args.includes("--null"));
		assert.ok(args.includes("--fixed-strings"));
		assert.ok(args.includes("--hidden"));
		assert.deepEqual(args.slice(args.indexOf("--context"), args.indexOf("--context") + 2), ["--context", "20"]);
		assert.deepEqual(args.slice(args.indexOf("--max-count"), args.indexOf("--max-count") + 2), ["--max-count", "1000"]);
		assert.deepEqual(args.slice(-3), ["--", "-rf; echo hi", "src"]);
		const globs = args.flatMap((arg, i) => (args[i - 1] === "--glob" ? [arg] : []));
		assert.equal(globs[0], "*.ts");
		assert.ok(globs.includes("!**/.env"));
		assert.deepEqual(globs.slice(1), SENSITIVE_GLOBS.map((glob) => `!${glob}`));
	});

	it("leaves out the excludes and the path only when told to", () => {
		const args = buildRgArgs({ pattern: "x" }, { excludeSensitive: false });
		assert.ok(!args.includes("--glob"));
		assert.deepEqual(args.slice(-2), ["--", "x"]);
	});

	it("smart-case unless case_sensitive is set", () => {
		assert.ok(buildRgArgs({ pattern: "x" }).includes("--smart-case"));
		assert.ok(buildRgArgs({ pattern: "x", case_sensitive: true }).includes("--case-sensitive"));
		assert.ok(buildRgArgs({ pattern: "x", case_sensitive: false }).includes("--ignore-case"));
	});

	it("builds fd argv with --exclude for every sensitive glob and a pattern after `--`", () => {
		const args = buildFdArgs({ pattern: "*.test.ts", path: "tests", type: "file", extension: ".ts", glob: true, hidden: true, max_depth: 500, limit: 99_999 });
		assert.ok(args.includes("--glob"));
		assert.ok(args.includes("--hidden"));
		assert.deepEqual(args.slice(args.indexOf("--type"), args.indexOf("--type") + 2), ["--type", "f"]);
		assert.deepEqual(args.slice(args.indexOf("--extension"), args.indexOf("--extension") + 2), ["--extension", "ts"]);
		assert.deepEqual(args.slice(args.indexOf("--max-depth"), args.indexOf("--max-depth") + 2), ["--max-depth", "64"]);
		assert.deepEqual(args.slice(args.indexOf("--max-results"), args.indexOf("--max-results") + 2), ["--max-results", "10000"]);
		const excludes = args.flatMap((arg, i) => (args[i - 1] === "--exclude" ? [arg] : []));
		assert.deepEqual(excludes, [...SENSITIVE_GLOBS]);
		assert.deepEqual(args.slice(-3), ["--", "*.test.ts", "tests"]);
	});

	it("lists everything under the path when fd has no pattern", () => {
		assert.deepEqual(buildFdArgs({ path: "src" }).slice(-3), ["--", "", "src"]);
		assert.deepEqual(buildFdArgs({}).slice(-2), ["--", ""]);
	});

	it("strips a leading @ and expands ~ in the path", () => {
		assert.equal(buildRgArgs({ pattern: "x", path: "@src/a" }).at(-1), "src/a");
		assert.equal(buildFdArgs({ path: "~/notes" }).at(-1), path.join(os.homedir(), "notes"));
	});

	it("derives its excludes from the sensitive-path policy", () => {
		const samples = [".env", ".env.local", "a/.ssh/id_rsa", ".aws/credentials", ".npmrc", ".netrc", "id_ed25519", "x/cert.pem", "k.key", "s.p12", "s.pfx", "credentials.json", ".pi/agent/auth.json"];
		for (const sample of samples) assert.equal(isSensitivePath(sample), true, sample);
		// every pattern family in the policy has a glob here
		const families = [/\.env/, /\.ssh/, /\.aws/, /\.npmrc/, /\.netrc/, /id_/, /pem/, /key/, /p12/, /pfx/, /credentials\.json/, /auth\.json/];
		for (const family of families) assert.ok(SENSITIVE_GLOBS.some((glob) => family.test(glob)), String(family));
	});
});

describe("output filtering", () => {
	it("drops sensitive paths from fd output and counts them", () => {
		const { lines, omitted } = filterFdLines(["src/a.ts", ".env", "config/.env.local", ".env.example", "keys/server.pem", "a/.ssh/id_rsa", "docs/readme.md"], false);
		assert.deepEqual(lines, ["src/a.ts", ".env.example", "docs/readme.md"]);
		assert.equal(omitted, 4);
	});

	it("keeps everything when the sensitive path was explicitly allowed", () => {
		const { lines, omitted } = filterFdLines([".env", "a"], true);
		assert.deepEqual(lines, [".env", "a"]);
		assert.equal(omitted, 0);
	});

	it("rewrites rg --null lines and drops sensitive files, keeping context separators", () => {
		const stdout = ["src/a.ts\x0012:const x = 1;", "src/a.ts\x0013-  // context", "--", ".env\x001:TOKEN=abc", "a-1-b/.env\x002:SECRET=1", "dir/my-1-file.ts\x007:ok", ""].join("\n");
		const { lines, omitted } = filterRgLines(stdout, false);
		assert.deepEqual(lines, ["src/a.ts:12:const x = 1;", "src/a.ts-13-  // context", "--", "dir/my-1-file.ts:7:ok"]);
		assert.equal(omitted, 2);
	});

	it("passes lines without a NUL through", () => {
		assert.deepEqual(filterRgLines("plain line\n", false).lines, ["plain line"]);
	});

	it("decides on the canonical path too: a symlinked directory, and a cwd inside a credentials folder", () => {
		const home = path.join(root, "canon-home");
		const aws = path.join(home, ".aws");
		const proj = path.join(root, "canon-proj");
		fs.mkdirSync(aws, { recursive: true });
		fs.mkdirSync(proj, { recursive: true });
		fs.symlinkSync(aws, path.join(proj, "awsdir"));
		const rgOut = ["a.ts\x001:x", "awsdir/credentials\x001:SECRET", "awsdir/credentials\x002-ctx", "--"].join("\n");
		const fromProject = filterRgLines(rgOut, false, proj);
		assert.deepEqual(fromProject.lines, ["a.ts:1:x", "--"]);
		assert.equal(fromProject.omitted, 2);
		assert.deepEqual(filterRgLines("credentials\x001:SECRET\nconfig\x001:ok\n", false, aws).lines, ["config:1:ok"]);
		const fd = filterFdLines(["a.ts", "awsdir/credentials", "awsdir/config"], false, proj);
		assert.deepEqual(fd.lines, ["a.ts", "awsdir/config"]);
		assert.equal(fd.omitted, 1);
		assert.deepEqual(filterFdLines(["credentials"], false, aws), { lines: [], omitted: 1 });
		assert.deepEqual(filterFdLines(["awsdir/credentials"], true, proj), { lines: ["awsdir/credentials"], omitted: 0 });
	});
});

describe("resolveOnPath", () => {
	it("finds the first executable on PATH and ignores directories and non-executables", () => {
		const a = path.join(root, "bin-a");
		const b = path.join(root, "bin-b");
		fs.mkdirSync(a, { recursive: true });
		fs.mkdirSync(path.join(b, "fd"), { recursive: true });
		fs.writeFileSync(path.join(a, "fd"), "#!/bin/sh\n", { mode: 0o644 });
		fs.writeFileSync(path.join(b, "rg"), "#!/bin/sh\n", { mode: 0o755 });
		if (process.platform === "win32") return;
		assert.equal(resolveOnPath(["fd"], { PATH: `${a}${path.delimiter}${b}` }), undefined);
		assert.equal(resolveOnPath(["rg"], { PATH: `${a}${path.delimiter}${b}` }), path.join(b, "rg"));
		assert.equal(resolveOnPath(["rg"], { PATH: "" }), undefined);
		assert.equal(resolveOnPath(["rg"], {}), undefined);
	});

	it("tries the alternative names in order", () => {
		const bin = path.join(root, "bin-fdfind");
		fs.mkdirSync(bin, { recursive: true });
		fs.writeFileSync(path.join(bin, "fdfind"), "#!/bin/sh\n", { mode: 0o755 });
		if (process.platform === "win32") return;
		assert.equal(resolveOnPath(["fd", "fdfind"], { PATH: bin }), path.join(bin, "fdfind"));
	});
});

describe("decideSearchPath", () => {
	it("allows a path in the project and defaults to the cwd", async () => {
		assert.deepEqual(await decideSearchPath(undefined, context()), { action: "allow", allowSensitive: false });
		assert.deepEqual(await decideSearchPath("src", context()), { action: "allow", allowSensitive: false });
	});

	it("allows a path outside the project, as read does", async () => {
		assert.deepEqual(await decideSearchPath(root, context()), { action: "allow", allowSensitive: false });
	});

	it("asks the user about an explicit sensitive path and honours the answer", async () => {
		const asked: string[] = [];
		const yes = context({ confirm: async (_title, body) => (asked.push(body), true) });
		assert.deepEqual(await decideSearchPath(".env", yes), { action: "allow", allowSensitive: true });
		assert.equal(asked.length, 1);
		assert.match(asked[0], /\.env/);
		const no = await decideSearchPath(".ssh", context());
		assert.equal(no.action, "block");
		assert.match((no as { reason: string }).reason, /declined/i);
	});

	it("treats a sensitive directory as sensitive", async () => {
		const asked: string[] = [];
		await decideSearchPath("~/.ssh", context({ confirm: async (_t, body) => (asked.push(body), false) }));
		assert.equal(asked.length, 1);
	});

	it("blocks an explicit sensitive path for a subagent without asking", async () => {
		let asked = false;
		const result = await decideSearchPath("config/.env", context({ isChild: true, agent: "x", confirm: async () => ((asked = true), true) }));
		assert.equal(result.action, "block");
		assert.match((result as { reason: string }).reason, /secrets/);
		assert.equal(asked, false);
	});
});

describe("executeSearch with an injected runner", () => {
	it("runs the binary by argv in the project cwd with a bounded time and size", async () => {
		const calls: Array<{ command: string; args: string[]; options: Parameters<SearchRunner>[2] }> = [];
		const run: SearchRunner = async (command, args, options) => {
			calls.push({ command, args, options });
			return done("src/a.ts\x001:hit\n");
		};
		const out = await executeSearch("rg", "/usr/bin/rg", { pattern: "hit; rm -rf /" }, context(), run);
		assert.equal(out.text, "src/a.ts:1:hit");
		assert.equal(out.matchCount, 1);
		assert.equal(out.truncated, false);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, "/usr/bin/rg");
		assert.ok(calls[0].args.includes("hit; rm -rf /"));
		assert.equal(calls[0].options.cwd, project);
		assert.ok(calls[0].options.timeoutMs > 0 && calls[0].options.timeoutMs <= 60_000);
		assert.ok(calls[0].options.maxBytes > 0 && calls[0].options.maxBytes <= 8 * 1024 * 1024);
	});

	it("says so when nothing matches (rg exits 1; fd prints nothing)", async () => {
		assert.equal((await executeSearch("rg", "rg", { pattern: "x" }, context(), async () => done("", { code: 1 }))).text, "No matches found");
		assert.equal((await executeSearch("fd", "fd", {}, context(), async () => done(""))).text, "No files found");
	});

	it("caps lines and bytes and says it truncated", async () => {
		const many = Array.from({ length: 5000 }, (_, i) => `src/file-${i}.ts`).join("\n");
		const out = await executeSearch("fd", "fd", {}, context(), async () => done(many));
		assert.equal(out.truncated, true);
		assert.match(out.text, /\[Output truncated: showing \d+ of 5000 lines/);
		assert.ok(out.text.split("\n").length <= 2005);
		assert.ok(Buffer.byteLength(out.text) <= 51 * 1024);

		const wide = Array.from({ length: 100 }, (_, i) => `${"d".repeat(2000)}-${i}`).join("\n");
		const bytes = await executeSearch("fd", "fd", {}, context(), async () => done(wide));
		assert.equal(bytes.truncated, true);
		assert.ok(Buffer.byteLength(bytes.text) <= 52 * 1024);
	});

	it("reports a timed-out or over-capture run as incomplete", async () => {
		const timed = await executeSearch("fd", "fd", {}, context(), async () => done("a\nb", { code: null, timedOut: true }));
		assert.match(timed.text, /^a\nb/);
		assert.match(timed.text, /timed out/i);
		assert.equal(timed.truncated, true);
		const capped = await executeSearch("fd", "fd", {}, context(), async () => done("a", { code: null, capped: true }));
		assert.match(capped.text, /capture limit/i);
		assert.equal(capped.truncated, true);
	});

	it("filters sensitive results and tells how many were omitted", async () => {
		const out = await executeSearch("rg", "rg", { pattern: "x" }, context(), async () => done("a.ts\x001:x\n.env\x001:x\nkeys/a.pem\x003:x\n"));
		assert.equal(out.text.split("\n")[0], "a.ts:1:x");
		assert.ok(!/\.env|\.pem/.test(out.text.replace(/\[.*\]/s, "")));
		assert.match(out.text, /2 results? from sensitive files omitted/);
		assert.equal(out.omittedSensitive, 2);
	});

	it("does not exclude or filter an explicitly allowed sensitive path", async () => {
		const seen: string[][] = [];
		const out = await executeSearch("rg", "rg", { pattern: "x", path: ".env" }, context({ confirm: async () => true }), async (_c, args) => (seen.push(args), done(".env\x001:TOKEN=1\n")));
		assert.ok(!seen[0].some((arg) => arg.startsWith("!")));
		assert.match(out.text, /TOKEN=1/);
	});

	it("never runs the binary for a declined or blocked sensitive path", async () => {
		let ran = false;
		const run: SearchRunner = async () => ((ran = true), done(""));
		await assert.rejects(executeSearch("fd", "fd", { path: ".ssh" }, context(), run), /declined/i);
		await assert.rejects(executeSearch("rg", "rg", { pattern: "x", path: "a/.env" }, context({ isChild: true }), run), /secrets/);
		assert.equal(ran, false);
	});

	it("counts lines dropped by the canonical filter as omitted in the note", async () => {
		const home = path.join(root, "canon-home2", ".aws");
		fs.mkdirSync(home, { recursive: true });
		const out = await executeSearch("rg", "rg", { pattern: "x" }, context({ cwd: home, projectRoot: home }), async () => done("credentials\x001:x\nconfig\x001:x\n"));
		assert.equal(out.text.split("\n")[0], "config:1:x");
		assert.match(out.text, /1 result from sensitive files omitted/);
		assert.equal(out.omittedSensitive, 1);
	});

	it("reports rg's `No files were searched` error as no matches", async () => {
		const out = await executeSearch("rg", "rg", { pattern: "x", path: "src" }, context(), async () => done("", { code: 2, stderr: "rg: No files were searched, which means ripgrep probably applied a filter you didn't expect." }));
		assert.equal(out.text, "No matches found");
		await assert.rejects(executeSearch("rg", "rg", { pattern: "(" }, context(), async () => done("", { code: 2, stderr: "regex parse error" })), /rg failed/);
	});

	it("surfaces failures", async () => {
		await assert.rejects(executeSearch("rg", "rg", { pattern: "(" }, context(), async () => done("", { code: 2, stderr: "regex parse error" })), /rg failed: regex parse error/);
		await assert.rejects(executeSearch("fd", "fd", {}, context(), async () => done("", { code: null, stderr: "spawn fd ENOENT" })), /fd failed/);
		// a partial rg run (some files unreadable) still returns what it found
		const partial = await executeSearch("rg", "rg", { pattern: "x" }, context(), async () => done("a\x001:x\n", { code: 2, stderr: "denied" }));
		assert.match(partial.text, /^a:1:x/);
		assert.match(partial.text, /denied/);
	});
});

describe("runBounded (real processes)", () => {
	const node = process.execPath;

	it("passes argv without a shell and returns stdout and the exit code", async () => {
		const result = await runBounded(node, ["-e", "console.log(process.argv.slice(1).join('|'))", "a; echo pwned", "$HOME"], { cwd: root, timeoutMs: 10_000, maxBytes: 1024 });
		assert.equal(result.stdout.trim(), "a; echo pwned|$HOME");
		assert.equal(result.code, 0);
		assert.equal(result.timedOut, false);
	});

	it("kills a run that exceeds the time limit and keeps what it printed", async () => {
		const started = Date.now();
		const result = await runBounded(node, ["-e", "console.log('early'); setInterval(() => {}, 1000)"], { cwd: root, timeoutMs: 2000, maxBytes: 1024 });
		assert.equal(result.timedOut, true);
		assert.match(result.stdout, /early/);
		assert.ok(Date.now() - started < 10_000);
	});

	it("kills a run that exceeds the output limit", async () => {
		const result = await runBounded(node, ["-e", "setInterval(() => process.stdout.write('x'.repeat(10000)), 1)"], { cwd: root, timeoutMs: 10_000, maxBytes: 20_000 });
		assert.equal(result.capped, true);
		assert.ok(result.stdout.length <= 20_000);
	});

	it("reports a missing binary as a failed run, not a throw", async () => {
		const result = await runBounded(path.join(root, "no-such-binary"), [], { cwd: root, timeoutMs: 1000, maxBytes: 1024 });
		assert.equal(result.code, null);
		assert.match(result.stderr, /ENOENT/);
	});

	it("stops when the abort signal fires", async () => {
		const controller = new AbortController();
		const pending = runBounded(node, ["-e", "setInterval(() => {}, 1000)"], { cwd: root, timeoutMs: 10_000, maxBytes: 1024, signal: controller.signal });
		setTimeout(() => controller.abort(), 100);
		const result = await pending;
		assert.equal(result.timedOut, false);
		assert.notEqual(result.code, 0);
	});
});

describe("real fd and rg binaries", () => {
	const seed = () => {
		const dir = path.join(root, "real");
		fs.mkdirSync(path.join(dir, "src"), { recursive: true });
		fs.mkdirSync(path.join(dir, ".ssh"), { recursive: true });
		fs.writeFileSync(path.join(dir, "src", "a.ts"), "const needle = 1;\n");
		fs.writeFileSync(path.join(dir, ".env"), "needle=SECRET\n");
		fs.writeFileSync(path.join(dir, ".env.example"), "needle=\n");
		fs.writeFileSync(path.join(dir, "server.pem"), "needle\n");
		fs.writeFileSync(path.join(dir, ".ssh", "id_rsa"), "needle\n");
		return dir;
	};

	it("rg finds matches and never returns sensitive files, even with hidden on", { skip: !onPath("rg") && "rg is not on PATH" }, async () => {
		const dir = seed();
		const out = await executeSearch("rg", "rg", { pattern: "needle", hidden: true }, context({ cwd: dir, projectRoot: dir }));
		assert.match(out.text, /src\/a\.ts:1:/);
		assert.ok(!/SECRET|server\.pem|id_rsa|\.env:/.test(out.text), out.text);
		assert.equal((await executeSearch("rg", "rg", { pattern: "absent-token-xyz" }, context({ cwd: dir, projectRoot: dir }))).text, "No matches found");
	});

	it("env templates stay visible while real env files stay hidden (rg and fd)", { skip: (!onPath("rg") || !onPath("fd")) && "rg or fd is not on PATH" }, async () => {
		const dir = path.join(root, "real-env");
		fs.mkdirSync(dir, { recursive: true });
		for (const name of [".env", ".env.local", ".env.staging", ".env.test", ".env.production", ".env.example", ".env.sample", ".env.template"]) fs.writeFileSync(path.join(dir, name), "needle=1\n");
		const ctx = context({ cwd: dir, projectRoot: dir });
		const rg = (await executeSearch("rg", "rg", { pattern: "needle", hidden: true }, ctx)).text;
		const fd = (await executeSearch("fd", "fd", { hidden: true }, ctx)).text;
		for (const text of [rg, fd]) {
			for (const shown of [".env.example", ".env.sample", ".env.template"]) assert.match(text, new RegExp(shown.replace(".", "\\.")), `${shown} in ${text}`);
			assert.ok(!/\.env(\.local|\.staging|\.test|\.production)?(:|\n|$)/m.test(text.replace(/\[[^\]]*\]/g, "")), text);
		}
	});

	it("fd lists files and never returns sensitive ones, even with hidden on", { skip: !onPath("fd") && "fd is not on PATH" }, async () => {
		const dir = seed();
		const out = await executeSearch("fd", "fd", { hidden: true }, context({ cwd: dir, projectRoot: dir }));
		assert.match(out.text, /src\/a\.ts/);
		assert.ok(!/(^|\/)\.env$|\.pem|id_rsa/m.test(out.text), out.text);
	});
});

describe("extensions/file-search.ts", () => {
	const makeBin = (name: string, ...names: string[]) => {
		const dir = path.join(root, name);
		fs.mkdirSync(dir, { recursive: true });
		for (const bin of names) fs.writeFileSync(path.join(dir, bin), `#!/bin/sh\nprintf 'src/a.ts\\0'; printf '1:hit\\n'; printf '.env\\0'; printf '1:SECRET\\n'\n`, { mode: 0o755 });
		return dir;
	};
	const load = async () => (await import("../extensions/file-search.ts")) as { default: (pi: any) => void; registerFileSearchTools: (pi: any, deps?: any) => void };

	it("registers nothing when neither binary is on PATH", async () => {
		const pi = createFakePi();
		(await load()).registerFileSearchTools(pi, { env: { PATH: makeBin("bin-none") } });
		assert.equal(pi.tools.size, 0);
	});

	it("registers only the tool whose binary resolves", { skip: process.platform === "win32" }, async () => {
		const pi = createFakePi();
		(await load()).registerFileSearchTools(pi, { env: { PATH: makeBin("bin-rg", "rg") } });
		assert.deepEqual([...pi.tools.keys()], ["rg"]);
	});

	it("runs the resolved binary and filters sensitive output (parent and print mode)", { skip: process.platform === "win32" }, async () => {
		const pi = createFakePi();
		(await load()).registerFileSearchTools(pi, { env: { PATH: makeBin("bin-both", "rg", "fd") } });
		assert.deepEqual([...pi.tools.keys()].sort(), ["fd", "rg"]);
		const ctx = createFakeCtx({ cwd: project, hasUI: false });
		const result = await pi.tool("rg").execute("1", { pattern: "hit" }, undefined, undefined, ctx);
		assert.equal(result.content[0].type, "text");
		assert.match(result.content[0].text, /src\/a\.ts:1:hit/);
		assert.ok(!/SECRET/.test(result.content[0].text));
	});

	it("the default export resolves from the real PATH and registers only fd and rg, never downloading", async () => {
		const mod = await load();
		const pi = createFakePi();
		mod.default(pi);
		for (const name of pi.tools.keys()) assert.ok(name === "fd" || name === "rg");
	});

	it("asks the user before searching an explicit sensitive path", { skip: process.platform === "win32" }, async () => {
		const pi = createFakePi();
		(await load()).registerFileSearchTools(pi, { env: { PATH: makeBin("bin-ask", "rg") } });
		const asked: string[] = [];
		const ctx = createFakeCtx({ cwd: project });
		(ctx.ui as any).confirm = async (title: string, body: string) => (asked.push(`${title}\n${body}`), false);
		await assert.rejects(pi.tool("rg").execute("1", { pattern: "x", path: ".env" }, undefined, undefined, ctx), /declined/i);
		assert.equal(asked.length, 1);
	});
});
