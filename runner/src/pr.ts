// `brigadev.pr-loop` (S2b, S3, S4): the last phase of the ticket loop, as a child task of it.
//
//   start → check (the full suite, evidence as the runner) → verify (T2 only: a read-only conversation) → push → open → wait-ci ⇄ poll
//         → ready (one comment) → merge (parked on `brigadev.merge`) → done (merged)
//   a failure (suite, verify blockers, CI) → fix (a `brigadev.ticket` child with a synthetic ticket FIX-n) → verify | push
//   any stop (3 fix attempts used, a refusal, an expiry) → stop (one PR comment, one Log line) → resume (parked on `brigadev.resume`) → the phase that stopped
//
// Every git and GitHub action is deterministic code here, through the injectable `PrDeps`, never a worker tool: the worker's guard keeps blocking push, PR and
// merge. Each phase is safe to rerun after a crash: the suite and the reads are repeatable, a push first asks the remote whether it already has the commit, a PR
// is looked up before it is created (a crash between `gh pr create` and the checkpoint finds it again), a comment is memoized before it is posted (at most once),
// the fix budget is charged in the commit that creates the fix ticket, and a merge re-reads the PR first (a merged PR is never merged twice).
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configure, defineTask, SubmissionSettled } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ModelRef, RunningTask, TaskId, TaskRuntime, ToolRegistration } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { resolveCommand } from "../../lib/check.ts";
import { readBranchFacts } from "../../lib/commit-branch.ts";
import { lookupPr, summarizeChecks, type ChecksSummary, type PrExec } from "../../lib/pr-info.ts";
import { branchRisk, riskMapFor } from "../../lib/risk-map.ts";
import { readSettings, type BrigadevSettings } from "../../lib/runtime.ts";
import type { ExecFn } from "../../lib/worktree-snapshot.ts";
import { worktreeTree } from "../../lib/worktree-tree.ts";
import { appendLogLine, parseTicketList, writeFileAtomic } from "../../lib/ticket-list.ts";
import { runContainedCheck } from "./check-run.ts";
import { defaultContainedEnv } from "./contain.ts";
import { approves, type AnsweredDecision } from "./decision.ts";
import { capMessage, CostMeter, reached, track } from "./cost.ts";
import { asExec as execFnOf, nodeExec } from "./exec.ts";
import { compareIntegrity, integrityReason, takeIntegrity, type Integrity } from "./integrity.ts";
import { redact } from "./redact.ts";
import { doneTimeoutMs } from "./shell.ts";
import { ANSWER, answerCommand, CI_DEADLINE_MS, DECISION_DEADLINE_MS, decisionKey, MERGE, MERGE_DEADLINE_MS, mergeCommand, mergeKey, RESUME, resumeKey } from "./signals.ts";
import { tailOf } from "./tail.ts";
import type { OpenDecision, ShellContext, TicketInput, TicketResult, TicketTask } from "./tasks.ts";
import { blockersSpec, createVerdictTool, loadVerifier, RoleDoc, VerdictDoc, verdictOf, VERIFY_ROLE, verifyInput, verifyInstructions, type Blocker, type Verifier } from "./verify.ts";

export const PR_TASK = "brigadev.pr-loop";
/** How often CI is read (S2b, Q4): a constant tests override through the Harness clock. */
export const POLL_MS = 60_000;
/** Fix attempts per PR loop, shared by the final check, verify, and CI; `resume` starts the count again. */
export const MAX_FIX_ATTEMPTS = 3;
/** What `gh pr view` is asked for on every CI read and at the merge gate. */
export const LIVE_FIELDS = "headRefOid,statusCheckRollup,state,isDraft";

// ---------------------------------------------------------------------------------------------------------------------
// Injectable effects

export interface SuiteResult {
	/** The suite's exit code; null when it was killed. */
	exitCode: number | null;
	/** The compact result with the failing tail. */
	tail: string;
	/** Set instead when no test command resolves or the run could not start. */
	error?: string;
}

/** What the suite runs with: the pinned settings, the contained environment (it is the agent's code), and the longest it may take. */
export interface SuiteRun {
	settings: BrigadevSettings;
	shellEnv: NodeJS.ProcessEnv;
	timeoutMs: number;
}

/**
 * Everything the PR loop does outside storage and the worker conversations; tests pass their own `exec` (a fake `gh`, a real git against a local remote).
 * `exec` runs with the runner's real environment (push, ls-remote, gh): nothing the agent wrote runs through it.
 */
export interface PrDeps {
	/** Run `git` or `gh` in `cwd`. */
	exec: PrExec;
	/** The full suite in `cwd`, its run recorded as evidence for the runner. It is the agent's code: it runs with `run.shellEnv`. */
	suite(cwd: string, signal?: AbortSignal, run?: SuiteRun): Promise<SuiteResult>;
}

export const defaultPrDeps: PrDeps = {
	exec: nodeExec as unknown as PrExec,
	async suite(cwd, signal, run) {
		const timeoutMs = run?.timeoutMs ?? doneTimeoutMs(undefined);
		const result = await runContainedCheck(
			{ timeoutSeconds: timeoutMs / 1000 },
			{ cwd, exec: nodeExec, signal, agent: "runner", settings: run?.settings ?? readSettings(), shellEnv: run?.shellEnv ?? defaultContainedEnv(), maxTimeoutMs: timeoutMs },
		);
		if (!result.details) return { exitCode: null, tail: "", error: result.text };
		return { exitCode: result.details.exitCode ?? null, tail: tailOf(result.text) };
	},
};

export interface PrOptions {
	/** The brigadev settings, pinned when the runner opened (default: read once when the task is created). */
	settings?: BrigadevSettings;
	/** The contained environment and the timeout of the agent's commands. */
	shell?: ShellContext;
	deps?: PrDeps;
	/** The verify conversation's prompt (default: assets/agents/brigadev-verify.md). */
	verifier?: Verifier;
	/** The terminating verdict tool the verify conversation gets (default: a fresh one; the Harness registry must hold the same tool name). */
	verdictTool?: ToolRegistration;
	/** Reads the loop's spend for the cost cap (default: a fresh one). */
	meter?: CostMeter;
}

