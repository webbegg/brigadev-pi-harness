// Pull request of the current branch, read-only through `gh pr view --json`. Pure
// parsing and formatting, plus a tracker that caches the last answer and drops
// stale ones. The command runner is injected; nothing here writes to GitHub.

import { basename, tokenize, unwrap } from "./command-classifier.ts";

export const PR_JSON_FIELDS = "number,title,state,isDraft,url,reviewDecision,statusCheckRollup";
export const PR_LOOKUP_TIMEOUT_MS = 10_000;

export interface ChecksSummary {
	passing: number;
	failing: number;
	pending: number;
	total: number;
}

export interface PrSummary {
	number: number;
	title: string;
	/** OPEN, CLOSED, or MERGED. */
	state: string;
	isDraft: boolean;
	url: string;
	/** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or "" when GitHub reports none. */
	reviewDecision: string;
	checks: ChecksSummary;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): string => (typeof value === "string" ? value : "");

/** Counts the entries of `statusCheckRollup` (check runs and commit statuses) as passing, failing, or pending. */
export function summarizeChecks(rollup: unknown): ChecksSummary {
	const checks: ChecksSummary = { passing: 0, failing: 0, pending: 0, total: 0 };
	if (!Array.isArray(rollup)) return checks;
	for (const entry of rollup) {
		if (!isRecord(entry)) continue;
		checks.total += 1;
		const status = text(entry.status).toUpperCase();
		const conclusion = text(entry.conclusion).toUpperCase();
		const state = text(entry.state).toUpperCase();
		if (state) {
			// A commit status.
			if (state === "SUCCESS") checks.passing += 1;
			else if (state === "PENDING" || state === "EXPECTED") checks.pending += 1;
			else checks.failing += 1;
		} else if (status && status !== "COMPLETED") checks.pending += 1;
		else if (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED") checks.passing += 1;
		else if (conclusion) checks.failing += 1;
		else checks.pending += 1;
	}
	return checks;
}

/** Parses `gh pr view --json ...` output; undefined when it is not a pull request. */
export function parsePrView(stdout: string): PrSummary | undefined {
	let data: unknown;
	try {
		data = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!isRecord(data) || typeof data.number !== "number" || !Number.isFinite(data.number) || typeof data.url !== "string") return undefined;
	return {
		number: data.number,
		title: text(data.title),
		state: text(data.state) || "OPEN",
		isDraft: data.isDraft === true,
		url: data.url,
		reviewDecision: text(data.reviewDecision),
		checks: summarizeChecks(data.statusCheckRollup),
	};
}

/** Footer segment text: `PR #N`, marked when the pull request is a draft, merged, or closed. */
export function prFooterText(pr: PrSummary): string {
	const state = pr.state.toUpperCase();
	if (state === "MERGED") return `PR #${pr.number} merged`;
	if (state === "CLOSED") return `PR #${pr.number} closed`;
	return pr.isDraft ? `PR #${pr.number} draft` : `PR #${pr.number}`;
}

const REVIEW_LABEL: Record<string, string> = { APPROVED: "approved", CHANGES_REQUESTED: "changes requested", REVIEW_REQUIRED: "review required" };

function checksLine(checks: ChecksSummary): string {
	if (checks.total === 0) return "no checks";
	return `${checks.passing} passing, ${checks.failing} failing, ${checks.pending} pending`;
}

/** Multi-line report for `/brigadev:pr`. */
export function prReport(pr: PrSummary): string {
	const state = pr.isDraft && pr.state.toUpperCase() === "OPEN" ? "draft" : pr.state.toLowerCase();
	const review = REVIEW_LABEL[pr.reviewDecision.toUpperCase()] ?? (pr.reviewDecision ? pr.reviewDecision.toLowerCase() : "no review decision");
	return [`PR #${pr.number}: ${pr.title}`, `State: ${state}`, `Review: ${review}`, `Checks: ${checksLine(pr.checks)}`, pr.url].join("\n");
}

// Commands that change the branch or the pull request it points at.
const GIT_REFRESH_SUBCOMMANDS = new Set(["push", "switch", "checkout"]);
const GH_PR_REFRESH_SUBCOMMANDS = new Set(["create", "checkout", "merge", "close", "reopen", "ready"]);
// Global git options that take a separate value.
const GIT_OPTIONS_WITH_VALUE = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--exec-path"]);

function gitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (GIT_OPTIONS_WITH_VALUE.has(arg)) i += 1;
		else if (!arg.startsWith("-")) return arg;
	}
	return undefined;
}

