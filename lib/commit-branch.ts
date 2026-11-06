// NORMAL mode asks before every `git commit`, except in the parent session
// when the commit runs in the session's repository on a branch that is not
// the default branch. Every doubt asks: detached HEAD, unknown default
// branch, another directory, a branch switch earlier in the same command, or
// any git call that fails.

import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";
import { type Decision, decideCommand, PERMISSION_MODE, type PermissionMode } from "./permission-policy.ts";
import type { ExecFn } from "./worktree-snapshot.ts";

const GIT_TIMEOUT_MS = 10_000;

export interface BranchFacts {
	/** Branch HEAD points to; null when detached or unknown. */
	currentBranch: string | null;
	/** Default branch; null when it cannot be determined. */
	defaultBranch: string | null;
	/**
	 * Branches a commit always asks on: the origin/HEAD target plus any `main`
	 * or `master` that exists (or could not be looked up). origin/HEAD alone is
	 * not enough, since a command can repoint it. Absent: only `defaultBranch`.
	 */
	protectedBranches?: string[];
}

const WELL_KNOWN_DEFAULTS = ["main", "master"];

/** A commit the guard may let through if the branch facts allow it. */
const isCandidate = (match: CommandMatch): boolean => match.kind === COMMAND_KIND.DELIVERY && match.commit === true && !match.elsewhere && !match.hardDeny;

function onFeatureBranch(facts: BranchFacts): boolean {
	return facts.currentBranch !== null && facts.defaultBranch !== null && facts.currentBranch !== facts.defaultBranch && !(facts.protectedBranches ?? []).includes(facts.currentBranch);
}

/**
 * `decideCommand`, except that commits on a feature branch do not ask in the
 * parent's NORMAL mode. `getFacts` runs only when such a commit is present.
 * Other matches (a chained push, a destructive command) keep their rules,
 * YOLO is unchanged, and subagents and hard-deny forms are still blocked.
 */
export async function decideWithBranchRule(matches: CommandMatch[], mode: PermissionMode, isChild: boolean, getFacts: () => Promise<BranchFacts>): Promise<Decision> {
	if (isChild || mode !== PERMISSION_MODE.NORMAL || !matches.some(isCandidate)) return decideCommand(matches, mode, isChild);
	let facts: BranchFacts;
	try {
		facts = await getFacts();
	} catch {
		facts = { currentBranch: null, defaultBranch: null, protectedBranches: [] };
	}
	return decideCommand(onFeatureBranch(facts) ? matches.filter((match) => !isCandidate(match)) : matches, mode, isChild);
}

/** `origin/main` (from `git symbolic-ref --short refs/remotes/origin/HEAD`) to `main`. */
export function parseOriginHead(output: string): string | null {
	return /^origin\/(.+)$/.exec(output.trim())?.[1] ?? null;
}

/**
 * origin/HEAD wins. Without it, a lone local `main` or `master` is the
 * default; both present, neither, or a failed lookup (null) is unknown.
 */
export function pickDefaultBranch(found: { originHead: string | null; hasMain: boolean | null; hasMaster: boolean | null }): string | null {
	if (found.originHead) return found.originHead;
	if (found.hasMain === null || found.hasMaster === null) return null;
	if (found.hasMain && !found.hasMaster) return "main";
	if (found.hasMaster && !found.hasMain) return "master";
	return null;
}

/** The origin/HEAD target, then `main` and `master` unless a lookup says the branch is absent (a failed lookup keeps it). */
export function pickProtectedBranches(found: { originHead: string | null; hasMain: boolean | null; hasMaster: boolean | null }): string[] {
	const exists: Record<string, boolean | null> = { main: found.hasMain, master: found.hasMaster };
	const names = [...(found.originHead ? [found.originHead] : []), ...WELL_KNOWN_DEFAULTS.filter((name) => exists[name] !== false)];
	return [...new Set(names)];
}

/** Branch facts for the repository at `cwd`; anything git cannot answer comes back null. */
export async function readBranchFacts(exec: ExecFn, cwd: string): Promise<BranchFacts> {
	const git = async (...args: string[]): Promise<{ stdout: string; code: number } | null> => {
		try {
			return await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
		} catch {
			return null;
		}
	};
	// Exit 0 = exists, 1 = absent, anything else = could not tell.
	const hasBranch = async (name: string): Promise<boolean | null> => {
		const result = await git("rev-parse", "--verify", "--quiet", `refs/heads/${name}`);
		return result && (result.code === 0 || result.code === 1) ? result.code === 0 : null;
	};

	const head = await git("symbolic-ref", "--short", "-q", "HEAD");
	const currentBranch = head?.code === 0 && head.stdout.trim() ? head.stdout.trim() : null;

	const origin = await git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
	const originHead = origin?.code === 0 ? parseOriginHead(origin.stdout) : null;
	const found = { originHead, hasMain: await hasBranch("main"), hasMaster: await hasBranch("master") };
	return { currentBranch, defaultBranch: pickDefaultBranch(found), protectedBranches: pickProtectedBranches(found) };
}
