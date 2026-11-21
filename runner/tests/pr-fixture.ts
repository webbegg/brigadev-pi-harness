// Fixtures of the PR loop tests (T6): a local bare git remote (real `git push`), a fake `gh` that keeps its own PRs, comments and merges,
// and the helpers that read where the PR loop is. Only `gh` is faked; git is real, against `<root>/remote.git`.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PrExec } from "../../lib/pr-info.ts";
import { nodeExec } from "../src/exec.ts";
import { defaultPrDeps, type PrDeps } from "../src/pr.ts";
import type { LoopStatus } from "../src/runner.ts";
import { git, type FixtureRunner, type Step, type Workspace } from "./fixture.ts";

/** A bare remote named `origin` with `main` pushed (and `origin/HEAD` set), so the default branch and the base are known. */
export function addRemote(ws: Workspace): string {
	const remote = join(ws.root, "remote.git");
	execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
	git(ws.repo, "remote", "add", "origin", remote);
	git(ws.repo, "push", "-q", "origin", "main");
	git(ws.repo, "remote", "set-head", "origin", "main");
	return remote;
}

export const RUN = "https://github.com/acme/repo/actions/runs";
export const PASS = { name: "test", status: "COMPLETED", conclusion: "SUCCESS", detailsUrl: `${RUN}/100/job/1` };
export const PENDING = { name: "test", status: "IN_PROGRESS", conclusion: "", detailsUrl: `${RUN}/100/job/1` };
export const FAIL = { name: "test", status: "COMPLETED", conclusion: "FAILURE", detailsUrl: `${RUN}/101/job/2` };

export interface FakePr {
	number: number;
	title: string;
	body: string;
	base: string;
	head: string;
	state: "OPEN" | "CLOSED" | "MERGED";
	isDraft: boolean;
}

/** `gh` as the PR loop calls it: `pr view|create|comment|merge`, `run view --log-failed`; every call is recorded. git passes through to the real one. */
export class FakeGh {
	prs: FakePr[] = [];
	comments: Array<{ number: number; body: string }> = [];
	/** Every `gh` call's arguments, and every `git` call's. */
	ghCalls: string[][] = [];
	gitCalls: string[][] = [];
	/** The checks a PR shows for its head sha (default: one passing check). */
	checks: (sha: string) => unknown[] = () => [PASS];
	logs: Record<string, string> = { "101": "FAIL: expected 1, got 2\n  at suite.test" };
	/** Runs around each command, to interrupt it (crash tests) or to change the world (a draft, a moved head). */
	before?: (command: string, args: string[]) => Promise<void> | void;
	after?: (command: string, args: string[]) => Promise<void> | void;

	remote: string;
	constructor(remote: string) {
		this.remote = remote;
	}