// ---------------------------------------------------------------------------------------------------------------------
// State

/** `loop`: the ticket loop task this PR loop belongs to, whose cost cap its verify and fix tickets count against (absent: no cap). */
export type PrInput = { docPath: string; cwd: string; model: ModelRef; loop?: string };

/** The terminal result: the PR is merged (by the runner, or already by someone). */
export type PrResult = { status: "merged"; number: number; url: string; sha: string };

type Origin = "check" | "verify" | "ci";

/** What every phase carries. Optional fields are left out, never `undefined`: a checkpoint is JSON. */
export type PrCarry = {
	branch: string;
	/** The commit the branch was last pushed at (CI results for another head are ignored). */
	sha: string;
	pr?: { number: number; url: string };
	/** Fix attempts used since the start or the last `resume`. */
	budget: number;
	/** Fix tickets created so far: the next is `FIX-<fixSeq + 1>`. */
	fixSeq: number;
	verifyRound: number;
	/** Merge approvals awaited so far: the key of the current one is `merge-<mergeRound>`. */
	mergeRound: number;
	/** CI waits started: each has its own 24 h deadline. */
	waits: number;
	/** Stops so far: the resume key of the current one is `resume-<stops>`. */
	stops: number;
	/** The fix ticket's open decision, if it asked one. */
	decision?: OpenDecision;
	rounds: Record<string, number>;
	answers: Record<string, AnsweredDecision>;
	/** The last PR comment that could not be posted (redacted), shown by `status`; cleared by the next one that is. */
	warn?: string;
};

type PlainPhase = "check" | "verify" | "push" | "open" | "wait-ci" | "ready";
type Plain = { phase: PlainPhase } & PrCarry;
type FixInfo = { origin: Origin; failure: string };

export type PrState =
	| ({ phase: "start" } & PrCarry)
	| Plain
	| ({ phase: "verdict"; round: number; key: string; conversationId: string } & PrCarry)
	| ({ phase: "fix"; ticketId?: string; answered?: AnsweredDecision } & FixInfo & PrCarry)
	| ({ phase: "fixed"; ticketId: string; childId: string } & FixInfo & PrCarry)
	| ({ phase: "answer"; ticketId: string; decision: OpenDecision } & FixInfo & PrCarry)
	| ({ phase: "poll" } & PrCarry)
	| ({ phase: "nap" } & PrCarry)
	| ({ phase: "merge"; key: string } & PrCarry)
	| ({ phase: "stop"; reason: string; next: Plain; cost?: true } & PrCarry)
	| ({ phase: "resume"; reason: string; key: string; next: Plain; cost?: true } & PrCarry);

const CARRY_KEYS = ["branch", "sha", "pr", "budget", "fixSeq", "verifyRound", "mergeRound", "waits", "stops", "decision", "rounds", "answers", "warn"] as const;

/** The carried fields of a state (and nothing else), with a patch applied. */
function carryOf(state: PrCarry, patch: Partial<PrCarry> = {}): PrCarry {
	const merged: Record<string, unknown> = { ...state, ...patch };
	return Object.fromEntries(CARRY_KEYS.filter((key) => merged[key] !== undefined).map((key) => [key, merged[key]])) as PrCarry;
}
const without = (carry: PrCarry, key: "decision" | "pr"): PrCarry => {
	const { [key]: _dropped, ...rest } = carry;
	return rest as PrCarry;
};
const at = (phase: PlainPhase, carry: PrCarry): Plain => ({ phase, ...carryOf(carry) });

const initialCarry = (): PrCarry => ({ branch: "", sha: "", budget: 0, fixSeq: 0, verifyRound: 0, mergeRound: 0, waits: 0, stops: 0, rounds: {}, answers: {} });

