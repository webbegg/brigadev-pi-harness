// Content key of a working tree: the git tree id of every tracked and
// untracked, non-ignored file as it is on disk, computed in a throwaway index
// (seeded from the real one for its stat cache) so the user's index and
// staging are never touched. Commits do not change it; any edit does.

import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);
const GIT_TIMEOUT_MS = 30_000;

/** Undefined when git is missing, `cwd` is not in a work tree, or git fails. */
export async function worktreeTree(cwd: string): Promise<string | undefined> {
	const scratch = mkdtempSync(join(tmpdir(), "brigadev-tree-index-"));
	try {
		const git = async (args: string[], at: string, env: NodeJS.ProcessEnv = {}) =>
			(await run("git", args, { cwd: at, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env }, timeout: GIT_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
		const top = await git(["rev-parse", "--show-toplevel"], cwd);
		if (!top) return undefined;
		const realIndex = resolve(cwd, await git(["rev-parse", "--git-path", "index"], cwd));
		const index = join(scratch, "index");
		if (existsSync(realIndex)) {
			copyFileSync(realIndex, index);
			// Keep the index mtime: git re-hashes "racily clean" entries (files modified
			// no earlier than the index was written). A fresh mtime would make a
			// same-size edit in the same second look unchanged.
			const { atime, mtime } = statSync(realIndex);
			utimesSync(index, atime, mtime);
		}
		await git(["add", "-A", "--", "."], top, { GIT_INDEX_FILE: index });
		const tree = await git(["write-tree"], top, { GIT_INDEX_FILE: index });
		return /^[0-9a-f]{40,64}$/.test(tree) ? tree : undefined;
	} catch {
		return undefined;
	} finally {
		rmSync(scratch, { recursive: true, force: true });
	}
}
