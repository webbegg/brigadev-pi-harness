// Content key of a working tree: the git tree id of every tracked and
// untracked, non-ignored file as it is on disk, computed in a throwaway index
// (seeded from the real one for its stat cache) so the user's index and
// staging are never touched. Commits do not change it; any edit does.
//
// Objects the computation writes (blobs of untracked files, tree objects) go
// to a quarantine inside the scratch directory, with the real object store as
// a read-only alternate, so nothing lands in `.git/objects`.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
// Prose only: `.txt` and `.mdx` hold requirements, CMake lists, and components, so they count as source.
const DOC_EXTENSIONS = /\.(md|markdown|rst|adoc)$/i;
// The legal and changelog files by their exact names, bare or with a prose or `.txt` extension (`LICENSE_check.py` is code).
const DOC_NAME = /^(LICENSE|NOTICE|CHANGELOG|COPYING|AUTHORS)(\.(md|markdown|rst|adoc|txt))?$/;
const REMOVE_CHUNK = 200;

/** A path a test run does not depend on: prose files (`*.md`, ...) anywhere, and the LICENSE/NOTICE/CHANGELOG/COPYING/AUTHORS files. Code never counts, whatever its folder (a `docs/helper.js` a test imports is source). */
export function isDocPath(path: string): boolean {
	return DOC_EXTENSIONS.test(path) || DOC_NAME.test(basename(path));
}
/** One budget for the whole call (every git command in it), so a commit attempt or a check run is never held up longer. */
export const WORKTREE_TREE_TIMEOUT_MS = 10_000;

export type TreeResult =
	| {
			kind: "tree";
			tree: string;
			/** Top level of the work tree the key is for. */
			root: string;
			/** The same tree without doc paths (`isDocPath`); only with `sourceTree`. A doc-only edit leaves it unchanged. */
			sourceTree?: string;
	  }
	| { kind: "no-git" }
	| { kind: "error"; reason: string };

export interface WorktreeTreeOptions {
	/** Overall deadline in milliseconds (default 10 s). */
	timeoutMs?: number;
	/** Also compute the tree without doc paths (one more `ls-files`, and a second `write-tree` only when docs exist). */
	sourceTree?: boolean;
}

const NOT_A_WORK_TREE = /not a git repository|must be run in a work tree/i;

const describeFailure = (error: unknown, budgetMs: number): string => {
	const failure = error as { killed?: boolean; signal?: string; code?: unknown; stderr?: unknown; message?: unknown } | undefined;
	if (failure?.killed || failure?.signal === "SIGTERM") return `timed out after ${Math.round(budgetMs / 100) / 10}s`;
	if (failure?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "git output was too large";
	const detail = String(failure?.stderr || failure?.message || "").trim().split("\n")[0];
	return detail ? `git failed: ${detail.slice(0, 200)}` : "git failed";
};

/** The tree id, `no-git` when `cwd` is not in a git work tree (or git is missing), or `error` with the reason. */
export async function worktreeTreeResult(cwd: string, options: WorktreeTreeOptions = {}): Promise<TreeResult> {
	const budget = options.timeoutMs ?? WORKTREE_TREE_TIMEOUT_MS;
	const deadline = Date.now() + budget;
	let scratch: string | undefined;
	try {
		const git = async (args: string[], at: string, env: NodeJS.ProcessEnv = {}) => {
			const remaining = deadline - Date.now();
			if (remaining <= 0) throw Object.assign(new Error("deadline"), { killed: true });
			return (await run("git", args, { cwd: at, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...env }, timeout: remaining, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
		};
		let top: string;
		try {
			top = await git(["rev-parse", "--show-toplevel"], cwd);
		} catch (error) {
			const failure = error as { code?: unknown; killed?: boolean; stderr?: unknown };
			if (failure.code === "ENOENT") return { kind: "no-git" };
			if (!failure.killed && failure.code === 128 && NOT_A_WORK_TREE.test(String(failure.stderr ?? ""))) return { kind: "no-git" };
			throw error;
		}
		if (!top) return { kind: "no-git" };

		scratch = mkdtempSync(join(tmpdir(), "brigadev-tree-index-"));
		const realIndex = resolve(cwd, await git(["rev-parse", "--git-path", "index"], cwd));
		const realObjects = resolve(cwd, await git(["rev-parse", "--git-path", "objects"], cwd));
		const index = join(scratch, "index");
		const quarantine = join(scratch, "objects");
		mkdirSync(quarantine);
		if (existsSync(realIndex)) {
			copyFileSync(realIndex, index);
			// Keep the index mtime: git re-hashes "racily clean" entries (files modified
			// no earlier than the index was written). A fresh mtime would make a
			// same-size edit in the same second look unchanged.
			const { atime, mtime } = statSync(realIndex);
			utimesSync(index, atime, mtime);
		}
		const env = {
			GIT_INDEX_FILE: index,
			GIT_OBJECT_DIRECTORY: quarantine,
			GIT_ALTERNATE_OBJECT_DIRECTORIES: [realObjects, process.env.GIT_ALTERNATE_OBJECT_DIRECTORIES].filter(Boolean).join(delimiter),
		};
		await git(["add", "-A", "--", "."], top, env);
		const tree = await git(["write-tree"], top, env);
		if (!/^[0-9a-f]{40,64}$/.test(tree)) return { kind: "error", reason: "git write-tree printed no tree id" };
		if (!options.sourceTree) return { kind: "tree", tree, root: top };
		const docs = (await git(["ls-files", "-z"], top, env)).split("\0").filter((path) => path && isDocPath(path));
		if (docs.length === 0) return { kind: "tree", tree, root: top, sourceTree: tree };
		for (let i = 0; i < docs.length; i += REMOVE_CHUNK) await git(["--literal-pathspecs", "rm", "--cached", "-q", "--ignore-unmatch", "--", ...docs.slice(i, i + REMOVE_CHUNK)], top, env);
		const sourceTree = await git(["write-tree"], top, env);
		return /^[0-9a-f]{40,64}$/.test(sourceTree) ? { kind: "tree", tree, root: top, sourceTree } : { kind: "error", reason: "git write-tree printed no tree id" };
	} catch (error) {
		return { kind: "error", reason: describeFailure(error, budget) };
	} finally {
		if (scratch) rmSync(scratch, { recursive: true, force: true });
	}
}

/** The tree id, or undefined when there is none (no git, or a failure); callers that must tell them apart use `worktreeTreeResult`. */
export async function worktreeTree(cwd: string, options: WorktreeTreeOptions = {}): Promise<string | undefined> {
	const result = await worktreeTreeResult(cwd, options);
	return result.kind === "tree" ? result.tree : undefined;
}
