// Automatic backup before a local discard in DSP mode (S3): a snapshot commit of the whole working tree
// (tracked and untracked non-ignored files, built with a temporary index, parent = HEAD) under
// `refs/brigadev/backup/<UTC timestamp>-<reason slug>`, plus one ref per ref about to be lost. Plain git
// plumbing through the injected exec; the repository's own index, HEAD and working tree are never touched.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecFn } from "./worktree-snapshot.ts";

export const BACKUP_PREFIX = "refs/brigadev/backup/";
const GIT_TIMEOUT_MS = 60_000;
const MAX_AGE_DAYS = 14;
const MAX_PRUNED_PER_RUN = 50;
const MAX_SLUG_CHARS = 40;

/** What the command is about to lose, besides the working tree. */
export interface BackupPlan {
	/** Reason slug, for the ref name: `reset-hard`, `branch-delete`, ... */
	slug: string;
	/** Local branches that will be deleted: their tips are kept. */
	branches: string[];
	/** Other refs that will be rewritten or deleted (`update-ref`). */
	refs: string[];
	/** Stash entries that will be dropped (`stash@{0}`), or `*` for every stash (`stash clear`). */
	stashes: string[];
}

export type BackupResult = { ok: true; refs: string[] } | { ok: false; error: string };

export const emptyPlan = (slug: string): BackupPlan => ({ slug, branches: [], refs: [], stashes: [] });

function slugify(text: string): string {
	return (
		text
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, MAX_SLUG_CHARS)
			.replace(/-+$/g, "") || "backup"
	);
}

const stamp = (now: Date) => now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export function backupRefName(now: Date, slug: string): string {
	return `${BACKUP_PREFIX}${stamp(now)}-${slugify(slug)}`;
}

type GitResult = { stdout: string; stderr: string; code: number };

async function git(exec: ExecFn, cwd: string, args: string[], env?: Record<string, string>): Promise<GitResult> {
	try {
		// The injected exec takes no environment, so variables go through env(1).
		if (env) return await exec("env", [...Object.entries(env).map(([key, value]) => `${key}=${value}`), "git", ...args], { cwd, timeout: GIT_TIMEOUT_MS });
		return await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
	} catch (error) {
		return { stdout: "", stderr: String(error), code: 1 };
	}
}

const failure = (what: string, result: GitResult) => `${what}: ${result.stderr.trim().split("\n")[0] || `git exit ${result.code}`}`;

/** Commit that `name` (a ref or revision) points at, or undefined when it does not resolve. */
async function resolveCommit(exec: ExecFn, cwd: string, name: string): Promise<string | undefined> {
	const result = await git(exec, cwd, ["rev-parse", "--verify", "--quiet", `${name}^{commit}`]);
	return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
}

async function freeRefName(exec: ExecFn, cwd: string, wanted: string, taken: ReadonlySet<string>): Promise<string> {
	for (let n = 1; n < 1000; n++) {
		const name = n === 1 ? wanted : `${wanted}-${n}`;
		if (taken.has(name)) continue;
		const exists = await git(exec, cwd, ["rev-parse", "--verify", "--quiet", name]);
		if (exists.code !== 0) return name;
	}
	throw new Error(`no free backup ref name near ${wanted}`);
}

/**
 * Makes the backup refs for `plan`, then prunes old ones. `cwd` is any directory of the repository. Any failure
 * returns `{ ok: false }` and leaves no partial ref behind.
 */
