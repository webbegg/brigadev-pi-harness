// B2/B3 (the detective layer): what a worker or the verifier must not change is snapshotted before its conversation and compared after it, before the done
// check or the verdict is trusted. Any change but the feature branch moving parks the loop (the ticket loop's pause, or the PR loop's needs-you) with the list.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import { parseTicketList } from "../../lib/ticket-list.ts";
import { resumeLoop } from "../src/control.ts";
import { nodeExec } from "../src/exec.ts";
import { compareIntegrity, hashText, takeIntegrity, type Integrity } from "../src/integrity.ts";
import { POLL_MS } from "../src/pr.ts";
import { bash, commitFile, docText, fakeClock, FEATURE_BRANCH, git, isolateEnv, makeWorker, makeWorkspace, openFixtureRunner, readDoc, ticketLine, writeFile, type FixtureRunner, type Isolation, type Step, type Workspace } from "./fixture.ts";
import { addRemote, drivers, FakeGh, prDepsOf, until, verdict } from "./pr-fixture.ts";

let isolation: Isolation;
before(() => {
	isolation = isolateEnv();
});
after(() => isolation.restore());

let ws: Workspace;
let gh: FakeGh;
let clock: ReturnType<typeof fakeClock>;
let runner: FixtureRunner | undefined;
beforeEach(() => {
	isolation.settings({ check: { test: "true" } });
	rmSync(isolation.brigadevHome, { recursive: true, force: true });
	ws = makeWorkspace();
	clock = fakeClock();
});
afterEach(async () => {
	const reports = runner?.reports ?? [];
	await runner?.close();
	runner = undefined;
	ws.cleanup();
	assert.deepEqual(reports.map((report) => `${report.kind}: ${(report.error as Error)?.message}`), [], "the Harness reported no faults");
});

const T1 = "- T1 [S1] inline: first deps: none done: `test -f t1.txt` — pending";
const statuses = () => Object.fromEntries(parseTicketList(readDoc(ws)).tickets.map((t) => [t.id, t.status]));
const PARKED = (what: string) => new RegExp(`^the worker changed ${what}; check them, then resume$`);

/** A script file the guard cannot read, then the run of it: the guard sees `sh x.sh`, never what is in it. */
const script = (body: string, name = "x.sh"): Step[] => [writeFile(name, body), bash(`sh ${name}`)];

async function parked(worker: ReturnType<typeof makeWorker>, options: { prDeps?: ReturnType<typeof prDepsOf> } = {}) {
	writeFileSync(ws.docPath, docText([T1]));
	runner = await openFixtureRunner(ws, worker, { prDeps: options.prDeps, clock });
	const id = await runner.start(ws.docPath);
	return { id, outcome: await runner.settle(id) };
}

