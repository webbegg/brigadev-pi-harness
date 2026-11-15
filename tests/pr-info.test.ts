import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { commandChangesPr, createPrTracker, lookupPr, parsePrView, prFooterText, prReport, summarizeChecks, type PrExec, type PrSummary } from "../lib/pr-info.ts";

const view = (extra: Record<string, unknown> = {}) =>
	JSON.stringify({
		number: 42,
		title: "Add the thing",
		state: "OPEN",
		isDraft: false,
		url: "https://github.com/acme/repo/pull/42",
		reviewDecision: "APPROVED",
		statusCheckRollup: [
			{ __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS" },
			{ __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "FAILURE" },
			{ __typename: "CheckRun", name: "e2e", status: "IN_PROGRESS", conclusion: "" },
			{ __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS" },
		],
		...extra,
	});

const ok = (stdout: string) => ({ stdout, stderr: "", code: 0, killed: false });
const fail = (stderr: string, code = 1) => ({ stdout: "", stderr, code, killed: false });

describe("parsePrView", () => {
	it("reads the fields and summarises the checks", () => {
		const pr = parsePrView(view());
		assert.ok(pr);
		assert.equal(pr.number, 42);
		assert.equal(pr.title, "Add the thing");
		assert.equal(pr.state, "OPEN");
		assert.equal(pr.isDraft, false);
		assert.equal(pr.reviewDecision, "APPROVED");
		assert.deepEqual(pr.checks, { passing: 2, failing: 1, pending: 1, total: 4 });
	});

	it("returns undefined for anything that is not a pull request", () => {
		for (const text of ["", "not json", "[]", "null", "{}", JSON.stringify({ number: "x", url: "u" }), JSON.stringify({ number: 3 })]) assert.equal(parsePrView(text), undefined, text);
	});

	it("tolerates missing optional fields", () => {
		const pr = parsePrView(JSON.stringify({ number: 7, url: "https://x/7" }));
		assert.ok(pr);
		assert.equal(pr.title, "");
		assert.equal(pr.state, "OPEN");
		assert.equal(pr.reviewDecision, "");
		assert.deepEqual(pr.checks, { passing: 0, failing: 0, pending: 0, total: 0 });
	});
});

describe("summarizeChecks", () => {
	it("counts neutral and skipped as passing, other conclusions and ERROR/FAILURE as failing, unfinished as pending", () => {
		const checks = summarizeChecks([
			{ status: "COMPLETED", conclusion: "NEUTRAL" },
			{ status: "COMPLETED", conclusion: "SKIPPED" },
			{ status: "COMPLETED", conclusion: "CANCELLED" },
			{ status: "COMPLETED", conclusion: "TIMED_OUT" },
			{ status: "QUEUED" },
			{ state: "PENDING" },
			{ state: "ERROR" },
			{ state: "FAILURE" },
			{ state: "SUCCESS" },
			"junk",
			null,
		]);
		assert.deepEqual(checks, { passing: 3, failing: 4, pending: 2, total: 9 });
	});

	it("is empty for a non-array", () => {
		assert.deepEqual(summarizeChecks(undefined), { passing: 0, failing: 0, pending: 0, total: 0 });
		assert.deepEqual(summarizeChecks({}), { passing: 0, failing: 0, pending: 0, total: 0 });
	});
});

describe("footer text and report", () => {
	const base: PrSummary = { number: 42, title: "Add the thing", state: "OPEN", isDraft: false, url: "https://github.com/acme/repo/pull/42", reviewDecision: "APPROVED", checks: { passing: 2, failing: 1, pending: 1, total: 4 } };

	it("shows `PR #N` for an open pull request and marks the other states", () => {
		assert.equal(prFooterText(base), "PR #42");
		assert.equal(prFooterText({ ...base, isDraft: true }), "PR #42 draft");
		assert.equal(prFooterText({ ...base, state: "MERGED" }), "PR #42 merged");
		assert.equal(prFooterText({ ...base, state: "CLOSED" }), "PR #42 closed");
	});

	it("reports number, title, state, review, checks, and URL", () => {
		const report = prReport(base);
		assert.match(report, /PR #42: Add the thing/);
		assert.match(report, /open/);
		assert.match(report, /approved/i);
		assert.match(report, /2 passing, 1 failing, 1 pending/);
		assert.match(report, /https:\/\/github\.com\/acme\/repo\/pull\/42/);
	});

	it("handles a draft without review or checks", () => {
		const report = prReport({ ...base, isDraft: true, reviewDecision: "", checks: { passing: 0, failing: 0, pending: 0, total: 0 } });
		assert.match(report, /draft/);
		assert.match(report, /no review decision/i);
		assert.match(report, /no checks/i);
	});
});

describe("commandChangesPr", () => {
	it("is true for pushes, branch switches, and PR-changing gh commands", () => {
		for (const command of [
			"git push",
			"git push -u origin feat/x",
			"git -C /tmp/repo push origin main",
			"git switch main",
			"git checkout -b feat/y",
			"git checkout feat/y",
			"cd sub && git push --force-with-lease",
			"sudo -n git push",
			"gh pr create --fill",
			"gh pr checkout 12",
			"gh pr merge 12 --squash",
			"FOO=1 git switch -c z",
		]) assert.equal(commandChangesPr(command), true, command);
	});

	it("is false for everything else", () => {
		for (const command of ["git status", "git log --oneline", "git commit -m push", "echo git push", "npm test", "gh pr view", "gh pr list", "ls", "git diff main", "git stash push"]) {
			assert.equal(commandChangesPr(command), false, command);
		}
	});
});

describe("lookupPr", () => {
	it("calls gh pr view with the JSON fields, the cwd, and a bounded timeout", async () => {
		const calls: Array<{ command: string; args: string[]; options: { cwd?: string; timeout?: number } }> = [];
		const exec: PrExec = async (command, args, options) => {
			calls.push({ command, args, options });
			return ok(view());
		};
		const result = await lookupPr(exec, "/repo", 10_000);
		assert.equal(result.status, "found");
		assert.equal(calls.length, 1);
		assert.equal(calls[0].command, "gh");
		assert.deepEqual(calls[0].args, ["pr", "view", "--json", "number,title,state,isDraft,url,reviewDecision,statusCheckRollup"]);
		assert.equal(calls[0].options.cwd, "/repo");
		assert.equal(calls[0].options.timeout, 10_000);
	});

	it("tells no PR apart from an unavailable gh", async () => {
		assert.deepEqual(await lookupPr(async () => fail('no pull requests found for branch "feat/x"'), "/r"), { status: "none" });
		for (const exec of [
			async () => fail("gh: command not found", 127),
			async () => fail("To get started with GitHub CLI, please run:  gh auth login", 4),
			async () => fail("error connecting to api.github.com"),
			async () => ({ stdout: "", stderr: "", code: 0, killed: true }),
			async () => ok("not json"),
			async () => {
				throw new Error("spawn gh ENOENT");
			},
		] as PrExec[]) assert.deepEqual(await lookupPr(exec, "/r"), { status: "unavailable" });
	});

	it("gives up when exec never answers", async () => {
		const started = Date.now();
		const result = await lookupPr(() => new Promise(() => {}), "/r", 30);
		assert.deepEqual(result, { status: "unavailable" });
		assert.ok(Date.now() - started < 2000);
	});
});

describe("createPrTracker", () => {
	const gate = () => {
		let release!: () => void;
		const promise = new Promise<void>((resolve) => (release = resolve));
		return { promise, release };
	};

	it("publishes the footer text when a PR is found and clears it when there is none", async () => {
		const texts: Array<string | undefined> = [];
		let answer = ok(view());
		const tracker = createPrTracker({ exec: async () => answer, onChange: (text) => texts.push(text) });
		assert.equal((await tracker.refresh("/r")).status, "found");
		assert.equal(tracker.current()?.number, 42);
		answer = fail('no pull requests found for branch "x"');
		assert.equal((await tracker.refresh("/r")).status, "none");
		assert.equal(tracker.current(), undefined);
		assert.deepEqual(texts, ["PR #42", undefined]);
	});

	it("keeps the last known PR when a lookup is unavailable, and clears it only on `none`", async () => {
		const texts: Array<string | undefined> = [];
		let answer: Awaited<ReturnType<PrExec>> = ok(view());
		const tracker = createPrTracker({ exec: async () => answer, onChange: (text) => texts.push(text) });
		await tracker.refresh("/r");
		for (const transient of [fail("gh: command not found", 127), fail("error connecting to api.github.com"), ok("not json"), { stdout: "", stderr: "", code: null, killed: true }]) {
			answer = transient;
			assert.equal((await tracker.refresh("/r")).status, "unavailable");
			assert.equal(tracker.current()?.number, 42);
		}
		assert.deepEqual(texts, ["PR #42"]);
		answer = fail('no pull requests found for branch "x"');
		assert.equal((await tracker.refresh("/r")).status, "none");
		assert.equal(tracker.current(), undefined);
		assert.deepEqual(texts, ["PR #42", undefined]);
		// with nothing known, an unavailable lookup shows nothing
		answer = fail("gh: command not found", 127);
		await tracker.refresh("/r");
		assert.equal(tracker.current(), undefined);
	});

	it("a reset forgets the PR even when the next lookup is unavailable", async () => {
		let answer = ok(view());
		const tracker = createPrTracker({ exec: async () => answer, onChange: () => {} });
		await tracker.refresh("/r");
		tracker.reset();
		answer = fail("gh: command not found", 127);
		await tracker.refresh("/r");
		assert.equal(tracker.current(), undefined);
	});

	it("does not republish an unchanged footer text", async () => {
		const texts: Array<string | undefined> = [];
		const tracker = createPrTracker({ exec: async () => ok(view()), onChange: (text) => texts.push(text) });
		await tracker.refresh("/r");
		await tracker.refresh("/r");
		assert.deepEqual(texts, ["PR #42"]);
	});

	it("ignores a slow answer that was overtaken by a newer refresh", async () => {
		const slow = gate();
		const texts: Array<string | undefined> = [];
		let calls = 0;
		const exec: PrExec = async () => {
			calls += 1;
			if (calls === 1) {
				await slow.promise;
				return ok(view({ number: 1 }));
			}
			return ok(view({ number: 2 }));
		};
		const tracker = createPrTracker({ exec, onChange: (text) => texts.push(text) });
		const first = tracker.refresh("/r");
		await tracker.refresh("/r");
		slow.release();
		await first;
		assert.equal(tracker.current()?.number, 2);
		assert.deepEqual(texts, ["PR #2"]);
	});

	it("ignores an answer that arrives after reset", async () => {
		const slow = gate();
		const texts: Array<string | undefined> = [];
		const tracker = createPrTracker({
			exec: async () => {
				await slow.promise;
				return ok(view());
			},
			onChange: (text) => texts.push(text),
		});
		const pending = tracker.refresh("/r");
		tracker.reset();
		slow.release();
		await pending;
		assert.equal(tracker.current(), undefined);
		assert.deepEqual(texts, []);
	});

	it("never rejects", async () => {
		const tracker = createPrTracker({
			exec: async () => {
				throw new Error("boom");
			},
			onChange: () => {
				throw new Error("render failed");
			},
		});
		assert.deepEqual(await tracker.refresh("/r"), { status: "unavailable" });
	});
});

describe("extensions/pr-info.ts", () => {
	const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

	const load = async (env: Record<string, string | undefined> = {}) => {
		const saved = { ...process.env };
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		Object.assign(process.env, env);
		try {
			const extension = (await import("../extensions/pr-info.ts")).default;
			const pi = createFakePi();
			const calls: Array<{ command: string; args: string[]; options: any }> = [];
			let answer: Awaited<ReturnType<PrExec>> | Promise<Awaited<ReturnType<PrExec>>> = ok(view());
			pi.exec = (async (command: string, args: string[], options: unknown) => {
				calls.push({ command, args, options });
				return answer;
			}) as typeof pi.exec;
			extension(pi);
			const ctx = createFakeCtx({ cwd: "/work/proj" });
			return { pi, ctx, calls, answer: (value: typeof answer) => (answer = value) };
		} finally {
			for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
			Object.assign(process.env, saved);
		}
	};

	const footer = (ctx: { statuses: Array<{ key: string; text: string | undefined }> }) => ctx.statuses.filter((s) => s.key === "brigadev-pr").at(-1)?.text;

	it("is inert in a child session", async () => {
		const { pi } = await load({ BRIGADEV_CHILD: "1" });
		assert.equal(pi.commands.size, 0);
		assert.equal(pi.handlers.size, 0);
	});

	it("looks the PR up at session start without blocking and publishes the footer segment", async () => {
		let release!: () => void;
		const slow = new Promise<Awaited<ReturnType<PrExec>>>((resolve) => (release = () => resolve(ok(view()))));
		const { pi, ctx, calls, answer } = await load();
		answer(slow);
		await pi.fire("session_start", {}, ctx);
		assert.equal(footer(ctx), undefined);
		assert.equal(calls.length, 1);
		assert.deepEqual(calls[0].args.slice(0, 2), ["pr", "view"]);
		assert.equal(calls[0].options.cwd, "/work/proj");
		assert.ok(calls[0].options.timeout > 0 && calls[0].options.timeout <= 10_000);
		release();
		await flush();
		assert.equal(footer(ctx), "PR #42");
	});

	it("stays silent when gh is unavailable or there is no PR", async () => {
		for (const reply of [fail("gh: command not found", 127), fail("no pull requests found for branch x"), ok("nope")]) {
			const { pi, ctx, answer } = await load();
			answer(reply);
			await pi.fire("session_start", {}, ctx);
			await flush();
			assert.equal(footer(ctx), undefined);
			assert.deepEqual(ctx.notifications, []);
		}
	});

	it("refreshes after a bash command that pushes or switches branches, and only then", async () => {
		const { pi, ctx, calls } = await load();
		const result = (command: string, toolName = "bash") => pi.fire("tool_result", { toolName, toolCallId: "t", input: { command }, content: [], isError: false }, ctx);
		await result("npm test");
		await result("git status");
		await result("git push", "read");
		assert.equal(calls.length, 0);
		await result("git push -u origin feat/x");
		await result("git switch main");
		await flush();
		assert.equal(calls.length, 2);
		assert.equal(footer(ctx), "PR #42");
	});

	it("drops a slow answer from before a branch switch", async () => {
		let releaseSlow!: () => void;
		const slow = new Promise<Awaited<ReturnType<PrExec>>>((resolve) => (releaseSlow = () => resolve(ok(view({ number: 1 })))));
		const { pi, ctx, answer } = await load();
		answer(slow);
		await pi.fire("session_start", {}, ctx);
		answer(ok(view({ number: 2 })));
		await pi.fire("tool_result", { toolName: "bash", toolCallId: "t", input: { command: "git checkout feat/two" } }, ctx);
		await flush();
		releaseSlow();
		await flush();
		assert.equal(footer(ctx), "PR #2");
	});

	it("/brigadev:pr reports the PR, says when there is none, and warns when gh is unavailable", async () => {
		const { pi, ctx, answer } = await load();
		const command = pi.commands.get("brigadev:pr");
		assert.ok(command);
		await command.handler("", ctx);
		assert.equal(ctx.notifications.at(-1)?.type, "info");
		assert.match(ctx.notifications.at(-1)!.message, /PR #42: Add the thing[\s\S]*https:\/\/github\.com\/acme\/repo\/pull\/42/);
		assert.equal(footer(ctx), "PR #42");

		answer(fail('no pull requests found for branch "x"'));
		await command.handler("", ctx);
		assert.deepEqual(ctx.notifications.at(-1), { message: "No pull request for the current branch.", type: "info" });
		assert.equal(footer(ctx), undefined);

		answer(fail("gh: command not found", 127));
		await command.handler("", ctx);
		assert.equal(ctx.notifications.at(-1)?.type, "warning");
	});

	it("ignores an answer that arrives after the session shut down", async () => {
		let release!: () => void;
		const slow = new Promise<Awaited<ReturnType<PrExec>>>((resolve) => (release = () => resolve(ok(view()))));
		const { pi, ctx, answer } = await load();
		answer(slow);
		await pi.fire("session_start", {}, ctx);
		await pi.fire("session_shutdown", {}, ctx);
		release();
		await flush();
		assert.equal(footer(ctx), undefined);
	});
});
