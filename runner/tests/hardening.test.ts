// C6: the warnings that came with the verify pass. R4-003 a merged PR of a reused branch name; R1-003 what the runner publishes is redacted; R4-001 the done
// command's timeout, process group, and output cap; R3-003 a PR comment that cannot be posted is a Log line and a line of `status`.
import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { mergeLoop, statusText } from "../src/control.ts";
import { POLL_MS, type PrDeps } from "../src/pr.ts";
import { DEFAULT_DONE_TIMEOUT_MINUTES, doneTimeoutMs, MAX_TAIL_BYTES } from "../src/shell.ts";
import { redact } from "../src/redact.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";
import { commitFile, docText, fakeClock, FEATURE_BRANCH, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, type FixtureRunner, type Isolation, type Workspace } from "./fixture.ts";
import { addRemote, drivers, FakeGh, prDepsOf } from "./pr-fixture.ts";

let isolation: Isolation;
before(() => {
	isolation = isolateEnv();
});
after(() => isolation.restore());

let ws: Workspace;
let gh: FakeGh;
let clock: ReturnType<typeof fakeClock>;
let runner: FixtureRunner | undefined;
let savedHome: string | undefined;
beforeEach(() => {
	savedHome = process.env.HOME;
	isolation.settings({ check: { test: "true" } });
	rmSync(isolation.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
	gh = new FakeGh(addRemote(ws));
	clock = fakeClock();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	if (savedHome === undefined) delete process.env.HOME;
	else process.env.HOME = savedHome;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: app deps: none done: `test -f app.js` — pending";
const logLines = () => readDoc(ws).split("## Log\n")[1].trim().split("\n");

/** A PR loop run over a fake gh, with `intercept` first in line for every git/gh call (it returns a result to answer instead, or undefined to pass the call through). */
async function begin(intercept: (command: string, args: string[]) => { stdout: string; stderr: string; code: number } | undefined = () => undefined) {
	writeFileSync(ws.docPath, docText([T1]));
	const prDeps: PrDeps = { ...prDepsOf(gh), exec: async (command, args, options) => intercept(command, args) ?? gh.exec(command, args, options) };
	runner = await openFixtureRunner(ws, makeWorker({ T1: commitFile("app.js") }), { clock, prDeps });
	const id = await runner.start(ws.docPath, { pr: true });
	return { id, drive: drivers(() => runner!, gh, clock, POLL_MS) };
}

describe("an older merged PR of a reused branch name (R4-003)", () => {
	const OLD = () => ({ number: 7, title: "old", body: "", base: "main", head: FEATURE_BRANCH, state: "MERGED" as const, isDraft: false, headSha: "0".repeat(40) });

	it("is not ours: the loop stops for a person instead of ending merged", async () => {
		gh.prs.push(OLD());
		const { id, drive } = await begin();
		const stopped = await drive.atStop(id);
		assert.equal(stopped.reason, "an older PR #7 for this branch is merged; open a new branch");
		assert.equal(gh.creates().length, 0, "no second PR was opened over it");
		assert.equal(gh.merges().length, 0);
		assert.equal((await runner!.status(id)).state, "running", "the loop did not end merged");
	});

	it("a merged PR at the commit pushed now still ends the loop merged (someone merged it)", async () => {
		const { id, drive } = await begin((command, args) => {
			// The first look at the PR after the push: it is merged already, at the pushed commit.
			if (command === "gh" && args[0] === "pr" && args[1] === "view" && !/^\d+$/.test(args[2] ?? "") && gh.prs.length === 0) {
				gh.prs.push({ number: 8, title: "t", body: "", base: "main", head: FEATURE_BRANCH, state: "MERGED", isDraft: false });
			}
			return undefined;
		});
		const outcome = (await runner!.wait(id)) as { status: string; result?: { status: string; number: number } };
		assert.equal(outcome.status, "completed");
		assert.deepEqual([outcome.result?.status, outcome.result?.number], ["merged", 8]);
		void drive;
	});
});

describe("redaction of what the runner publishes (R1-003)", () => {
	it("credentials in URLs, token-looking strings, and the home directory", () => {
		const home = "/Users/someone";
		assert.equal(redact("fatal: unable to access 'https://user:ghp_secret@github.com/a/b.git/'", home), "fatal: unable to access 'https://***@github.com/a/b.git/'");
		assert.equal(redact("remote: https://x-access-token:abc123@github.com/o/r", home), "remote: https://***@github.com/o/r");
		for (const token of [`ghp_${"a1B2".repeat(9)}`, `gho_${"x".repeat(36)}`, `github_pat_${"A1".repeat(20)}`, "sk-ant-api03-abcdefghijklmnop", `sk-${"q".repeat(40)}`, "0123456789abcdef0123456789abcdef01234567", "dGhpcyBpcyBhIHNlY3JldCBrZXkgb2YgbGVuZ3RoIDQ4Cg0abcXYZ1"]) {
			assert.equal(redact(`token ${token} end`, home), "token *** end", token);
		}
		assert.equal(redact(`${home}/projects/x/feature.md and ${home}`, home), "~/projects/x/feature.md and ~");
		// Ordinary text stays: a short sha, a long path or identifier, a plain sentence.
		for (const keep of ["T1 done abc1234 (npm test passed)", "runner/src/integrity.ts and runner/tests/integrity.test.ts", "a_very_long_function_name_without_any_digits_in_it", "PR #12 comment failed: HTTP 403"]) assert.equal(redact(keep, home), keep);
	});

	it("a needs-you comment and its Log line carry no credential and show the doc path with `~`", async () => {
		process.env.HOME = ws.root; // the doc is under the home directory, as a real one is
		const secret = `ghp_${"Z9yX".repeat(9)}`;
		const { id, drive } = await begin((command, args) =>
			command === "gh" && args[0] === "pr" && args[1] === "merge"
				? { stdout: "", stderr: `fatal: could not read from https://user:s3cr3t@example.com/acme/repo.git with ${secret} in ${ws.root}/scratch`, code: 1 }
				: undefined,
		);
		await drive.atMerge(id);
		assert.equal((await mergeLoop(runner!, ws.docPath)).code, 0);
		await drive.atStop(id);
		const comment = gh.comments.at(-1)!.body;
		assert.match(comment, /^Needs you: gh pr merge failed: /);
		assert.ok(!/s3cr3t|ghp_Z9yX/.test(comment), comment);
		assert.ok(comment.includes("https://***@example.com"), comment);
		assert.ok(!comment.includes(ws.root), `the home directory is shown as ~: ${comment}`);
		assert.ok(comment.includes("brigadev-runner resume ~/feature.md"), comment);
		const logged = logLines().find((line) => line.includes("PR loop needs you"))!;
		assert.ok(logged && !/s3cr3t|ghp_Z9yX/.test(logged) && !logged.includes(ws.root), logged);
		assert.ok(!/s3cr3t|ghp_Z9yX/.test((await runner!.status(id)).pr?.reason ?? ""), "the reason `status` shows");
	});
});

describe("the done command: timeout, process group, output cap (R4-001)", () => {
	it("settings runner.doneTimeoutMinutes sets the timeout (default 30 minutes)", () => {
		assert.equal(doneTimeoutMs(undefined), DEFAULT_DONE_TIMEOUT_MINUTES * 60_000);
		assert.equal(DEFAULT_DONE_TIMEOUT_MINUTES, 30);
		assert.equal(doneTimeoutMs({ runner: { doneTimeoutMinutes: 2 } }), 120_000);
		assert.equal(doneTimeoutMs({ runner: { doneTimeoutMinutes: -1 } }), 30 * 60_000);
	});

	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	const dead = async (pid: number) => {
		for (let i = 0; i < 100 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 20));
		return !alive(pid);
	};
	const spawned = (name: string) => `sleep 60 & echo $! > ${join(ws.root, name)}; sleep 60`;
	const pidOf = (name: string) => Number(readFileSync(join(ws.root, name), "utf8").trim());

	it("a command that hangs is killed with its whole process group after the timeout", async () => {
		const started = Date.now();
		const result = await defaultDeps.run(spawned("pid-timeout"), ws.repo, undefined, { timeoutMs: 400 });
		assert.ok(Date.now() - started < 10_000, "returned long before the sleeps would have");
		assert.equal(result.exitCode, null, "killed by a signal");
		assert.match(result.output, /killed: no result within/);
		assert.ok(await dead(pidOf("pid-timeout")), "the background child died with its group");
	});

	it("an abort kills the group and rejects", async () => {
		const controller = new AbortController();
		const pending = defaultDeps.run(spawned("pid-abort"), ws.repo, controller.signal, { timeoutMs: 60_000 });
		await new Promise((resolve) => setTimeout(resolve, 500));
		controller.abort();
		await assert.rejects(pending, /abort/i);
		assert.ok(await dead(pidOf("pid-abort")));
	});

	it("keeps the tail of a very large output, at most 1 MB", async () => {
		const result = await defaultDeps.run("head -c 3000000 /dev/zero | tr '\\0' x; echo THE-END", ws.repo, undefined, { timeoutMs: 60_000 });
		assert.equal(result.exitCode, 0);
		assert.ok(result.output.length <= MAX_TAIL_BYTES + 100, `${result.output.length}`);
		assert.ok(result.output.trimEnd().endsWith("THE-END"), "the tail is the part kept");
	});

	it("a ticket whose done command hangs fails with the timeout in its note instead of hanging the loop", async () => {
		isolation.settings({ check: { test: "true" }, runner: { doneTimeoutMinutes: 0.01 } });
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: slow deps: none done: `sleep 60` — pending"]));
		runner = await openFixtureRunner(ws, makeWorker({ T1: commitFile("t1.txt") }));
		const id = await runner.start(ws.docPath, { maxAttempts: 1 });
		const outcome = await runner.settle(id);
		assert.deepEqual(outcome, { status: "completed", result: { status: "stalled", waiting: ["T1"] } });
		assert.match(ticketLine(readDoc(ws), "T1"), /— blocked needs you: done check failed/);
		assert.match(readDoc(ws), /killed: no result within 1 s|done check failed \(exit signal\)/);
	});

	it("the deps the tests inject keep working without the new argument", async () => {
		const deps: TicketDeps = { head: defaultDeps.head, run: (command, cwd, signal) => defaultDeps.run(command, cwd, signal) };
		const result = await deps.run("echo ok", ws.repo);
		assert.deepEqual([result.exitCode, result.output.trim()], [0, "ok"]);
	});
});

describe("a PR comment that cannot be posted (R3-003)", () => {
	it("is a Log line `PR #n comment failed: <redacted stderr>` and a warning in `status`; the loop goes on", async () => {
		const secret = `ghp_${"Q7wE".repeat(9)}`;
		const { id, drive } = await begin((command, args) => (command === "gh" && args[0] === "pr" && args[1] === "comment" ? { stdout: "", stderr: `HTTP 403: Resource not accessible by personal access token ${secret}`, code: 1 } : undefined));
		await drive.atMerge(id);
		const line = logLines().find((entry) => entry.includes("comment failed"));
		assert.ok(line, `no Log line: ${readDoc(ws)}`);
		assert.match(line, /PR #1 comment failed: HTTP 403: Resource not accessible by personal access token \*\*\*$/);
		assert.ok(!line.includes(secret));
		const status = await statusText(runner!, ws.docPath);
		assert.match(status.text, /warning: PR #1 comment failed: HTTP 403/);
		assert.equal(gh.comments.length, 0, "the comment never landed, and nothing else broke");
		assert.ok(existsSync(ws.docPath));
	});
});