describe("takeIntegrity and compareIntegrity", () => {
	const docPath = () => ws.docPath;
	const snap = (previous?: Integrity) => takeIntegrity(ws.repo, nodeExec, { docPath: docPath(), previous });

	it("sees nothing change while only the feature branch moves (commits on it)", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const before = await snap();
		git(ws.repo, "commit", "-q", "--allow-empty", "-m", "work");
		const after = await snap(before);
		assert.notEqual(before.head.sha, after.head.sha);
		assert.deepEqual(compareIntegrity(before, after, { featureBranch: FEATURE_BRANCH }), []);
		assert.deepEqual(compareIntegrity(before, after, {}), ["HEAD", `refs/heads/${FEATURE_BRANCH}`], "for the verifier nothing may move");
	});

	it("lists each thing that changed by name: document, brigadev.json, config, a hook, a ref, a tag, HEAD, the remote", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const remote = addRemote(ws);
		const before = await snap();
		assert.ok(before.remote?.["refs/heads/main"], "the remote's refs are read");

		writeFileSync(ws.docPath, `${readDoc(ws)}\nmore\n`);
		writeFileSync(join(isolation.agentDir, "brigadev.json"), "{}");
		git(ws.repo, "config", "alias.x", "status");
		mkdirSync(join(ws.repo, ".git", "hooks"), { recursive: true });
		writeFileSync(join(ws.repo, ".git", "hooks", "pre-push"), "#!/bin/sh\n");
		git(ws.repo, "branch", "other");
		git(ws.repo, "tag", "v1");
		git(ws.repo, "checkout", "-q", "other");
		git(ws.repo, "push", "-q", remote, "other:refs/heads/x");
		const after = await snap();
		assert.deepEqual(compareIntegrity(before, after, { featureBranch: FEATURE_BRANCH }), [
			"the feature document",
			"brigadev.json",
			"git config",
			"git hook pre-push",
			"HEAD (refs/heads/feat/runner-test to refs/heads/other)",
			"refs/heads/other",
			"refs/tags/v1",
			"origin refs/heads/x",
		]);
	});

	it("allows a document the runner wrote itself", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const before = await snap();
		const written = `${readDoc(ws)}- L2 (2026-11-20): runner\n`;
		writeFileSync(ws.docPath, written);
		const after = await snap();
		assert.deepEqual(compareIntegrity(before, after, { featureBranch: FEATURE_BRANCH }), ["the feature document"]);
		assert.deepEqual(compareIntegrity(before, after, { featureBranch: FEATURE_BRANCH, ownDocHashes: [hashText(written)] }), []);
	});

	it("does not ask the remote once the config changed (a changed config could point ls-remote at the agent's program); the change is reported on its own", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		addRemote(ws);
		const before = await snap();
		git(ws.repo, "config", "remote.origin.uploadpack", "/tmp/evil");
		const after = await snap(before);
		assert.equal(after.remote, undefined);
		assert.deepEqual(compareIntegrity(before, after, { featureBranch: FEATURE_BRANCH }), ["git config"]);
	});

	it("an absent remote is skipped, a worktree-less directory snapshots without throwing", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		assert.equal((await snap()).remote, undefined);
		const none = await takeIntegrity(ws.root, nodeExec, { docPath: ws.docPath });
		assert.deepEqual(none.refs, {});
	});

	it("runs no hook and no fsmonitor program of the repository", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const marker = join(ws.root, "FSMONITOR_RAN");
		const program = join(ws.root, "fsmonitor.sh");
		writeFileSync(program, `#!/bin/sh\ntouch ${marker}\n`);
		chmodSync(program, 0o755);
		git(ws.repo, "config", "core.fsmonitor", program);
		await snap();
		assert.ok(!existsSync(marker), "fsmonitor must not run");
	});
});