export async function createBackup(exec: ExecFn, cwd: string, plan: BackupPlan, options: { now?: Date } = {}): Promise<BackupResult> {
	const now = options.now ?? new Date();
	const top = await git(exec, cwd, ["rev-parse", "--show-toplevel"]);
	if (top.code !== 0 || !top.stdout.trim()) return { ok: false, error: failure("not a git repository", top) };
	const root = top.stdout.trim();

	const extras: Array<{ suffix: string; commit: string }> = [];
	for (const branch of plan.branches) {
		const commit = await resolveCommit(exec, root, `refs/heads/${branch}`);
		if (!commit) return { ok: false, error: `cannot resolve branch ${branch}` };
		extras.push({ suffix: `branch-${slugify(branch)}`, commit });
	}
	for (const ref of plan.refs) {
		// A ref that does not exist yet has nothing to lose.
		const commit = await resolveCommit(exec, root, ref);
		if (commit) extras.push({ suffix: `ref-${slugify(ref.replace(/^refs\/(heads|tags|remotes)\//, ""))}`, commit });
	}
	for (const stash of plan.stashes) {
		if (stash === "*") {
			const list = await git(exec, root, ["stash", "list", "--format=%H"]);
			if (list.code !== 0) return { ok: false, error: failure("cannot list stashes", list) };
			list.stdout.split("\n").filter(Boolean).forEach((commit, index) => extras.push({ suffix: `stash-${index}`, commit }));
		} else {
			const commit = await resolveCommit(exec, root, stash);
			const index = /\{(\d+)\}/.exec(stash)?.[1] ?? "0";
			if (commit) extras.push({ suffix: `stash-${index}`, commit });
		}
	}

	const head = await resolveCommit(exec, root, "HEAD");
	let snapshot: string;
	let scratch: string | undefined;
	try {
		scratch = mkdtempSync(join(tmpdir(), "brigadev-dsp-"));
		const env = {
			GIT_INDEX_FILE: join(scratch, "index"),
			GIT_AUTHOR_NAME: "brigadev",
			GIT_AUTHOR_EMAIL: "brigadev@localhost",
			GIT_COMMITTER_NAME: "brigadev",
			GIT_COMMITTER_EMAIL: "brigadev@localhost",
		};
		if (head) {
			const read = await git(exec, root, ["read-tree", "HEAD"], env);
			if (read.code !== 0) return { ok: false, error: failure("read-tree", read) };
		}
		const add = await git(exec, root, ["add", "-A"], env);
		if (add.code !== 0) return { ok: false, error: failure("add -A", add) };
		const tree = await git(exec, root, ["write-tree"], env);
		if (tree.code !== 0 || !tree.stdout.trim()) return { ok: false, error: failure("write-tree", tree) };
		const commit = await git(exec, root, ["commit-tree", tree.stdout.trim(), ...(head ? ["-p", head] : []), "-m", `brigadev DSP backup before ${plan.slug}`], env);
		if (commit.code !== 0 || !commit.stdout.trim()) return { ok: false, error: failure("commit-tree", commit) };
		snapshot = commit.stdout.trim();
	} catch (error) {
		return { ok: false, error: `snapshot failed: ${String(error)}` };
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}

	const created: string[] = [];
	try {
		const taken = new Set<string>();
		const base = await freeRefName(exec, root, backupRefName(now, plan.slug), taken);
		const wanted: Array<{ name: string; commit: string }> = [{ name: base, commit: snapshot }];
		taken.add(base);
		for (const extra of extras) {
			const name = await freeRefName(exec, root, `${base}-${extra.suffix}`, taken);
			taken.add(name);
			wanted.push({ name, commit: extra.commit });
		}
		for (const { name, commit } of wanted) {
			const update = await git(exec, root, ["update-ref", name, commit]);
			if (update.code !== 0) {
				for (const done of created) await git(exec, root, ["update-ref", "-d", done]);
				return { ok: false, error: failure(`update-ref ${name}`, update) };
			}
			created.push(name);
		}
	} catch (error) {
		for (const done of created) await git(exec, root, ["update-ref", "-d", done]);
		return { ok: false, error: String(error) };
	}

	await pruneBackups(exec, root, now).catch(() => []);
	return { ok: true, refs: created };
}

/** Deletes backup refs older than 14 days (by the timestamp in the name), oldest first, at most 50 per run. Returns the removed refs. */
export async function pruneBackups(exec: ExecFn, cwd: string, now: Date = new Date()): Promise<string[]> {
	const listed = await git(exec, cwd, ["for-each-ref", "--format=%(refname)", BACKUP_PREFIX]);
	if (listed.code !== 0) return [];
	const cutoff = now.getTime() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
	const old: Array<{ name: string; at: number }> = [];
	for (const name of listed.stdout.split("\n").filter(Boolean)) {
		const match = /^refs\/brigadev\/backup\/(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-/.exec(name);
		if (!match) continue;
		const at = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
		if (Number.isFinite(at) && at < cutoff) old.push({ name, at });
	}
	old.sort((a, b) => a.at - b.at || a.name.localeCompare(b.name));
	const removed: string[] = [];
	for (const { name } of old.slice(0, MAX_PRUNED_PER_RUN)) {
		const result = await git(exec, cwd, ["update-ref", "-d", name]);
		if (result.code === 0) removed.push(name);
	}
	return removed;
}
