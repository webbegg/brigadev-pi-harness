// T6 (S2b, S4): the PR loop as the last phase of the ticket loop, on a real local bare remote and a fake `gh`.
// A2 happy path, A3 CI failure → fix → push again / three failures → needs-you → resume, A4 verify on T2 (and not on T1), A5 the merge gate, A7 existing PR / nothing ahead.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { answerDecision, mergeLoop, resumeLoop, statusText } from "../src/control.ts";
import { POLL_MS, prBody, prTitle, type PrDeps } from "../src/pr.ts";
import type { LoopStatus } from "../src/runner.ts";
import { askUser, bash, check, commitFile, docText, fakeClock, FEATURE_BRANCH, git, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, type FixtureRunner, type Isolation, type Step, type Workspace } from "./fixture.ts";
import { addRemote, FakeGh, FAIL, PASS, PENDING, prDepsOf, until, verdict } from "./pr-fixture.ts";

let env: Isolation;
before(() => {
	env = isolateEnv();
});
after(() => env.restore());

let ws: Workspace;
let gh: FakeGh;
let clock: ReturnType<typeof fakeClock>;
let runner: FixtureRunner | undefined;
beforeEach(() => {
	env.settings({ check: { test: "true" } });
	rmSync(env.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
	gh = new FakeGh(addRemote(ws));
	clock = fakeClock();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const ticket = (file: string) => `- T1 [S1] inline: ${file.replace(/\.js$/, "")} deps: none done: \`test -f ${file}\` — pending`;
type Id = Parameters<FixtureRunner["status"]>[0];

/** A one-ticket doc, T1 committing `file` (`auth.js` is a T2 path under the default risk map, `app.js` a T1 one), and the PR loop on. */
async function begin(scripts: Parameters<typeof makeWorker>[0], file = "app.js", prDeps: PrDeps = prDepsOf(gh)) {
	writeFileSync(ws.docPath, docText([ticket(file)]));
	const worker = makeWorker({ T1: commitFile(file), ...scripts });
	runner = await openFixtureRunner(ws, worker, { clock, prDeps });
	const id = await runner.start(ws.docPath, { pr: true });
	return { worker, id };
}

const polls = () => gh.ghCalls.filter((args) => args[0] === "pr" && args[1] === "view" && /^\d+$/.test(args[2] ?? "")).length;
const prOf = async (id: Id) => (await runner!.status(id)).pr;
const asleepAt = (id: Id, phase: string) => until(async () => ((p) => (p?.phase === phase && p.asleep ? p : undefined))(await prOf(id)), `the PR loop asleep at ${phase}`);

/** Drive the fake clock: whenever the PR loop sleeps between CI polls, let one poll interval pass, until `done` holds for the PR loop's status. */
async function driveTo(id: Id, done: (pr: NonNullable<LoopStatus["pr"]>) => boolean) {
	return until(async () => {
		const pr = await prOf(id);
		if (pr && done(pr)) return pr;
		if (pr?.phase === "wait-ci" && pr.asleep) {
			const before = polls();
			clock.advance(POLL_MS);
			await until(() => polls() > before || undefined, "a poll");
		}
		return undefined;
	}, "the PR loop to reach the wanted state");
}
const atMerge = (id: Id) => driveTo(id, (pr) => pr.phase === "wait-merge" && pr.asleep);
const atStop = (id: Id) => driveTo(id, (pr) => pr.phase === "needs-you" && pr.asleep && pr.resumeKey !== undefined);
const logLines = () => readDoc(ws).split("## Log\n")[1].trim().split("\n");
const outcomeOf = async (id: Id) => (await runner!.wait(id as never)) as { status: string; result: { status: string; url: string; number: number } };

describe("title and body (A2)", () => {
	it("the type comes from the branch, the subject from the doc's first heading, else the Objective's first sentence", () => {
		assert.equal(prTitle("feat/durable-runner", "# Durable ticket runner (pi-durable prototype)\nObjective: x."), "feat: durable ticket runner (pi-durable prototype)");
		assert.equal(prTitle("fix/login", "Objective: Stop the login loop. Then more.\n"), "fix: stop the login loop");
		assert.equal(prTitle("wip", "# CI repair\n"), "chore: CI repair", "an acronym keeps its case; an unknown branch type is chore");
		assert.equal(prTitle("feat/x", ""), "feat: x");
	});

	it("the body has the objective, the tickets with their commits, the risk tier, and who opened it", () => {
		const body = prBody(docText(["- T1 [S1] inline: first deps: none done: `true` — done abc1234 (true passed)"]), { tier: "T2", categories: ["security"] });
		assert.match(body, /## Objective\nfixture\./);
		assert.match(body, /- T1 inline: first — done abc1234 \(true passed\)/);
		assert.match(body, /Risk tier: T2 \(security\)/);
		assert.match(body, /Opened by brigadev-runner\./);
	});
});

describe("happy path (A2)", () => {
	it("final-check → verify (T2, clean) → push once → one PR with the conventional title → CI pending then green → one comment → merge signal → merge once → merged", async () => {
		gh.checks = () => [PENDING];
		const { worker, id } = await begin({ VERIFY: [verdict()] }, "auth.js");

		const waiting = await asleepAt(id, "wait-ci");
		assert.equal(waiting.url, "https://github.com/acme/repo/pull/1");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "VERIFY"], "T2: verify ran once, after the ticket");
		assert.match(worker.prompts[1].system, /read-only/i);
		assert.match(worker.prompts[1].system, /verify_verdict/);
		assert.equal(gh.pushes().length, 1);
		assert.deepEqual(gh.pushes()[0], ["push", "-u", "origin", `HEAD:${FEATURE_BRANCH}`], "never forced");
		assert.equal(gh.remoteSha(FEATURE_BRANCH), git(ws.repo, "rev-parse", "HEAD"));
		assert.equal(gh.creates().length, 1);
		const [create] = gh.creates();
		assert.deepEqual([create[create.indexOf("--base") + 1], create[create.indexOf("--head") + 1], create[create.indexOf("--title") + 1]], ["main", FEATURE_BRANCH, "feat: feature"]);
		for (const flag of ["--admin", "--auto", "--delete-branch"]) assert.ok(!gh.ghCalls.some((args) => args.includes(flag)), flag);
		const [pr] = gh.prs;
		assert.match(pr.body, /## Objective\nfixture\./);
		assert.match(pr.body, /- T1 inline: auth — done [0-9a-f]{7}/);
		assert.match(pr.body, /Risk tier: T2 \(security\)/);
		assert.match(pr.body, /Opened by brigadev-runner\./);

		// CI is pending: a poll finds nothing to act on; no comment, no merge.
		clock.advance(POLL_MS);
		await until(() => polls() >= 1 || undefined, "the first poll");
		assert.equal((await prOf(id))?.phase, "wait-ci");
		assert.equal(gh.comments.length, 0);
		const poll = gh.ghCalls.find((args) => args[1] === "view" && /^\d+$/.test(args[2]))!;
		assert.deepEqual(poll, ["pr", "view", "1", "--json", "headRefOid,statusCheckRollup,state,isDraft"]);

		gh.checks = () => [PASS];
		const parked = await atMerge(id);
		assert.equal(parked.mergeKey, "merge-1");
		assert.deepEqual(gh.comments, [{ number: 1, body: `Ready to merge: run \`brigadev-runner merge ${ws.docPath}\`` }], "one comment");
		const status = await statusText(runner!, ws.docPath);
		assert.match(status.text, /pr: wait-merge {2}https:\/\/github\.com\/acme\/repo\/pull\/1/);
		assert.match(status.text, new RegExp(`merge: brigadev-runner merge ${ws.docPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));

		// Time passes and CI stays green: nothing merges without the signal.
		clock.advance(3 * POLL_MS);
		await new Promise((resolve) => setTimeout(resolve, 200));
		assert.equal(gh.merges().length, 0);

		const approved = await mergeLoop(runner!, ws.docPath);
		assert.deepEqual([approved.code, approved.result], [0, "delivered"], approved.text);
		const outcome = await outcomeOf(id);
		assert.equal(outcome.result.status, "merged");
		assert.deepEqual([outcome.result.url, outcome.result.number], ["https://github.com/acme/repo/pull/1", 1]);
		const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ws.repo, encoding: "utf8" }).trim();
		// --match-head-commit: GitHub refuses the merge if the head moved between the re-read and the merge.
		assert.deepEqual(gh.merges(), [["pr", "merge", "1", "--merge", "--match-head-commit", head]], "merged once, with --merge and the pushed head only");
		assert.equal(gh.comments.length, 1);
		assert.equal(gh.pushes().length, 1);
		assert.equal(gh.creates().length, 1);
		assert.ok(logLines().some((line) => /PR #1 opened https:\/\/github\.com\/acme\/repo\/pull\/1$/.test(line)));
		assert.ok(logLines().some((line) => /PR #1 merged [0-9a-f]{7} https:\/\/github\.com\/acme\/repo\/pull\/1$/.test(line)));
		const done = await runner!.status(id);
		assert.deepEqual([done.state, done.merged?.number], ["done", 1]);
	});

	it("a T1 branch skips verify", async () => {
		const { worker, id } = await begin({});
		await asleepAt(id, "wait-ci");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "no VERIFY conversation");
		assert.equal(gh.pushes().length, 1);
	});

	it("no checks reported at all counts as green", async () => {
		gh.checks = () => [];
		const { id } = await begin({});
		assert.equal((await atMerge(id)).mergeKey, "merge-1");
	});

	it("a PR that is already merged ends the loop merged, without a merge call", async () => {
		gh.checks = () => [PENDING];
		const { id } = await begin({});
		await asleepAt(id, "wait-ci");
		gh.prs[0].state = "MERGED";
		clock.advance(POLL_MS);
		const outcome = await outcomeOf(id);
		assert.equal(outcome.result.status, "merged");
		assert.equal(gh.merges().length, 0);
	});
});

describe("CI failure → fix → push again (A3)", () => {
	it("a failed check fetches the filtered log, runs FIX-1 (RED then GREEN, new commit), pushes the new sha once, and CI passes; the fix worker's own `git push` stays blocked", async () => {
		env.settings({ check: { test: "! grep -qs RED marker.txt" } });
		gh.checks = () => (gh.pushes().length >= 2 ? [PASS] : [FAIL]);
		const fix: Step[] = [
			bash("git push origin HEAD:refs/heads/evil"),
			bash("echo RED > marker.txt"),
			check(), // RED: the suite fails while the marker says RED
			bash("echo ok > marker.txt && echo fixed >> fix1.js"),
			check(), // GREEN
			bash('git add -A && git -c commit.gpgsign=false -c core.hooksPath=/dev/null -c user.name=Runner -c user.email=runner@example.com commit -q -m "fix ci"'),
		];
		const { worker, id } = await begin({ "FIX-1": fix });
		await asleepAt(id, "wait-ci");
		const firstSha = gh.remoteSha(FEATURE_BRANCH);
		await atMerge(id);

		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1"]);
		const brief = worker.prompts[1].system;
		assert.match(brief, /CI failed on [0-9a-f]{7}: test/);
		assert.match(brief, /FAIL: expected 1, got 2/, "the filtered failure log");
		assert.match(brief, /failing test first \(RED\), then fix it, run the suite \(GREEN\), and commit/);
		const results = worker.results.filter((r) => r.ticketId === "FIX-1");
		assert.match(results[0].text, /runner owns PR delivery/, "the fix worker's git push is blocked");
		assert.equal(gh.remoteSha("evil"), undefined);
		assert.match(results[2].text, /fail/i, "RED");
		assert.match(results[4].text, /pass/i, "GREEN");

		assert.equal(gh.pushes().length, 2, "two pushes: the ticket's commit and the fix's, one each");
		assert.notEqual(gh.remoteSha(FEATURE_BRANCH), firstSha);
		assert.equal(gh.remoteSha(FEATURE_BRANCH), git(ws.repo, "rev-parse", "HEAD"));
		assert.equal(git(ws.repo, "rev-list", "--count", "main..HEAD"), "2", "T1's commit and one fix commit");
		assert.equal(gh.creates().length, 1, "one PR");
		assert.equal(gh.comments.length, 1, "only the merge-ready comment");
		assert.ok(gh.ghCalls.some((args) => args.join(" ") === "run view 101 --log-failed"));
	});

	it("three failed fix attempts end in needs-you with one PR comment, a Log line, and a `resume` that continues with a fresh budget", async () => {
		gh.checks = () => (gh.pushes().length >= 5 ? [PASS] : [FAIL]);
		const { worker, id } = await begin({ "FIX-1": commitFile("fix1.js"), "FIX-2": commitFile("fix2.js"), "FIX-3": commitFile("fix3.js"), "FIX-4": commitFile("fix4.js") });
		const stopped = await atStop(id);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1", "FIX-2", "FIX-3"], "three attempts, no fourth");
		assert.equal(gh.pushes().length, 4);
		assert.match(stopped.reason ?? "", /3 fix attempts used; the last failure: CI failed on/);
		assert.deepEqual(gh.comments.map((c) => c.body.split("\n")[0]), [`Needs you: ${stopped.reason}`], "one comment");
		assert.ok(logLines().some((line) => /PR loop needs you \(1\): 3 fix attempts used/.test(line)));
		const status = await statusText(runner!, ws.docPath);
		assert.match(status.text, /pr: needs-you/);
		assert.match(status.text, /resume: brigadev-runner resume /);

		const resumed = await resumeLoop(runner!, ws.docPath);
		assert.deepEqual([resumed.code, resumed.result], [0, "delivered"], resumed.text);
		await atMerge(id);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1", "FIX-2", "FIX-3", "FIX-4"], "the fresh budget ran a fourth fix, at the phase that stopped (CI)");
		assert.equal(gh.comments.length, 2, "the needs-you comment, then the merge-ready one");
		assert.equal(gh.creates().length, 1);
	});
});

describe("a fix ticket's decision parks like a normal ticket's (S4, S9)", () => {
	it("FIX-1 asks: the PR loop sleeps on the question (no fix attempt lost), `answer` reaches it, and the rerun has the answer in its brief", async () => {
		gh.checks = () => (gh.pushes().length >= 2 ? [PASS] : [FAIL]);
		const { worker, id } = await begin({ "FIX-1": (run) => (run === 1 ? [askUser("Retry the flaky test or delete it?", ["Retry", "Delete"], { recommended: 1 })] : commitFile("fix1.js")) });
		const parked = await driveTo(id, (pr) => pr.phase === "fix 1" && pr.asleep && pr.decisions.length === 1);
		assert.equal(parked.decisions[0].ticketId, "FIX-1");
		assert.equal(parked.decisions[0].key, "decision-FIX-1-1");
		const status = await statusText(runner!, ws.docPath);
		assert.match(status.text, /decision FIX-1: Retry the flaky test or delete it\?/);
		assert.match(status.text, new RegExp(`answer: brigadev-runner answer ${ws.docPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} FIX-1 <1\\.\\.2\\|text>`));
		assert.ok(logLines().some((line) => /FIX-1 blocked: needs you: decision: Retry the flaky test or delete it\?/.test(line)));

		const answered = await answerDecision(runner!, ws.docPath, "FIX-1", "2");
		assert.deepEqual([answered.code, answered.result], [0, "delivered"], answered.text);
		await atMerge(id);
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1", "FIX-1"], "the same fix ticket ran again, not FIX-2");
		assert.match(worker.prompts[2].system, /answer: Delete/);
		assert.match(worker.prompts[2].system, /attempt: 1 of 1/);
		assert.equal((await answerDecision(runner!, ws.docPath, "FIX-1", "1")).result, "duplicate", "a second answer is a final duplicate");
		assert.equal(gh.pushes().length, 2);
	});
});

describe("verify on T2 (A4)", () => {
	it("blockers become a fix ticket whose spec is the blockers, then verify runs again; the push waits for a clean verdict", async () => {
		const blocker = { summary: "login accepts an empty password", reproduction: "node auth-probe.js → prints ok (expected: rejected)" };
		const { worker, id } = await begin({ VERIFY: (run) => [verdict(run === 1 ? [blocker] : [])], "FIX-1": commitFile("fix1.js") }, "auth.js");
		await asleepAt(id, "wait-ci");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "VERIFY", "FIX-1", "VERIFY"]);
		const brief = worker.prompts[2].system;
		assert.match(brief, /login accepts an empty password/);
		assert.match(brief, /reproduction: node auth-probe\.js/);
		assert.match(brief, /failing test first \(RED\)/);
		assert.equal(gh.pushes().length, 1, "pushed once, after the clean second verdict");
		assert.equal(gh.remoteSha(FEATURE_BRANCH), git(ws.repo, "rev-parse", "HEAD"), "the push carries the fix commit");
		assert.ok(logLines().some((line) => /verify round 1: 1 blocker$/.test(line)));
		assert.ok(logLines().some((line) => /verify round 2: clean/.test(line)));
	});

	it("the verify conversation cannot write, edit, commit, change git state, or write inside the worktree; it can read and run probes", async () => {
		const script: Step[] = [
			{ tool: "write", input: { path: "leak.js", content: "1" } },
			bash("git -c user.name=x -c user.email=x@x commit --allow-empty -m verify-commit"),
			bash("echo hi > leaked.js"),
			bash("git checkout -b other"),
			bash("ls"),
			verdict(),
		];
		const { worker, id } = await begin({ VERIFY: script }, "auth.js");
		await asleepAt(id, "wait-ci");
		const results = worker.results.filter((r) => r.ticketId === "VERIFY");
		assert.equal(results[0].isError, true, "no write tool");
		assert.match(results[1].text, /verifier is read-only \(git commit\)/);
		assert.match(results[2].text, /verifier is read-only \(it writes leaked\.js inside the worktree\)/);
		assert.match(results[3].text, /verifier is read-only \(git checkout may change the repository\)/);
		assert.equal(results[4].isError, false, "a read-only probe runs");
		assert.equal(git(ws.repo, "branch", "--show-current"), FEATURE_BRANCH);
		assert.equal(git(ws.repo, "rev-list", "--count", "main..HEAD"), "1", "no commit by the verifier");
		assert.equal(git(ws.repo, "status", "--porcelain"), "");
	});

	it("a run that ends without the verdict tool stops for a person instead of passing", async () => {
		const { id } = await begin({ VERIFY: [bash("ls")] }, "auth.js");
		const stopped = await atStop(id);
		assert.match(stopped.reason ?? "", /ended without a verdict/);
		assert.equal(gh.pushes().length, 0, "nothing was pushed");
	});
});

describe("the merge gate (A5)", () => {
	it("a merge approval while checks are pending, then while the PR is a draft, merges nothing and goes back to CI; the third approval merges", async () => {
		const { id } = await begin({});
		const first = await atMerge(id);
		assert.equal(first.mergeKey, "merge-1");

		gh.checks = () => [PENDING];
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		await until(async () => (await prOf(id))?.phase === "wait-ci" || undefined, "the loop back at CI");
		assert.equal(gh.merges().length, 0);
		assert.ok(logLines().some((line) => /PR #1 not merged: checks are pending/.test(line)));

		gh.checks = () => [PASS];
		gh.prs[0].isDraft = true;
		const second = await atMerge(id);
		assert.equal(second.mergeKey, "merge-2", "a new approval, a new key");
		assert.equal(gh.comments.length, 2, "and a new merge-ready comment");
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		await until(async () => (await prOf(id))?.phase === "wait-ci" || undefined, "the loop back at CI");
		assert.equal(gh.merges().length, 0);
		assert.ok(logLines().some((line) => /PR #1 not merged: it is a draft/.test(line)));

		gh.prs[0].isDraft = false;
		assert.equal((await atMerge(id)).mergeKey, "merge-3");
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		assert.equal((await outcomeOf(id)).result.status, "merged");
		assert.equal(gh.merges().length, 1);
	});

	it("a head that moves between the re-read and `gh pr merge` merges nothing (--match-head-commit) and stops for a person", async () => {
		const { id } = await begin({});
		await atMerge(id);
		gh.before = (command, args) => {
			if (command === "gh" && args[0] === "pr" && args[1] === "merge") pushOther();
		};
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		const stopped = await until(async () => ((await prOf(id))?.phase === "needs-you" ? await prOf(id) : undefined), "needs-you");
		assert.match(stopped!.reason ?? "", /gh pr merge failed: Head branch was modified/);
		assert.equal(gh.prs[0].state, "OPEN", "not merged");
	});

	it("an approval after the head moved merges nothing: results for another head are ignored", async () => {
		const { id } = await begin({});
		await atMerge(id);
		pushOther();
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		await until(async () => (await prOf(id))?.phase === "wait-ci" || undefined, "the loop back at CI");
		assert.ok(logLines().some((line) => /PR #1 not merged: its head moved to [0-9a-f]{7}/.test(line)));
		const before = polls();
		clock.advance(POLL_MS);
		await until(() => polls() > before || undefined, "a poll");
		assert.equal((await prOf(id))?.phase, "wait-ci", "still waiting: the checks seen are for a head that was not pushed by the runner");
		assert.equal(gh.merges().length, 0);
	});

	/** Someone else pushes another commit to the PR's branch. */
	function pushOther(): void {
		const other = mkdtempSync(join(tmpdir(), "brigadev-runner-other-"));
		try {
			execFileSync("git", ["clone", "-q", gh.remote, other]);
			git(other, "checkout", "-q", FEATURE_BRANCH);
			writeFileSync(join(other, "other.js"), "1\n");
			git(other, "add", "-A");
			git(other, "commit", "-q", "-m", "someone else");
			git(other, "push", "-q", "origin", FEATURE_BRANCH);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	}

	it("an approval that does not come in 24 h stops with `merge approval expired`; resume asks again with a new key", async () => {
		const { id } = await begin({});
		await atMerge(id);
		clock.advance(24 * 60 * 60 * 1000 + 1000);
		const stopped = await atStop(id);
		assert.equal(stopped.reason, "merge approval expired");
		assert.equal(gh.merges().length, 0);
		assert.equal(gh.comments.length, 2, "the merge-ready comment, then the needs-you one");
		assert.match(gh.comments[1].body, /^Needs you: merge approval expired/);
		assert.equal((await resumeLoop(runner!, ws.docPath)).result, "delivered");
		assert.equal((await atMerge(id)).mergeKey, "merge-2");
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		assert.equal((await outcomeOf(id)).result.status, "merged");
		assert.equal(gh.merges().length, 1);
	});

	it("`merge` before the PR loop waits for it is refused with where it is", async () => {
		gh.checks = () => [PENDING];
		const { id } = await begin({});
		await asleepAt(id, "wait-ci");
		const early = await mergeLoop(runner!, ws.docPath);
		assert.equal(early.code, 1);
		assert.match(early.text, /not waiting for a merge approval: the PR loop is at wait-ci/);
		assert.equal(gh.merges().length, 0);
	});
});

describe("an existing PR, and nothing to open (A7)", () => {
	it("a PR already open for the branch is used: no `gh pr create`", async () => {
		gh.prs.push({ number: 7, title: "mine", body: "", base: "main", head: FEATURE_BRANCH, state: "OPEN", isDraft: false });
		const { id } = await begin({});
		const parked = await atMerge(id);
		assert.equal(parked.url, "https://github.com/acme/repo/pull/7");
		assert.equal(gh.creates().length, 0);
		assert.equal(gh.comments[0].number, 7);
		assert.equal((await mergeLoop(runner!, ws.docPath)).result, "delivered");
		assert.equal((await outcomeOf(id)).result.number, 7);
		assert.deepEqual(gh.merges().map((args) => args.slice(0, 5)), [["pr", "merge", "7", "--merge", "--match-head-commit"]]);
	});

	it("a branch with no commits ahead of the base stops with needs-you, no PR comment (there is no PR), and a Log line", async () => {
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: done already deps: none done: `true` — done abc1234 (true passed)"]));
		runner = await openFixtureRunner(ws, makeWorker({}), { clock, prDeps: prDepsOf(gh) });
		const id = await runner.start(ws.docPath, { pr: true });
		const stopped = await until(async () => ((pr) => (pr?.phase === "needs-you" && pr.asleep ? pr : undefined))(await prOf(id)), "needs-you");
		assert.equal(stopped.reason, `${FEATURE_BRANCH} has no commits ahead of main: there is nothing to open a PR for`);
		assert.equal(gh.creates().length, 0);
		assert.equal(gh.comments.length, 0);
		assert.ok(logLines().some((line) => /PR loop needs you \(1\): feat\/runner-test has no commits ahead of main/.test(line)));
	});
});

describe("a final-check failure is fixed", () => {
	it("a failing full suite runs a fix ticket (done = the suite command) before anything is pushed", async () => {
		// The suite fails once (the first final check), then runs for real.
		let runs = 0;
		const prDeps: PrDeps = { ...prDepsOf(gh), suite: async (cwd, signal) => (++runs === 1 ? { exitCode: 1, tail: "FAIL: 1 failing (synthetic)" } : prDepsOf(gh).suite(cwd, signal)) };
		const { worker, id } = await begin({ "FIX-1": commitFile("healed.js") }, "app.js", prDeps);
		await asleepAt(id, "wait-ci");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "FIX-1"]);
		assert.match(worker.prompts[1].system, /The final check \(the full suite\) failed with exit 1:\nFAIL: 1 failing \(synthetic\)/);
		assert.match(worker.prompts[1].system, /done command: `true`/, "the suite command of the project");
		assert.equal(gh.pushes().length, 1, "one push, of the fixed head");
	});
});
