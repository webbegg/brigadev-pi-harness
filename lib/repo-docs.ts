// Harness documents (feature documents, review ledgers) live outside the
// project, in `<brigadev home>/<repo>/`, so nothing the harness writes lands
// in the repository.

import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { canonicalPath, expandHome, isInside } from "./paths.ts";

const GIT_TIMEOUT_MS = 5_000;
const FALLBACK_NAME = "project";

/** `~/.brigadev`, or `BRIGADEV_HOME` when set (tests and relocated setups). */
export function brigadevHome(env: NodeJS.ProcessEnv = process.env): string {
	const override = env.BRIGADEV_HOME?.trim();
	return override ? resolve(expandHome(override)) : join(homedir(), ".brigadev");
}

/**
 * Basename of the main worktree root, so every worktree of a repository
 * shares one folder. Outside git (or for a bare or submodule layout, where
 * the common dir is not a `.git` folder), the basename of `cwd`.
 */
export function repoName(cwd: string): string {
	const own = basename(resolve(cwd)) || FALLBACK_NAME;
	try {
		const common = execFileSync("git", ["rev-parse", "--git-common-dir"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS }).trim();
		// Canonical, because at the checkout root git prints a relative `.git` (through any symlink in cwd) and from a worktree the real absolute path.
		const commonDir = canonicalPath(resolve(cwd, common));
		return common && basename(commonDir) === ".git" ? basename(dirname(commonDir)) || own : own;
	} catch {
		return own;
	}
}

/** Folder for this repository's harness documents: `tasks/` and `reviews/` live inside it. */
export function repoDocsDir(cwd: string, env: NodeJS.ProcessEnv = process.env): string {
	return join(brigadevHome(env), repoName(cwd));
}

/** True when `target` is the docs folder or inside it, symlinks and `..` resolved. */
export function isRepoDocsPath(docsDir: string, target: string): boolean {
	return isInside(canonicalPath(docsDir), canonicalPath(target));
}