	pushes = () => this.gitCalls.filter((args) => args[0] === "push");
	ghOf = (group: string, verb: string) => this.ghCalls.filter((args) => args[0] === group && args[1] === verb);
	creates = () => this.ghOf("pr", "create");
	merges = () => this.ghOf("pr", "merge");
	/** The sha the remote branch is at. */
	remoteSha = (branch: string): string | undefined => {
		try {
			return execFileSync("git", ["--git-dir", this.remote, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { encoding: "utf8" }).trim();
		} catch {
			return undefined;
		}
	};

	readonly exec: PrExec = async (command, args, options) => {
		if (command !== "gh") {
			this.gitCalls.push(args);
			await this.before?.(command, args);
			const result = await nodeExec(command, args, { cwd: options.cwd ?? ".", timeout: options.timeout ?? 60_000 });
			await this.after?.(command, args);
			return result;
		}
		this.ghCalls.push(args);
		await this.before?.(command, args);
		const result = this.gh(args, options.cwd ?? ".");
		await this.after?.(command, args);
		return result;
	};

	private view(pr: FakePr, fields: string[]): string {
		const sha = this.remoteSha(pr.head) ?? "";
		const all: Record<string, unknown> = {
			number: pr.number,
			title: pr.title,
			state: pr.state,
			isDraft: pr.isDraft,
			url: `https://github.com/acme/repo/pull/${pr.number}`,
			reviewDecision: "",
			headRefOid: sha,
			statusCheckRollup: this.checks(sha),
		};
		return JSON.stringify(Object.fromEntries(fields.map((field) => [field, all[field]])));
	}

	private gh(args: string[], cwd: string) {
		const [group, verb, ...rest] = args;
		const flag = (name: string) => rest[rest.indexOf(name) + 1];
		const ok = (stdout: string) => ({ stdout, stderr: "", code: 0 });
		const fail = (stderr: string) => ({ stdout: "", stderr, code: 1 });
		const numbered = /^\d+$/.test(rest[0] ?? "") ? this.prs.find((pr) => pr.number === Number(rest[0])) : undefined;
		if (group === "pr" && verb === "view") {
			const branch = git(cwd, "symbolic-ref", "--short", "HEAD");
			const pr = /^\d+$/.test(rest[0] ?? "") ? numbered : [...this.prs].reverse().find((candidate) => candidate.head === branch);
			if (!pr) return fail(`no pull requests found for branch "${branch}"`);
			return ok(this.view(pr, flag("--json").split(",")));
		}
		if (group === "pr" && verb === "create") {
			const head = flag("--head");
			if (this.remoteSha(head) === undefined) return fail(`pull request create failed: head branch "${head}" is not on the remote`);
			const pr: FakePr = { number: this.prs.length + 1, title: flag("--title"), body: readFileSync(flag("--body-file"), "utf8"), base: flag("--base"), head, state: "OPEN", isDraft: false };
			this.prs.push(pr);
			return ok(`https://github.com/acme/repo/pull/${pr.number}\n`);
		}
		if (group === "pr" && verb === "comment") {
			if (!numbered) return fail("no such pull request");
			this.comments.push({ number: numbered.number, body: readFileSync(flag("--body-file"), "utf8") });
			return ok("");
		}
		if (group === "pr" && verb === "merge") {
			if (!numbered || numbered.state !== "OPEN") return fail("Pull request is not mergeable");
			// As GitHub: with --match-head-commit, a head that moved since refuses the merge.
			const match = args.indexOf("--match-head-commit");
			if (match >= 0 && args[match + 1] !== this.remoteSha(numbered.head)) return fail("Head branch was modified. Review and try the merge again.");
			numbered.state = "MERGED";
			return ok("Merged\n");
		}
		if (group === "run" && verb === "view") return ok(this.logs[rest[0]] ?? "");
		return fail(`fake gh: unsupported ${args.join(" ")}`);
	}
}

/** The PR loop's seam over a fake gh: its exec, the real suite (the fixture's `check.test`). */
export const prDepsOf = (gh: FakeGh): PrDeps => ({ ...defaultPrDeps, exec: gh.exec });

/** Poll `read` until it returns a value; the PR loop runs in background tasks. */
export async function until<T>(read: () => Promise<T | undefined | false> | T | undefined | false, what: string, timeoutMs = 120_000): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await read();
		if (value !== undefined && value !== false) return value as T;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

type Id = Parameters<FixtureRunner["status"]>[0];
type PrStatus = NonNullable<LoopStatus["pr"]>;

/**
 * Readers of where the PR loop is, over whichever runner `current()` returns (a crash test reopens), and a driver for the fake clock: whenever the
 * PR loop sleeps between CI polls, let one poll interval pass.
 */
export function drivers(current: () => FixtureRunner, gh: FakeGh, clock: { advance(ms: number): void }, pollMs: number) {
	const polls = () => gh.ghCalls.filter((args) => args[0] === "pr" && args[1] === "view" && /^\d+$/.test(args[2] ?? "")).length;
	const prOf = async (id: Id) => (await current().status(id)).pr;
	const asleepAt = (id: Id, phase: string) => until(async () => ((pr) => (pr?.phase === phase && pr.asleep ? pr : undefined))(await prOf(id)), `the PR loop asleep at ${phase}`);
	const driveTo = (id: Id, done: (pr: PrStatus) => boolean) =>
		until(async () => {
			const pr = await prOf(id);
			if (pr && done(pr)) return pr;
			if (pr?.phase === "wait-ci" && pr.asleep) {
				const before = polls();
				clock.advance(pollMs);
				await until(() => polls() > before || undefined, "a poll");
			}
			return undefined;
		}, "the PR loop to reach the wanted state");
	return {
		polls,
		prOf,
		asleepAt,
		driveTo,
		atMerge: (id: Id) => driveTo(id, (pr) => pr.phase === "wait-merge" && pr.asleep),
		atStop: (id: Id) => driveTo(id, (pr) => pr.phase === "needs-you" && pr.asleep && pr.resumeKey !== undefined),
	};
}

/** Make the next matching git/gh command hang once it has run (before: instead of running): the test then closes the Harness, as a kill would. Resolves when it was hit. */
export function hangOnce(gh: FakeGh, when: "before" | "after", match: (command: string, args: string[]) => boolean): Promise<void> {
	let armed = true;
	let reached!: () => void;
	const hit = new Promise<void>((resolve) => (reached = resolve));
	gh[when] = async (command, args) => {
		if (!armed || !match(command, args)) return;
		armed = false;
		reached();
		await new Promise(() => {});
	};
	return hit;
}

/** The verdict a scripted verify conversation returns. */
export function verdict(blockers: Array<{ summary: string; reproduction: string }> = []): Step {
	return {
		tool: "verify_verdict",
		input: { verdicts: [{ spec: "S1", verdict: blockers.length > 0 ? "unmet" : "met", evidence: "ran the probes" }], blockers, advisories: [], regressionTests: [], scratch: [], unverified: [] },
	};
}