describe("the ticket loop parks when the worker changed what it must not (B2, B3)", () => {
	it("B2 repro: a worker that injects a ticket whose done command touches PWNED parks the loop; PWNED is never created", async () => {
		const inject = `const fs = require("fs");\nconst p = ${JSON.stringify(ws.docPath)};\nfs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("## Log", ${JSON.stringify(`- T9 [S2] inline: evil deps: none done: \`touch ${ws.root}/PWNED\` — pending\n\n## Log`)}));\n`;
		const worker = makeWorker({ T1: [writeFile("inject.js", inject), bash("node inject.js"), ...commitFile("t1.txt")] });
		const { outcome } = await parked(worker);
		assert.deepEqual(outcome, { status: "waiting", paused: "the worker changed the feature document; check them, then resume", decisions: [] });
		assert.ok(!existsSync(join(ws.root, "PWNED")), "the injected done command never ran");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1"], "T9 was not picked");
		assert.ok(readDoc(ws).includes("- T9 [S2] inline: evil"), "the doc is left as it is for the user to read");
		assert.match(ticketLine(readDoc(ws), "T1"), /— in_progress needs you: the worker changed the feature document/);
		assert.match(readDoc(ws).split("## Log\n")[1], /T1 needs you: the worker changed the feature document; check them, then resume/);
		assert.equal(statuses().T1, "in_progress");
	});

	it("a worker that rewrites brigadev.json parks the loop, and the pinned settings are still the ones used (the check tool ran `true`, not the injected command)", async () => {
		const rewrite = `require("fs").writeFileSync(${JSON.stringify(join(isolation.agentDir, "brigadev.json"))}, JSON.stringify({ defaultMode: "yolo", check: { test: ${JSON.stringify(`touch ${ws.root}/PWNED2`)} } }));\n`;
		const worker = makeWorker({ T1: [writeFile("rewrite.js", rewrite), bash("node rewrite.js"), ...commitFile("t1.txt")] });
		const { outcome } = await parked(worker);
		assert.deepEqual(outcome, { status: "waiting", paused: "the worker changed brigadev.json; check them, then resume", decisions: [] });
		assert.ok(!existsSync(join(ws.root, "PWNED2")), "the rewritten check.test never ran: settings are pinned when the runner opens");
		const checkResult = worker.results.find((result) => /PASS|passed/i.test(result.text));
		assert.ok(checkResult && !checkResult.isError, `the worker's check tool ran the pinned command: ${JSON.stringify(worker.results.map((r) => r.text.slice(0, 80)))}`);
	});

	it("a worker that plants .git/hooks/pre-push parks the loop", async () => {
		const plant = `printf '#!/bin/sh\\ntouch ${ws.root}/HOOKRAN\\n' > ${ws.repo}/.git/hooks/pre-push\nchmod +x ${ws.repo}/.git/hooks/pre-push\n`;
		const worker = makeWorker({ T1: [...script(plant), ...commitFile("t1.txt")] });
		const { outcome } = await parked(worker);
		assert.deepEqual(outcome, { status: "waiting", paused: "the worker changed git hook pre-push; check them, then resume", decisions: [] });
		assert.ok(!existsSync(join(ws.root, "HOOKRAN")));
	});

	it("`git -c alias.c=commit c` is blocked, and a forged commit on main by a script the guard cannot read parks with refs/heads/main listed; resume accepts the state and finishes", async () => {
		const forge = `cd ${ws.repo}\ngit commit -q --allow-empty -m forged\ngit update-ref refs/heads/main HEAD\n`;
		const worker = makeWorker({
			T1: (run) => (run === 1 ? [bash("git -c alias.c=commit c --allow-empty -m forged"), ...script(forge), ...commitFile("t1.txt")] : []),
		});
		const mainBefore = git(ws.repo, "rev-parse", "main");
		const { id, outcome } = await parked(worker);
		assert.deepEqual(outcome, { status: "waiting", paused: "the worker changed refs/heads/main; check them, then resume", decisions: [] });
		assert.match(worker.results[0].text, /Blocked by brigadev guard: git -c/);
		assert.equal(worker.results[0].isError, true);
		assert.notEqual(git(ws.repo, "rev-parse", "main"), mainBefore, "main did move: the check is detective, it does not undo");

		// `resume` accepts the state: the ticket runs again from the commit it started at, a fresh snapshot is taken, and the done check passes.
		const resumed = await resumeLoop(runner!, ws.docPath);
		assert.deepEqual([resumed.code, resumed.result], [0, "delivered"], resumed.text);
		assert.deepEqual(await runner!.settle(id), { status: "completed", result: { status: "done", tickets: [{ id: "T1", status: "done" }] } });
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T1"]);
		assert.equal(statuses().T1, "done");
	});

	it("a worker that pushes to the remote by a script parks with the origin ref listed (the push happened; the check is detective)", async () => {
		gh = new FakeGh(addRemote(ws));
		const worker = makeWorker({ T1: [...script(`cd ${ws.repo}\ngit push -q origin HEAD:refs/heads/x\n`), ...commitFile("t1.txt")] });
		const { outcome } = await parked(worker);
		assert.deepEqual(outcome, { status: "waiting", paused: "the worker changed origin refs/heads/x; check them, then resume", decisions: [] });
		assert.ok(gh.remoteSha("x"), "the branch is on the remote");
	});
});