/** The phase `status` shows: final-check, verify, push, open, wait-ci, fix n, wait-merge, needs-you. */
export function prPhaseLabel(state: PrState, carry: Pick<PrCarry, "fixSeq"> = state): string {
	switch (state.phase) {
		case "start":
		case "check":
			return "final-check";
		case "verify":
		case "verdict":
			return "verify";
		case "fix":
		case "fixed":
		case "answer":
			return `fix ${carry.fixSeq}`;
		case "push":
			return "push";
		case "open":
			return "open";
		case "wait-ci":
		case "poll":
		case "nap":
			return "wait-ci";
		case "ready":
		case "merge":
			return "wait-merge";
		case "stop":
		case "resume":
			return "needs-you";
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Words: title, body, fix specs

const TYPES = new Set(["feat", "fix", "chore", "docs", "refactor", "test", "perf", "ci", "build", "style"]);
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const short = (sha: string) => sha.slice(0, 7);

/** The first sentence of the doc's `Objective:` line. */
function objectiveOf(text: string): string {
	const line = /^Objective:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? "";
	return line;
}

/** A conventional title: the type from the branch (`feat/x` → `feat`, else `chore`), the subject from the doc's first heading, else the Objective's first sentence. */
export function prTitle(branch: string, docText: string): string {
	const [prefix, ...rest] = branch.split("/");
	const type = rest.length > 0 && TYPES.has(prefix) ? prefix : "chore";
	const heading = /^# (.+)$/m.exec(docText)?.[1];
	let subject = oneLine(heading ?? objectiveOf(docText).split(/(?<=[.!?])\s/)[0] ?? "").replace(/[.!?]$/, "");
	if (!subject) subject = oneLine(rest.length > 0 ? rest.join("/") : branch).replace(/[-_]+/g, " ");
	// Conventional subjects start lower case, unless the second letter is upper case too (an acronym).
	if (/^[A-Z][a-z0-9]/.test(subject) || subject.length === 1) subject = subject[0].toLowerCase() + subject.slice(1);
	return `${type}: ${subject}`.slice(0, 100);
}

/** The PR body: objective, the tickets with their commits, the risk tier, and who opened it. */
export function prBody(docText: string, risk: { tier: string; categories: string[] } | undefined): string {
	const tickets = parseTicketList(docText).tickets.map((ticket) => `- ${ticket.id}${ticket.title ? ` ${oneLine(ticket.title)}` : ""} — ${ticket.status ?? "pending"}${ticket.note ? ` ${oneLine(ticket.note)}` : ""}`);
	return [
		"## Objective",
		objectiveOf(docText) || "(see the feature document)",
		"",
		"## Tickets",
		...(tickets.length > 0 ? tickets : ["(none)"]),
		"",
		`Risk tier: ${risk ? `${risk.tier}${risk.categories.length > 0 ? ` (${risk.categories.join(", ")})` : ""}` : "unknown"}`,
		"",
		"Opened by brigadev-runner.",
		"",
	].join("\n");
}

const REPRODUCE = "Reproduce it with a failing test first (RED), then fix it, run the suite (GREEN), and commit. The ticket is done when the suite passes and the fix is committed.";

function fixTitle(origin: Origin, state: PrCarry): string {
	return origin === "ci" ? `fix the CI failure on ${short(state.sha)}` : origin === "verify" ? `fix the verify blockers (round ${state.verifyRound})` : "fix the failing final check";
}

// ---------------------------------------------------------------------------------------------------------------------
// git and gh

const GIT_TIMEOUT = 120_000;
const GH_TIMEOUT = 60_000;

/** The lib rules take the narrower `ExecFn`. */
const asExec = (deps: PrDeps): ExecFn => execFnOf((command, args, options) => deps.exec(command, args, options));

/** One short line of command output, for a comment or a Log line: no credential, no home directory. */
const trimmed = (text: string) => redact(oneLine(tailOf(text)).slice(-300));

async function gitOut(deps: PrDeps, cwd: string, ...args: string[]): Promise<string | undefined> {
	const result = await deps.exec("git", args, { cwd, timeout: GIT_TIMEOUT });
	return result.code === 0 ? result.stdout.trim() : undefined;
}

/** The content of the worktree as one tree id (every file as it is on disk, in a throwaway index): a read-only run leaves it as it was, also in a file that was dirty before. */
async function worktreeFingerprint(cwd: string): Promise<string> {
	return (await worktreeTree(cwd)) ?? "";
}

/** The commits of HEAD that the base does not have (`origin/<base>` when it exists, else the local branch). */
async function commitsAhead(deps: PrDeps, cwd: string, base: string): Promise<number> {
	const remote = await gitOut(deps, cwd, "rev-parse", "--verify", "-q", `refs/remotes/origin/${base}`);
	const count = await gitOut(deps, cwd, "rev-list", "--count", `${remote ? `origin/${base}` : base}..HEAD`);
	return count === undefined ? 0 : Number(count) || 0;
}

interface Live {
	head: string;
	state: string;
	isDraft: boolean;
	rollup: unknown[];
	checks: ChecksSummary;
}

/** The PR as CI and the merge gate need it, or the reason it could not be read. */
async function readLive(deps: PrDeps, cwd: string, number: number): Promise<Live | { error: string }> {
	const result = await deps.exec("gh", ["pr", "view", String(number), "--json", LIVE_FIELDS], { cwd, timeout: GH_TIMEOUT });
	if (result.code !== 0) return { error: trimmed(result.stderr || result.stdout) || "gh pr view failed" };
	try {
		const data = JSON.parse(result.stdout) as Record<string, unknown>;
		const rollup = Array.isArray(data.statusCheckRollup) ? data.statusCheckRollup : [];
		return { head: String(data.headRefOid ?? ""), state: String(data.state ?? "OPEN").toUpperCase(), isDraft: data.isDraft === true, rollup, checks: summarizeChecks(rollup) };
	} catch {
		return { error: "gh pr view did not return JSON" };
	}
}

const checkName = (entry: unknown): string => {
	const record = (entry ?? {}) as Record<string, unknown>;
	return String(record.name ?? record.context ?? record.workflowName ?? "check");
};

/** The failing checks' names, and the filtered failure log of their runs (`gh run view <id> --log-failed`, its tail). */
async function ciFailure(deps: PrDeps, cwd: string, sha: string, rollup: unknown[]): Promise<string> {
	const failing = rollup.filter((entry) => summarizeChecks([entry]).failing > 0);
	const runIds = [...new Set(failing.map((entry) => /\/runs\/(\d+)/.exec(String((entry as Record<string, unknown>).detailsUrl ?? ""))?.[1]).filter((id): id is string => id !== undefined))].slice(0, 2);
	const logs: string[] = [];
	for (const id of runIds) {
		const result = await deps.exec("gh", ["run", "view", id, "--log-failed"], { cwd, timeout: GH_TIMEOUT });
		logs.push(`--- gh run view ${id} --log-failed (tail) ---\n${result.code === 0 ? tailOf(result.stdout) || "(empty)" : `(could not fetch: ${trimmed(result.stderr)})`}`);
	}
	return [`CI failed on ${short(sha)}: ${failing.map(checkName).join(", ") || "a check"}`, ...logs].join("\n");
}

async function withTempFile<T>(text: string, use: (path: string) => Promise<T>): Promise<T> {
	const dir = mkdtempSync(join(tmpdir(), "brigadev-pr-"));
	try {
		const path = join(dir, "body.md");
		writeFileSync(path, text);
		return await use(path);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** One Log line through the doc's atomic write, once: a rerun finds the line and writes nothing. Redacted: a Log line quotes command output. */
function logLine(docPath: string, date: string, line: string): void {
	const text = readFileSync(docPath, "utf8");
	const wanted = oneLine(redact(line));
	if (text.split("\n").some((existing) => existing.endsWith(`): ${wanted}`))) return;
	writeFileAtomic(docPath, appendLogLine(text, date, wanted));
}

// ---------------------------------------------------------------------------------------------------------------------
// The task

class Aborted extends Error {}

type Rt = TaskRuntime<PrInput, PrState, PrResult, object>;
type Task<S extends PrState> = RunningTask<PrInput, S, PrResult>;
type Await = <T>(work: Promise<T>) => Promise<T>;
type Step<S extends PrState> = (task: Task<S>, runtime: Rt, context: Context, live: Await) => Promise<void>;

/**
 * A phase that returns quietly when the Harness closes: `live` races each outside call against the abort signal (a call that never returns must not
 * hold the close), and an error after the abort is the close's own.
 */
function phase<S extends PrState>(step: Step<S>) {
	return async (task: Task<S>, runtime: Rt, context: Context): Promise<void> => {
		const live: Await = (work) =>
			new Promise((resolve, reject) => {
				if (runtime.signal.aborted) return reject(new Aborted());
				const stop = () => reject(new Aborted());
				runtime.signal.addEventListener("abort", stop, { once: true });
				work.then(
					(value) => {
						runtime.signal.removeEventListener("abort", stop);
						resolve(value);
					},
					(error) => {
						runtime.signal.removeEventListener("abort", stop);
						reject(error);
					},
				);
			});
		try {
			await step(task, runtime, context, live);
		} catch (error) {
			if (error instanceof Aborted || runtime.signal.aborted) return;
			throw error;
		}
	};
}

/** The PR loop task over its seam (git, gh, the suite), the verifier prompt, and the verdict tool; it creates `brigadev.ticket` children for fixes. */
export function createPrTask(ticketTask: TicketTask, options: PrOptions = {}) {
	const deps = options.deps ?? defaultPrDeps;
	// Pinned once: a worker that rewrites brigadev.json (`check.test`, the risk globs) changes nothing for this runner.
	const settings = options.settings ?? readSettings();
	const shell = options.shell ?? {};
	const suiteRun: SuiteRun = { settings, shellEnv: shell.env ?? defaultContainedEnv(), timeoutMs: shell.timeoutMs ?? doneTimeoutMs(settings) };
	/** The integrity snapshot asks the remote with the real environment, like the PR loop's own git calls. */
	const integrityExec = asExec(deps);
	const verifier = options.verifier ?? loadVerifier();
	const verdictTool = options.verdictTool ?? createVerdictTool();
	const meter = options.meter ?? new CostMeter();

	const go = (runtime: Rt, context: Context, next: PrState) => runtime.commit(() => ({ status: "running", checkpoint: next }), context);
	const finish = (runtime: Rt, context: Context, result: PrResult) => runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
	const failTask = (runtime: Rt, context: Context, message: string) => runtime.commit(() => ({ status: "terminal", outcome: { status: "failed", error: { message } } }), context);
	const dateOf = (runtime: Rt) => new Date(runtime.now()).toISOString().slice(0, 10);
	/** Stop for a person: the `stop` phase comments, logs, and parks on `resume`; `resume` continues at `next` with a fresh fix budget. */
	const stop = (runtime: Rt, context: Context, state: PrCarry, reason: string, next: Plain) => go(runtime, context, { phase: "stop", reason, next, ...carryOf(state) });
	/** The loop's spend is at its cap: a stop that only `resume --cap` lifts (`cost` marks it for `status`, the comment, and the control). */
	const capStop = (runtime: Rt, context: Context, state: PrCarry, reason: string, next: Plain) => go(runtime, context, { phase: "stop", reason, next, cost: true, ...carryOf(state) });
	/** The loop's spend and cap, when this PR loop belongs to a loop with a ledger and its spend is at the cap. */
	const capReached = async (runtime: Rt, context: Context, input: PrInput): Promise<string | undefined> => {
		if (!input.loop) return undefined;
		const spend = await meter.read(runtime, input.loop, context);
		return reached(spend.spent, spend.cap) ? capMessage(spend.spent, spend.cap) : undefined;
	};

	const merged = async (runtime: Rt, context: Context, state: PrCarry, input: PrInput) => {
		const pr = state.pr!;
		logLine(input.docPath, dateOf(runtime), `PR #${pr.number} merged ${short(state.sha)} ${pr.url}`);
		await finish(runtime, context, { status: "merged", number: pr.number, url: pr.url, sha: state.sha });
	};

	/**
	 * One PR comment (redacted). A comment that cannot be posted is a Log line, `PR #n comment failed: <redacted stderr>`, and a warning on the state (`status` shows
	 * it); it never stops the loop. Returns the warning, or undefined when it was posted.
	 */
	const postComment = async (live: Await, runtime: Rt, input: PrInput, number: number, body: string): Promise<string | undefined> => {
		const result = await live(withTempFile(redact(body), (file) => deps.exec("gh", ["pr", "comment", String(number), "--body-file", file], { cwd: input.cwd, timeout: GH_TIMEOUT })));
		if (result.code === 0) return undefined;
		const warning = `PR #${number} comment failed: ${trimmed(result.stderr || result.stdout) || "gh pr comment failed"}`;
		logLine(input.docPath, dateOf(runtime), warning);
		return warning;
	};

	/** A failure to fix: the next fix ticket, with the origin to continue at once it passes. */
	const toFix = (runtime: Rt, context: Context, state: PrCarry, origin: Origin, failure: string) => go(runtime, context, { phase: "fix", origin, failure, ...carryOf(state) });
	/** Where a stop continues: the phase that found the failure. */
	const retryPhase = (origin: Origin): PlainPhase => (origin === "ci" ? "wait-ci" : origin);

	return defineTask<PrInput, PrState, PrResult>({
		name: PR_TASK,
		version: 1,
		initial: () => ({ phase: "start", ...initialCarry() }),
		phases: {
			// The branch: HEAD's, read once.
			start: phase<Extract<PrState, { phase: "start" }>>(async (task, runtime, context, live) => {
				const branch = await live(gitOut(deps, task.input.cwd, "symbolic-ref", "--short", "-q", "HEAD"));
				if (!branch) return failTask(runtime, context, "the PR loop needs a branch: HEAD is detached or git cannot answer");
				await go(runtime, context, { phase: "check", ...carryOf(task.state.checkpoint, { branch }) });
			}),

			// 1. final-check: the full suite, recorded as evidence by the runner. A failure is fixed.
			check: phase<Plain>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const suite = await live(deps.suite(task.input.cwd, runtime.signal, suiteRun));
				if (suite.error) return stop(runtime, context, state, `the final check could not run: ${trimmed(suite.error)}`, at("check", state));
				if (suite.exitCode === 0) return go(runtime, context, at("verify", state));
				await toFix(runtime, context, state, "check", `The final check (the full suite) failed${suite.exitCode === null ? " (killed)" : ` with exit ${suite.exitCode}`}:\n${suite.tail}`);
			}),

			// 2. verify: T2 only. A read-only conversation that ends through the verdict tool; the verdict is read in `verdict`.
			verify: phase<Plain>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { cwd, docPath } = task.input;
				const risk = await live(branchRisk(asExec(deps), cwd, riskMapFor(settings)));
				// An unknown base means the committed changes were not seen: the safe reading is the high tier.
				const tier = risk && !risk.baseUnknown ? risk.tier : "T2";
				if (tier !== "T2") return go(runtime, context, at("push", state));
				// The cost cap, before the verify conversation spends anything.
				const capped = await capReached(runtime, context, task.input);
				if (capped) return capStop(runtime, context, state, capped, at("verify", state));

				const round = state.verifyRound + 1;
				const base = (await live(readBranchFacts(asExec(deps), cwd))).defaultBranch ?? undefined;
				// What the loop has spent so far: the conversation's own cap and base (its tools are blocked once the spend reaches the cap).
				const spend = task.input.loop ? await meter.read(runtime, task.input.loop, context) : undefined;
				// The worktree as it is before the run (a read-only run must leave it so), and what the verifier must not touch (src/integrity.ts).
				await runtime.memo(`verify.before.${round}`, await live(worktreeFingerprint(cwd)), context);
				await runtime.memo(`verify.integrity.${round}`, await live(takeIntegrity(cwd, integrityExec, { docPath })), context);
				const brief = { docPath, branch: state.branch, ...(base ? { base } : {}), round };
				const key = `verify-${round}`;
				let conversationId!: string;
				await runtime.commit(async (tx) => {
					const owned = (await tx.scanConversations({ ownerTaskId: task.id }, 100)).items;
					if (owned.length >= round) {
						conversationId = owned[round - 1].id;
						return undefined;
					}
					const created = await tx.createConversation({ ownership: { kind: "task", taskId: task.id } });
					const tools = [...(CodingTools.tools ?? []).filter((tool) => tool.name === "read" || tool.name === "bash"), verdictTool] as ToolRegistration[];
					await configure(tx, created.id, { model: task.input.model, cwd, tools, instructions: verifyInstructions(verifier, brief) });
					(await tx.doc(RoleDoc, created.id)).role = VERIFY_ROLE;
					if (spend && task.input.loop) await track(tx, task.input.loop, created.id, { cap: spend.cap, base: spend.spent });
					conversationId = created.id;
					return undefined;
				}, context);
				const conversation = await runtime.conversation(conversationId as never, context);
				if (!conversation) throw new Error(`verify conversation ${conversationId} is missing`);
				await runtime.commit(async (tx) => {
					await conversation.submit(tx, { type: "input", content: verifyInput(brief), requestId: `verify:${task.id}:round:${round}`, notify: { taskId: task.id, key } });
					return { status: "sleeping", signals: [SubmissionSettled.key(key)], checkpoint: { phase: "verdict", round, key, conversationId, ...carryOf(state, { verifyRound: round }) } };
				}, context);
			}),

			verdict: phase<Extract<PrState, { phase: "verdict" }>>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { round, key, conversationId } = state;
				const { cwd, docPath } = task.input;
				// First what it must not have touched (config and hooks: before any git call that could run one), then the worktree's content.
				const integrityBefore = await runtime.memo<Integrity>(`verify.integrity.${round}`, context);
				if (integrityBefore) {
					const changes = compareIntegrity(integrityBefore, await live(takeIntegrity(cwd, integrityExec, { docPath, previous: integrityBefore })));
					if (changes.length > 0) return stop(runtime, context, state, integrityReason("verifier", changes), at("verify", state));
				}
				const before = await runtime.memo<string>(`verify.before.${round}`, context);
				if (before !== undefined && before !== (await live(worktreeFingerprint(cwd)))) {
					return stop(runtime, context, state, "the verify run changed the worktree (HEAD or files); it must be read-only", at("verify", state));
				}
				const verdict = verdictOf(await runtime.snapshot(VerdictDoc, conversationId as never, context));
				if (!verdict) {
					const settled = await runtime.readSignal(SubmissionSettled, key, context);
					const why = settled && "value" in settled && settled.value.status === "unanswered" ? settled.value.reason : "it did not call the verdict tool";
					return stop(runtime, context, state, `the verify run ended without a verdict (${why})`, at("verify", state));
				}
				if (verdict.blockers.length === 0) {
					logLine(docPath, dateOf(runtime), `verify round ${round}: clean (${verdict.advisories.length} advisories)`);
					return go(runtime, context, at("push", state));
				}
				logLine(docPath, dateOf(runtime), `verify round ${round}: ${verdict.blockers.length} blocker${verdict.blockers.length === 1 ? "" : "s"}`);
				await toFix(runtime, context, state, "verify", blockersSpec(verdict.blockers as Blocker[]));
			}),

			// 6. fix: a `brigadev.ticket` child with a synthetic ticket; its decisions park like a normal ticket's.
			fix: phase<Extract<PrState, { phase: "fix" }>>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { cwd, docPath } = task.input;
				const fresh = state.ticketId === undefined;
				if (fresh && state.budget >= MAX_FIX_ATTEMPTS) {
					const first = state.failure.split("\n")[0];
					return stop(runtime, context, state, `${MAX_FIX_ATTEMPTS} fix attempts used; the last failure: ${trimmed(first)}`, at(retryPhase(state.origin), state));
				}
				const suite = resolveCommand({ cwd, settings });
				if ("error" in suite) return stop(runtime, context, state, `no test command to prove a fix with: ${trimmed(suite.error)}`, at(retryPhase(state.origin), state));
				// The cost cap, before the fix ticket spends anything (and before the fix budget is charged: a stop at the cap uses none of it).
				const capped = await capReached(runtime, context, task.input);
				if (capped) return capStop(runtime, context, state, capped, at(retryPhase(state.origin), state));
				const model = task.input.model;
				const ticketId = state.ticketId ?? `FIX-${state.fixSeq + 1}`;
				const carry = carryOf(state, fresh ? { budget: state.budget + 1, fixSeq: state.fixSeq + 1 } : {});
				const input: TicketInput = {
					docPath,
					cwd,
					ticketId,
					title: fixTitle(state.origin, carry),
					done: suite.command,
					specs: [],
					spec: `${state.failure}\n\n${REPRODUCE}`,
					// One worker attempt per fix: the budget of 3 counts attempts.
					maxAttempts: 1,
					model,
					...(state.answered ? { decision: state.answered } : {}),
					...(task.input.loop ? { loop: task.input.loop } : {}),
				};
				await runtime.commit(async (tx) => {
					const childId = await tx.createTask(ticketTask, input, { ownership: { kind: "task", taskId: task.id } });
					return {
						status: "waiting",
						checkpoint: { phase: "fixed", ticketId, childId, origin: state.origin, failure: state.failure, ...carry },
						on: [childId],
						policy: "allSettled",
					};
				}, context);
			}),

			fixed: phase<Extract<PrState, { phase: "fixed" }>>(async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const { docPath } = task.input;
				const { ticketId, origin } = state;
				const [outcome] = await runtime.outcomes([state.childId as TaskId<TicketResult>], context);

				// The fix worker's run changed what it must not (src/integrity.ts): stop for a person with the list. `resume` accepts the state and starts again at the final
				// check (the fix's own done check never ran), then verify, push, and CI as usual.
				if (outcome.status === "completed" && "integrity" in outcome.result) {
					const carry = without(carryOf(state), "decision");
					return stop(runtime, context, carry, `${ticketId}: ${integrityReason("worker", outcome.result.integrity)}`, at("check", carry));
				}

				// The loop's spend was at its cap before the fix worker's attempt (a cap lowered meanwhile): stop like the fix phase does; `resume --cap` goes on.
				if (outcome.status === "completed" && "capped" in outcome.result) {
					const carry = without(carryOf(state), "decision");
					return capStop(runtime, context, carry, capMessage(outcome.result.capped.spent, outcome.result.capped.cap), at(retryPhase(origin), carry));
				}

				// The fix worker asked a question: park on its key, like a ticket decision. It used no attempt.
				if (outcome.status === "completed" && "decision" in outcome.result) {
					const asked = outcome.result.decision;
					const round = (state.rounds[ticketId] ?? 0) + 1;
					const key = decisionKey(ticketId, round);
					const until = await runtime.memo<number>(`until.${key}`, runtime.now() + DECISION_DEADLINE_MS, context);
					logLine(docPath, dateOf(runtime), `${ticketId} blocked: needs you: decision: ${oneLine(asked.question)} (answer: ${answerCommand(docPath, ticketId)})`);
					const open: OpenDecision = { ...asked, ticketId, key, round, until };
					return runtime.commit(
						() => ({
							status: "sleeping",
							signals: [ANSWER.key(key)],
							until,
							checkpoint: { phase: "answer", ticketId, decision: open, origin, failure: state.failure, ...carryOf(state, { decision: open, rounds: { ...state.rounds, [ticketId]: round } }) },
						}),
						context,
					);
				}
				if (outcome.status === "completed") {
					logLine(docPath, dateOf(runtime), `${ticketId} done ${short("commit" in outcome.result ? outcome.result.commit : "")} (fix for ${origin === "ci" ? "CI" : origin === "verify" ? "verify blockers" : "the final check"})`);
					const carry = without(carryOf(state), "decision");
					// A fix for CI is pushed; the final check's and verify's go on to verify again (the fix's own done check was the suite).
					return go(runtime, context, origin === "ci" ? at("push", carry) : at("verify", carry));
				}
				const reason = outcome.status === "failed" ? outcome.error.message : `fix run ${outcome.status}`;
				const tail = outcome.status === "failed" ? ((outcome.error.detail as { outputTail?: string } | undefined)?.outputTail ?? "") : "";
				const failure = `${state.failure}\n\nA previous fix attempt (${ticketId}) failed: ${reason}${tail ? `\n${tail}` : ""}`;
				await toFix(runtime, context, without(carryOf(state), "decision"), origin, failure);
			}),

			// After a fix worker's question: the answer reruns the fix ticket with it; no answer in 24 h is a stop.
			answer: phase<Extract<PrState, { phase: "answer" }>>(async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const { decision, ticketId, origin } = state;
				const answer = await runtime.readSignal(ANSWER, decision.key, context);
				const carry = without(carryOf(state), "decision");
				if (answer && "value" in answer) {
					const answered: AnsweredDecision = { question: decision.question, options: decision.options, recommended: decision.recommended, command: decision.command, answer: answer.value.choice, approved: approves(decision, answer.value) };
					logLine(task.input.docPath, dateOf(runtime), `${ticketId} answered: ${oneLine(answer.value.choice)}`);
					return go(runtime, context, { phase: "fix", origin, failure: state.failure, ticketId, answered, ...carry });
				}
				if (answer) return stop(runtime, context, carry, `no answer to ${ticketId}'s decision within 24 h`, at(retryPhase(origin), carry));
				// Woken by neither: sleep on.
				await runtime.commit(() => ({ status: "sleeping", signals: [ANSWER.key(decision.key)], until: decision.until, checkpoint: { ...state, decision } }), context);
			}),

			// 3. push: never forced; skipped when the remote branch is already at HEAD, so a crash never pushes a commit twice.
			push: phase<Plain>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { cwd } = task.input;
				const head = await live(gitOut(deps, cwd, "rev-parse", "HEAD"));
				if (!head) return stop(runtime, context, state, "git cannot read HEAD", at("push", state));
				const remote = await live(deps.exec("git", ["ls-remote", "origin", `refs/heads/${state.branch}`], { cwd, timeout: GIT_TIMEOUT }));
				if (remote.code !== 0) return stop(runtime, context, state, `cannot read origin: ${trimmed(remote.stderr)}`, at("push", state));
				if (remote.stdout.trim().split(/\s+/)[0] !== head) {
					// No hook of the repository runs for the runner's push (its config is the agent's to edit), whatever the global config says.
					const pushed = await live(deps.exec("git", ["-c", "core.hooksPath=/dev/null", "push", "--no-verify", "-u", "origin", `HEAD:${state.branch}`], { cwd, timeout: GIT_TIMEOUT }));
					if (pushed.code !== 0) return stop(runtime, context, state, `git push was refused or failed: ${trimmed(pushed.stderr || pushed.stdout)}`, at("push", state));
				}
				await go(runtime, context, at("open", carryOf(state, { sha: head })));
			}),

			// 4. open: the branch's PR, found first; created only when there is none (and the branch has commits to show).
			open: phase<Plain>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { cwd, docPath } = task.input;
				if (state.pr) return go(runtime, context, at("wait-ci", state));
				const found = await live(lookupPr(deps.exec, cwd));
				if (found.status === "unavailable") return stop(runtime, context, state, "cannot read the pull request: gh is missing, not logged in, or offline", at("open", state));
				let pr = found.status === "found" ? found.pr : undefined;
				if (pr && pr.state.toUpperCase() === "CLOSED") return stop(runtime, context, state, `PR #${pr.number} for ${state.branch} is closed`, at("open", state));
				// R4-003: a merged PR of this branch name ends the loop only when it is the PR of the commit pushed now; an older one (a reused branch name) is not ours.
				if (pr && pr.state.toUpperCase() === "MERGED") {
					const view = await live(readLive(deps, cwd, pr.number));
					if ("error" in view || view.head !== state.sha) return stop(runtime, context, state, `an older PR #${pr.number} for this branch is merged; open a new branch`, at("open", state));
				}
				let how = "found";
				if (!pr) {
					const base = (await live(readBranchFacts(asExec(deps), cwd))).defaultBranch;
					if (!base) return stop(runtime, context, state, "cannot determine the default branch (see `git remote set-head origin <branch>`)", at("open", state));
					if ((await live(commitsAhead(deps, cwd, base))) === 0) return stop(runtime, context, state, `${state.branch} has no commits ahead of ${base}: there is nothing to open a PR for`, at("open", state));
					const text = readFileSync(docPath, "utf8");
					const risk = await live(branchRisk(asExec(deps), cwd, riskMapFor(settings)));
					const body = prBody(text, risk ? { tier: risk.tier, categories: Object.keys(risk.categories) } : undefined);
					const created = await live(
						withTempFile(body, (file) => deps.exec("gh", ["pr", "create", "--base", base, "--head", state.branch, "--title", prTitle(state.branch, text), "--body-file", file], { cwd, timeout: GH_TIMEOUT })),
					);
					if (created.code !== 0) return stop(runtime, context, state, `gh pr create failed: ${trimmed(created.stderr || created.stdout)}`, at("open", state));
					const after = await live(lookupPr(deps.exec, cwd));
					pr = after.status === "found" ? after.pr : undefined;
					if (!pr) {
						const url = created.stdout.trim().split("\n").at(-1) ?? "";
						const number = Number(/\/pull\/(\d+)/.exec(url)?.[1]);
						if (!number) return stop(runtime, context, state, "gh pr create answered, but the PR cannot be read back", at("open", state));
						pr = { number, url } as never;
					}
					how = "opened";
				}
				logLine(docPath, dateOf(runtime), `PR #${pr!.number} ${how} ${pr!.url}`);
				const carry = carryOf(state, { pr: { number: pr!.number, url: pr!.url } });
				if (pr!.state?.toUpperCase() === "MERGED") return merged(runtime, context, carry, task.input);
				await go(runtime, context, at("wait-ci", carry));
			}),

			// 5. wait-ci: sleep, read, repeat. The deadline (24 h) is memoized once per wait.
			"wait-ci": phase<Plain>(async (task, runtime, context) => {
				const state = task.state.checkpoint;
				const waits = state.waits + 1;
				await runtime.memo(`ci.until.${waits}`, runtime.now() + CI_DEADLINE_MS, context);
				await runtime.commit(() => ({ status: "sleeping", until: runtime.now() + POLL_MS, checkpoint: { phase: "poll", ...carryOf(state, { waits }) } }), context);
			}),

			nap: phase<Extract<PrState, { phase: "nap" }>>(async (task, runtime, context) => {
				const state = task.state.checkpoint;
				await runtime.commit(() => ({ status: "sleeping", until: runtime.now() + POLL_MS, checkpoint: { phase: "poll", ...carryOf(state) } }), context);
			}),

			poll: phase<Extract<PrState, { phase: "poll" }>>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { cwd } = task.input;
				const pr = state.pr!;
				const until = await runtime.memo<number>(`ci.until.${state.waits}`, context);
				if (until !== undefined && runtime.now() >= until) return stop(runtime, context, state, "CI did not finish within 24 h", at("wait-ci", state));
				const view = await live(readLive(deps, cwd, pr.number));
				// A failed read is transient (the 24 h deadline ends a persistent one): read again after a nap.
				if ("error" in view) return go(runtime, context, { phase: "nap", ...carryOf(state) });
				if (view.state === "MERGED") return merged(runtime, context, state, task.input);
				if (view.state === "CLOSED") return stop(runtime, context, state, `PR #${pr.number} was closed`, at("wait-ci", state));
				// A result for another head (an older push, or one that has not arrived yet) says nothing about this one.
				if (view.head !== state.sha) return go(runtime, context, { phase: "nap", ...carryOf(state) });
				if (view.checks.failing > 0) return toFix(runtime, context, state, "ci", await live(ciFailure(deps, cwd, state.sha, view.rollup)));
				if (view.checks.pending > 0) return go(runtime, context, { phase: "nap", ...carryOf(state) });
				// Green, or no checks reported at all: nothing to wait for.
				await go(runtime, context, at("ready", state));
			}),

			// 7. wait-merge: one comment per approval, then park on `brigadev.merge`.
			ready: phase<Plain>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { docPath } = task.input;
				const round = state.mergeRound + 1;
				const key = mergeKey(round);
				// Memoized before the comment: a crash between the two loses the comment, it never posts it twice. `status` still shows the command.
				let warn = state.warn;
				if ((await runtime.memo<boolean>(`commented.${key}`, context)) === undefined) {
					await runtime.memo(`commented.${key}`, true, context);
					warn = await postComment(live, runtime, task.input, state.pr!.number, `Ready to merge: run \`${mergeCommand(docPath)}\``);
				}
				const until = await runtime.memo<number>(`until.${key}`, runtime.now() + MERGE_DEADLINE_MS, context);
				await runtime.commit(() => ({ status: "sleeping", signals: [MERGE.key(key)], until, checkpoint: { phase: "merge", key, ...carryOf(state, { mergeRound: round, warn }) } }), context);
			}),

			// The approval arrived: re-read the PR and merge only when it is open, not a draft, still at the pushed commit, and green.
			merge: phase<Extract<PrState, { phase: "merge" }>>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { cwd, docPath } = task.input;
				const pr = state.pr!;
				const approval = await runtime.readSignal(MERGE, state.key, context);
				if (!approval) {
					// Woken by neither the signal nor the deadline: sleep on (the deadline is memoized).
					const until = await runtime.memo<number>(`until.${state.key}`, runtime.now() + MERGE_DEADLINE_MS, context);
					return runtime.commit(() => ({ status: "sleeping", signals: [MERGE.key(state.key)], until, checkpoint: { ...state } }), context);
				}
				if ("expired" in approval) return stop(runtime, context, state, "merge approval expired", at("ready", state));

				const view = await live(readLive(deps, cwd, pr.number));
				if ("error" in view) return stop(runtime, context, state, `cannot read PR #${pr.number}: ${view.error}`, at("ready", state));
				if (view.state === "MERGED") return merged(runtime, context, state, task.input);
				if (view.state === "CLOSED") return stop(runtime, context, state, `PR #${pr.number} was closed`, at("wait-ci", state));
				const why = view.isDraft ? "it is a draft" : view.head !== state.sha ? `its head moved to ${short(view.head)} (pushed ${short(state.sha)})` : view.checks.failing > 0 ? "a check is failing" : view.checks.pending > 0 ? "checks are pending" : undefined;
				if (why) {
					logLine(docPath, dateOf(runtime), `PR #${pr.number} not merged: ${why}; waiting for CI again`);
					return go(runtime, context, at("wait-ci", state));
				}
				// --match-head-commit: GitHub refuses the merge if the head moved after the re-read above.
				const result = await live(deps.exec("gh", ["pr", "merge", String(pr.number), "--merge", "--match-head-commit", state.sha], { cwd, timeout: GH_TIMEOUT }));
				if (result.code !== 0) {
					// A merge that went through but could not answer is not a failure: look again before stopping.
					const after = await live(readLive(deps, cwd, pr.number));
					if (!("error" in after) && after.state === "MERGED") return merged(runtime, context, state, task.input);
					return stop(runtime, context, state, `gh pr merge failed: ${trimmed(result.stderr || result.stdout)}`, at("ready", state));
				}
				await merged(runtime, context, state, task.input);
			}),

			// needs-you: one PR comment (when a PR exists), one Log line, then park on `resume`. Both are once per stop.
			stop: phase<Extract<PrState, { phase: "stop" }>>(async (task, runtime, context, live) => {
				const state = task.state.checkpoint;
				const { docPath } = task.input;
				const n = state.stops + 1;
				let warn = state.warn;
				if (state.pr && (await runtime.memo<boolean>(`commented.stop.${n}`, context)) === undefined) {
					await runtime.memo(`commented.stop.${n}`, true, context);
					const resume = state.cost ? `brigadev-runner resume ${docPath} --cap <dollars>` : `brigadev-runner resume ${docPath}`;
					warn = await postComment(live, runtime, task.input, state.pr.number, `Needs you: ${state.reason}\n\nWhen it is sorted out, run \`${resume}\`: the runner continues where it stopped.`);
				}
				logLine(docPath, dateOf(runtime), `PR loop needs you (${n}): ${state.reason}`);
				const key = resumeKey(n);
				await runtime.commit(
					() => ({ status: "sleeping", signals: [RESUME.key(key)], checkpoint: { phase: "resume", reason: state.reason, key, next: { ...state.next, stops: n }, ...(state.cost ? { cost: true as const } : {}), ...carryOf(state, { stops: n, warn }) } }),
					context,
				);
			}),

			// After `resume`: back to the phase that stopped, with a fresh fix budget.
			resume: phase<Extract<PrState, { phase: "resume" }>>(async (task, runtime, context) => {
				const { next } = task.state.checkpoint;
				await go(runtime, context, { ...next, budget: 0 });
			}),
		},
		abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
	});
}
