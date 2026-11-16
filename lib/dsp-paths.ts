// Paths DSP still asks about (S6c), and the project/temp scope its local deletes may touch (S2). Pure of the
// session: the guard supplies the home, agent and install directories.

import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { extractWriteTargets } from "./bash-writes.ts";
import { basename, blankHeredocs, tokenize, unwrap } from "./command-classifier.ts";
import { canonicalPath, isInside } from "./paths.ts";

export interface ProtectedPathContext {
	home: string;
	/** Pi's agent dir (`~/.pi/agent` unless relocated); holds the brigadev settings. */
	agentDir: string;
	/** The installed harness (this package's root). */
	installRoot: string;
	projectRoot: string;
	/** The repo docs folder: its `audit/` is blocked and its `evidence/` protected. A function is called only for a path with an `audit` or `evidence` segment (resolving it runs git). */
	docsDir: string | (() => string);
}

export type ProtectedKind = "audit" | "protected";

// Folders and files in the home directory that hold credentials (S10): the credential lock hides them from the shell, so the tools ask too.
const CREDENTIAL_HOME_FOLDERS = [".ssh", ".docker", ".aws", join(".config", "gh")];
const CREDENTIAL_HOME_FILES = [".netrc", ".npmrc", ".git-credentials", join(".pi", "agent", "auth.json")];

/** True for the home-directory credential stores: `~/.ssh/`, `~/.docker/`, `~/.aws/`, `~/.config/gh/`, `~/.netrc`, `~/.npmrc`, `~/.git-credentials`. DSP asks for any read or write of them. */
export function isCredentialPath(absolute: string, home: string): boolean {
	const path = canonicalPath(absolute);
	const base = canonicalPath(home);
	return CREDENTIAL_HOME_FOLDERS.some((folder) => isInside(join(base, folder), path)) || CREDENTIAL_HOME_FILES.some((file) => path === join(base, file));
}

const SHELL_RC_FILES = [".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout"];
// `.git/config` and everything under `.git/hooks`, in any repository.
const GIT_CONFIG_OR_HOOKS = /(^|\/)\.git\/(config|config\.worktree|hooks(\/|$))/;

/**
 * "audit": the DSP audit log (nobody but the guard writes it, so the write is blocked, not asked).
 * "protected": the harness, Pi, git and gh configuration, hooks, and shell startup files (DSP asks every time).
 * undefined: an ordinary path.
 */
export function protectedPathKind(absolute: string, ctx: ProtectedPathContext): ProtectedKind | undefined {
	const path = canonicalPath(absolute);
	const folders: string[] = [];
	if (/(^|\/)(audit|evidence)(\/|$)/.test(path)) {
		const docsDir = typeof ctx.docsDir === "function" ? ctx.docsDir() : ctx.docsDir;
		if (isInside(canonicalPath(join(docsDir, "audit")), path)) return "audit";
		folders.push(canonicalPath(join(docsDir, "evidence")));
	}

	const home = canonicalPath(ctx.home);
	folders.push(join(home, ".pi"), canonicalPath(ctx.agentDir), join(home, ".config", "git"), join(home, ".config", "gh"), join(home, ".config", "fish"), ...CREDENTIAL_HOME_FOLDERS.map((folder) => join(home, folder)));
	// A session working on the harness itself edits its own checkout: that is the project, not an installed copy.
	const installRoot = canonicalPath(ctx.installRoot);
	if (!isInside(installRoot, canonicalPath(ctx.projectRoot))) folders.push(installRoot);
	if (folders.some((folder) => isInside(folder, path))) return "protected";
	if (path === join(home, ".gitconfig") || SHELL_RC_FILES.some((name) => path === join(home, name)) || CREDENTIAL_HOME_FILES.some((name) => path === join(home, name))) return "protected";
	return GIT_CONFIG_OR_HOOKS.test(path.replace(/\\/g, "/")) ? "protected" : undefined;
}

const REMOVERS = new Set(["rm", "unlink", "rmdir", "shred"]);
const UNRESOLVABLE = /[$`*?[\]{}]/;

/** Protected paths a shell command writes or deletes by literal name (best effort, like the rest of the textual guard). */
export function bashProtectedTargets(command: string, cwd: string, ctx: ProtectedPathContext): Array<{ path: string; kind: ProtectedKind }> {
	const targets = new Set(extractWriteTargets(command, cwd));
	for (const segment of tokenize(blankHeredocs(command))) {
		const { argv } = unwrap(segment.argv);
		if (argv.length === 0 || !REMOVERS.has(basename(argv[0]))) continue;
		for (const arg of argv.slice(1)) {
			if (arg.startsWith("-") || arg === "" || UNRESOLVABLE.test(arg)) continue;
			targets.add(resolve(cwd, arg === "~" ? ctx.home : arg.startsWith("~/") ? join(ctx.home, arg.slice(2)) : arg));
		}
	}
	const found: Array<{ path: string; kind: ProtectedKind }> = [];
	for (const target of targets) {
		const path = canonicalPath(target);
		const kind = protectedPathKind(path, ctx);
		if (kind && !found.some((entry) => entry.path === path)) found.push({ path, kind });
	}
	return found;
}

/** The system temp directories (canonical), where scratch work may be deleted. */
export function tempRoots(): string[] {
	return [...new Set([tmpdir(), "/tmp", "/private/tmp"].map((root) => canonicalPath(root)))];
}

export interface FileScope {
	projectRoot: string;
	home: string;
	tempRoots: readonly string[];
}

/**
 * True when deleting or overwriting `raw` (as written in the command, relative to `dir`) stays inside the project
 * (never the `.git` folder, and the project root itself only with `rootOk`) or strictly inside the system temp dir.
 * Anything the shell would expand (variables, substitutions, `~user`) or that has no known start directory is false.
 */
export function fileTargetWithinScope(raw: string, dir: string | undefined, scope: FileScope, rootOk = false): boolean {
	if (raw === "" || /[$`]/.test(raw) || /^~[^/]/.test(raw)) return false;
	let expanded = raw === "~" ? scope.home : raw.startsWith("~/") ? join(scope.home, raw.slice(2)) : raw;
	if (!isAbsolute(expanded)) {
		if (dir === undefined) return false;
		expanded = resolve(dir, expanded);
	} else expanded = resolve(expanded);

	// With a glob only the part before it is known.
	const parts = expanded.split("/");
	const globAt = parts.findIndex((part) => UNRESOLVABLE.test(part));
	const prefix = globAt === -1 ? expanded : parts.slice(0, globAt).join("/") || "/";
	const path = canonicalPath(prefix);

	if (scope.tempRoots.some((root) => path !== root && isInside(root, path))) return true;
	const projectRoot = canonicalPath(scope.projectRoot);
	if (!isInside(projectRoot, path)) return false;
	const rel = relative(projectRoot, path);
	if (rel === "") return rootOk && globAt === -1;
	return rel.split("/")[0] !== ".git";
}