describe("the PR loop stops for a person on the same findings (B2, R1-001)", () => {
	const REPO = () => ws.repo;
	async function begin(scripts: Parameters<typeof makeWorker>[0], file = "auth.js") {
		gh = new FakeGh(addRemote(ws));
		writeFileSync(ws.docPath, docText([`- T1 [S1] inline: ${file.replace(/\.js$/, "")} deps: none done: \`test -f ${file}\` — pending`]));
		const worker = makeWorker({ T1: commitFile(file), ...scripts });
		runner = await openFixtureRunner(ws, worker, { clock, prDeps: prDepsOf(gh) });
		const id = await runner.start(ws.docPath, { pr: true });
		return { worker, id, drive: drivers(() => runner!, gh, clock, POLL_MS) };
	}

	it("a verifier that moves a ref by a script outside the worktree stops the PR loop with the ref listed; nothing is pushed", async () => {
		// The verifier may not run `sh script` (an opaque shell) but may run a node script file it wrote outside the worktree: the guard cannot read what is in it.
		const outside = join(ws.root, "v.js");
		const { id, drive } = await begin({ VERIFY: [bash(`printf '%s\\n' 'require("child_process").execSync("git -C ${REPO()} update-ref refs/heads/other HEAD")' > ${outside}`), bash(`node ${outside}`), verdict()] });
		const stopped = await drive.atStop(id);
		assert.equal(stopped.reason, "the verifier changed refs/heads/other; check them, then resume");
		assert.equal(gh.pushes().length, 0);
	});

	it("a verifier that edits a file that was already dirty is caught by the worktree's content, not by HEAD and `git status`", async () => {
		const outside = join(ws.root, "v.js");
		const { id, drive } = await begin({
			T1: [...commitFile("auth.js"), bash("echo a > dirty.txt")],
			VERIFY: [bash(`printf '%s\\n' 'require("fs").appendFileSync("${REPO()}/dirty.txt", "b\\n")' > ${outside}`), bash(`node ${outside}`), verdict()],
		});
		const stopped = await drive.atStop(id);
		assert.match(stopped.reason ?? "", /^the verify run changed the worktree/);
		assert.equal(git(ws.repo, "status", "--porcelain"), "?? dirty.txt", "git status alone shows the same before and after");
		assert.equal(gh.pushes().length, 0);
	});

	it("the runner's push runs no hook of the repository (a planted pre-push never runs), also after the user accepted the state with resume", async () => {
		const plant = `printf '#!/bin/sh\\ntouch ${ws.root}/HOOKRAN\\n' > ${ws.repo}/.git/hooks/pre-push\nchmod +x ${ws.repo}/.git/hooks/pre-push\n`;
		const { worker, id, drive } = await begin({ T1: (run) => (run === 1 ? [...script(plant), ...commitFile("app.js")] : []) }, "app.js");
		await until(async () => ((await runner!.status(id)).state === "paused" ? true : undefined), "the loop paused on the planted hook");
		assert.equal((await runner!.status(id)).reason, "the worker changed git hook pre-push; check them, then resume");
		assert.equal((await resumeLoop(runner!, ws.docPath)).code, 0);
		await drive.atMerge(id);
		assert.equal(gh.pushes().length, 1, "the branch was pushed");
		assert.ok(!existsSync(join(ws.root, "HOOKRAN")), "the pre-push hook did not run");
		assert.deepEqual(worker.prompts.map((p) => p.ticketId), ["T1", "T1"]);
	});

	it("a fix worker that changes a ref stops the PR loop; resume starts again at the final check", async () => {
		gh = new FakeGh(addRemote(ws));
		let pushed = 0;
		gh.checks = () => (gh.pushes().length >= 2 ? [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: "" }] : [{ name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: "https://github.com/acme/repo/actions/runs/101/job/2" }]);
		writeFileSync(ws.docPath, docText(["- T1 [S1] inline: app deps: none done: `test -f app.js` — pending"]));
		const fix: Step[] = [...script(`cd ${ws.repo}\ngit branch sneaky HEAD\n`), ...commitFile("fix.js")];
		const worker = makeWorker({ T1: commitFile("app.js"), "FIX-1": fix });
		runner = await openFixtureRunner(ws, worker, { clock, prDeps: prDepsOf(gh) });
		const id = await runner.start(ws.docPath, { pr: true });
		const drive = drivers(() => runner!, gh, clock, POLL_MS);
		const stopped = await drive.atStop(id);
		pushed = gh.pushes().length;
		assert.equal(stopped.reason, "FIX-1: the worker changed refs/heads/sneaky; check them, then resume");
		assert.equal(pushed, 1, "the fix was not pushed");
	});
});