/** True when a shell command pushes, switches branches, or creates/checks out/merges a PR, so the cached PR may be stale. */
export function commandChangesPr(command: string): boolean {
	return tokenize(command).some((segment) => {
		const argv = unwrap(segment.argv).argv;
		if (argv.length === 0) return false;
		const name = basename(argv[0]);
		if (name === "git") return GIT_REFRESH_SUBCOMMANDS.has(gitSubcommand(argv.slice(1)) ?? "");
		return name === "gh" && argv[1] === "pr" && GH_PR_REFRESH_SUBCOMMANDS.has(argv[2] ?? "");
	});
}

export interface PrExecResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed?: boolean;
}
export type PrExec = (command: string, args: string[], options: { cwd?: string; timeout?: number }) => Promise<PrExecResult>;

/** found: a PR exists; none: gh answered that the branch has no PR; unavailable: gh missing, unauthenticated, offline, slow, or unreadable. */
export type PrLookup = { status: "found"; pr: PrSummary } | { status: "none" } | { status: "unavailable" };

/** Looks up the current branch's PR. Never throws and never waits longer than `timeoutMs` (plus a small grace). */
export async function lookupPr(exec: PrExec, cwd: string, timeoutMs = PR_LOOKUP_TIMEOUT_MS): Promise<PrLookup> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const gaveUp = new Promise<undefined>((resolve) => {
		timer = setTimeout(() => resolve(undefined), timeoutMs + 500);
		timer.unref?.();
	});
	try {
		const result = await Promise.race([exec("gh", ["pr", "view", "--json", PR_JSON_FIELDS], { cwd, timeout: timeoutMs }).catch(() => undefined), gaveUp]);
		if (!result || result.killed) return { status: "unavailable" };
		if (result.code === 0) {
			const pr = parsePrView(result.stdout);
			return pr ? { status: "found", pr } : { status: "unavailable" };
		}
		return /no pull requests? found/i.test(`${result.stderr}${result.stdout}`) ? { status: "none" } : { status: "unavailable" };
	} catch {
		return { status: "unavailable" };
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export interface PrTracker {
	/** Looks the PR up again. The answer is applied only if no later refresh or reset happened meanwhile; an unavailable answer keeps the PR already known. Never rejects. */
	refresh(cwd: string): Promise<PrLookup>;
	/** Forgets the cached PR and ignores answers still in flight. */
	reset(): void;
	current(): PrSummary | undefined;
}

export function createPrTracker(options: { exec: PrExec; timeoutMs?: number; onChange: (footerText: string | undefined) => void }): PrTracker {
	let generation = 0;
	let pr: PrSummary | undefined;
	let published: string | undefined;

	const publish = () => {
		const next = pr ? prFooterText(pr) : undefined;
		if (next === published) return;
		published = next;
		try {
			options.onChange(next);
		} catch {
			// A footer that cannot render must not break the lookup.
		}
	};

	return {
		async refresh(cwd) {
			const mine = ++generation;
			const lookup = await lookupPr(options.exec, cwd, options.timeoutMs);
			if (mine === generation) {
				// A transient failure (offline, slow, gh missing) keeps the last known PR; only gh's own "no PR" clears it.
				if (lookup.status === "found") pr = lookup.pr;
				else if (lookup.status === "none") pr = undefined;
				publish();
			}
			return lookup;
		},
		reset() {
			generation += 1;
			pr = undefined;
			publish();
		},
		current: () => pr,
	};
}
