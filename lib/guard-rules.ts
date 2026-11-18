// The guard's decisions as pure functions of plain inputs, so they run in
// tests without the Pi packages that extensions/guard.ts imports. The
// extension reads the facts (paths, environment, git) and acts on the answer.

import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { basename as executableName, blankHeredocs, classifyCommand, tokenize } from "./command-classifier.ts";
import { type BranchFacts, decideWithBranchRule } from "./commit-branch.ts";
import { isWithinSurfaces } from "./edit-surfaces.ts";
import { canonicalPath, expandHome, isInside } from "./paths.ts";
import { type Decision, isSensitivePath, type PermissionMode } from "./permission-policy.ts";
import { isRepoDocsPath } from "./repo-docs.ts";
import type { BrigadevSettings } from "./runtime.ts";

export interface FileAccessInput {
	isChild: boolean;
	/** Canonical absolute path of the target. */
	absolutePath: string;
	projectRoot: string;
	/** Repo docs folder; a function is called only when a parent write lands outside the project. */
	docsDir: string | (() => string);
	/** The path commonly holds secrets. */
	sensitive: boolean;
	/** A subagent without write tools (read-only agent). */
	readOnly: boolean;
	/** Edit surfaces of a writer subagent; undefined means unrestricted. */
	surfaces: string[] | undefined;
	/** Write or edit (default); false for a read. */
	isWrite?: boolean;
	/** The path as the model wrote it, for messages (default: `absolutePath`). */
	rawPath?: string;
	/** Name of the subagent, for messages. */
	agent?: string;
	/** Canonical folders outside the project where a parent write runs without asking (system temp dir, secure-yolo folders). Subagents ignore it. */
	trustedDirs?: readonly string[];
}

/** What to do with the access once any sensitive-path question is settled. */
export type PathVerdict = { action: "allow" } | { action: "block"; reason: string } | { action: "ask"; kind: "outside"; target: string };

/** A sensitive path asks first; `then` is the verdict if the user allows it. */
export type FileAccessDecision = PathVerdict | { action: "ask"; kind: "sensitive"; then: PathVerdict };

const ALLOW: PathVerdict = { action: "allow" };
const block = (reason: string): PathVerdict => ({ action: "block", reason });

export const EVIDENCE_BLOCK =
	"Blocked by brigadev guard: the evidence log is written only by the recorder, so a recorded test result cannot be forged. Read it if you need it; run the tests to add to it.";

/** A write or edit that lands in `<docs>/evidence/` (the folder itself or anything under it). */
function writesEvidence(input: FileAccessInput): boolean {
	if (input.isWrite === false || !/(^|[\\/])evidence([\\/]|$)/.test(input.absolutePath)) return false;
	const docsDir = typeof input.docsDir === "function" ? input.docsDir() : input.docsDir;
	return isInside(canonicalPath(join(docsDir, "evidence")), input.absolutePath);
}

function decideAfterSensitive(input: FileAccessInput): PathVerdict {
	const { isChild, absolutePath, projectRoot } = input;
	if (input.isWrite === false) return ALLOW;

	if (!isInside(projectRoot, absolutePath)) {
		// The parent's harness documents (feature documents, review ledgers) live outside the project by design.
		if (!isChild) {
			const docsDir = typeof input.docsDir === "function" ? input.docsDir() : input.docsDir;
			if (isRepoDocsPath(docsDir, absolutePath)) return ALLOW;
			if (input.trustedDirs?.some((dir) => isInside(dir, absolutePath))) return ALLOW;
		}
		if (isChild) return block(`Blocked by brigadev guard: ${input.rawPath ?? absolutePath} is outside the project root ${projectRoot}.`);
		return { action: "ask", kind: "outside", target: dirname(absolutePath) };
	}

	if (isChild) {
		if (input.readOnly) return block(`Blocked by brigadev guard: ${input.agent ?? "this agent"} is read-only.`);
		const rel = relative(projectRoot, absolutePath).split(sep).join("/");
		if (input.surfaces && !isWithinSurfaces(rel, input.surfaces)) {
			return block(`Blocked by brigadev guard: ${rel} is outside the allowed edit surfaces (${input.surfaces.join(", ")}). Stop and report status: interaction_required with the path you need.`);
		}
	}
	return ALLOW;
}

/**
 * Order: a write into the evidence log is blocked for everyone; then a
 * sensitive path (subagents blocked, the parent asked); then, for writes, the
 * parent-only docs and trusted-folder exemptions, the outside-project rule, and for a subagent
 * inside the project its read-only flag and edit surfaces.
 */
export function decideFileAccess(input: FileAccessInput): FileAccessDecision {
	// The docs folder is only resolved for a path with an `evidence` segment: resolving it runs git.
	if (writesEvidence(input)) return block(EVIDENCE_BLOCK);
	if (input.sensitive) {
		if (input.isChild) return block(`Blocked by brigadev guard: ${input.rawPath ?? input.absolutePath} may hold secrets; subagents never read or write it.`);
		return { action: "ask", kind: "sensitive", then: decideAfterSensitive(input) };
	}
	return decideAfterSensitive(input);
}

// Commands that create, change, or remove files; one of them next to an evidence path is a write.
const WRITE_COMMANDS = new Set(["tee", "cp", "mv", "rm", "ln", "dd", "truncate", "install", "touch", "sed", "awk", "gawk", "perl", "python", "python3", "node", "ruby", "rsync", "unlink", "shred", "chmod", "mkdir", "rmdir", "patch"]);

/** Spellings of an evidence directory a command can use: absolute, `~/`, `$HOME/`, `${HOME}/`, and any `.brigadev/<repo>/evidence` path. */
function evidenceReferences(evidenceDirs: readonly string[], home: string): { literals: string[]; pattern: RegExp } {
	const literals: string[] = [];
	for (const dir of evidenceDirs) {
		for (const form of [dir, canonicalPath(dir)]) {
			literals.push(form);
			if (isInside(home, form) && form !== home) {
				const rest = relative(home, form).split(sep).join("/");
				literals.push(`~/${rest}`, `$HOME/${rest}`, `\${HOME}/${rest}`);
			}
		}
	}
	return { literals, pattern: /\.brigadev\/[^\s'"]*\/?evidence(?![\w-])/ };
}

/** A command that starts in `cwd` (a bg_start working directory) reaches the evidence folder by a relative word, or starts inside it. */
function reachesEvidenceFromCwd(text: string, evidenceDirs: readonly string[], cwd: string): boolean {
	const dirs = evidenceDirs.map((dir) => canonicalPath(dir));
	const inEvidence = (path: string) => dirs.some((dir) => isInside(dir, path));
	if (inEvidence(canonicalPath(cwd))) return true;
	for (const segment of tokenize(text, { redirections: true })) {
		for (const word of [...segment.argv, ...segment.redirects.map((redirect) => redirect.target)]) {
			if (word !== "" && inEvidence(canonicalPath(resolve(cwd, expandHome(word))))) return true;
		}
	}
	return false;
}

/**
 * True when a command both names an evidence directory and writes: an output
 * redirection, or a file-changing command or interpreter. Reading stays
 * allowed (`cat`, `grep`, `ls`, `2>&1`). A best-effort textual rule, like the
 * rest of the command classifier: a deliberately obfuscated command (a path
 * built from variables, `cd` then a relative write) is not caught. With `cwd`
 * (where a background process starts), relative words resolve against it.
 */
export function bashWritesEvidence(command: string, evidenceDirs: readonly string[], home: string = homedir(), cwd?: string): boolean {
	const references = evidenceReferences(evidenceDirs, home);
	const text = blankHeredocs(command);
	const named = references.literals.some((literal) => command.includes(literal)) || references.pattern.test(command);
	if (!named && !(cwd !== undefined && reachesEvidenceFromCwd(text, evidenceDirs, cwd))) return false;
	// File-descriptor duplication (`2>&1`) and `/dev/null` are not writes to a file.
	const redirected = text.replace(/\d*>&[\d-]*/g, " ").replace(/\d*>>?\s*\/dev\/null/g, " ");
	if (/&?>/.test(redirected)) return true;
	return tokenize(text).some((segment) => segment.argv.some((word) => WRITE_COMMANDS.has(executableName(word))));
}

/** Tools that run a shell command string: `bash`, and `bg_start` (a background process, extensions/background-terminals.ts). One set of rules decides all of them. */
export const SHELL_TOOLS: readonly string[] = ["bash", "bg_start"];

/**
 * The command (and, for `bg_start`, the optional working directory as the model wrote it) a shell tool call runs, or
 * undefined for any other tool. A command that is not a string counts as empty, so the rules never see a non-string.
 */
export function shellCallOf(toolName: string, input: unknown): { command: string; cwd?: string } | undefined {
	if (!SHELL_TOOLS.includes(toolName)) return undefined;
	const fields = (input && typeof input === "object" ? input : {}) as { command?: unknown; cwd?: unknown };
	const command = typeof fields.command === "string" ? fields.command : "";
	if (toolName !== "bg_start") return { command };
	return typeof fields.cwd === "string" && fields.cwd.trim() !== "" ? { command, cwd: fields.cwd } : { command };
}

export interface BashDecisionInput {
	command: string;
	mode: PermissionMode;
	isChild: boolean;
	/** The session's working directory, where the command runs. */
	cwd: string;
	/** Reads branch facts of the repository at a directory; called only for a plain `git commit`. */
	readFacts: (cwd: string) => Promise<BranchFacts>;
	/** `cwd` is in another repository than the session's: a commit counts as run elsewhere, like `cd <cwd> && git commit`. */
	elsewhere?: boolean;
}

/** Classifies the command and applies the permission rules, with the feature-branch commit rule reading facts at the session cwd. */
export function decideBashCommand(input: BashDecisionInput): Promise<Decision> {
	const matches = classifyCommand(input.command);
	if (input.elsewhere) for (const match of matches) if (match.commit) match.elsewhere = true;
	return decideWithBranchRule(matches, input.mode, input.isChild, () => input.readFacts(input.cwd));
}

// ---- Trusted folders outside the project: the system temp dir and the secure-yolo folders ----
// A parent `write`/`edit` there runs without asking (subagents stay blocked). The list lives in brigadev.json (`secureYoloDirs`).

/** The system temp directories (canonical). */
export function tempRoots(): string[] {
	return [...new Set([tmpdir(), "/tmp", "/private/tmp"].map((root) => canonicalPath(root)))];
}

/**
 * The system temp roots minus the root folder, the home folder, and its ancestors (a `TMPDIR` set to the home folder would
 * otherwise make every write in it silent). Other overlaps (an agent folder kept under /tmp) are the user's setup: /tmp is
 * writable by every local process anyway.
 */
export function trustedTempRoots(roots: readonly string[], home: string): string[] {
	const canonicalHome = canonicalPath(home);
	return roots.filter((root) => root !== "/" && !isInside(root, canonicalHome));
}

// `.git/config` and everything under `.git/hooks`, in any repository: code that runs later, so never trusted folder content.
const GIT_CONFIG_OR_HOOKS = /(^|\/)\.git\/(config|config\.worktree|hooks(\/|$))/;

/** True for a git config or hook file: a secure-yolo or temp folder that holds repositories must not let the parent plant code there without asking. */
export function isGitConfigOrHooksPath(absolute: string): boolean {
	return GIT_CONFIG_OR_HOOKS.test(canonicalPath(absolute).replace(/\\/g, "/"));
}

/** Facts that decide which paths are protected, whatever the permission mode. */
export interface ProtectedPathContext {
	home: string;
	/** Pi's agent folder (`~/.pi/agent` unless relocated); it holds brigadev.json. */
	agentDir: string;
	/** The installed harness (this package's root). */
	installRoot: string;
	projectRoot: string;
}

const PROTECTED_HOME_FOLDERS = [".pi", ".ssh", ".aws", ".docker", ".gnupg", ".kube", join(".config", "git"), join(".config", "gh"), join(".config", "fish")];
const PROTECTED_HOME_FILES = [".gitconfig", ".netrc", ".npmrc", ".git-credentials", ".bashrc", ".bash_profile", ".bash_login", ".bash_logout", ".profile", ".zshrc", ".zshenv", ".zprofile", ".zlogin", ".zlogout"];

/**
 * True for a path a parent write must always ask about, even under the system temp dir or a secure-yolo folder: the agent folder
 * (brigadev.json holds the trusted folders and the default mode), `~/.pi`, the installed harness (unless it is the project),
 * the home git, gh, fish and credential folders, `~/.gitconfig`, shell startup files, and `.git` config and hooks.
 */
export function isProtectedPath(absolute: string, ctx: ProtectedPathContext): boolean {
	const path = canonicalPath(absolute);
	const home = canonicalPath(ctx.home);
	const folders = [canonicalPath(ctx.agentDir), ...PROTECTED_HOME_FOLDERS.map((folder) => join(home, folder))];
	// A session working on the harness itself edits its own checkout: that is the project, not an installed copy.
	const installRoot = canonicalPath(ctx.installRoot);
	if (!isInside(installRoot, canonicalPath(ctx.projectRoot))) folders.push(installRoot);
	if (folders.some((folder) => isInside(folder, path))) return true;
	if (PROTECTED_HOME_FILES.some((name) => path === join(home, name))) return true;
	return isGitConfigOrHooksPath(path);
}

/** Folders a secure-yolo folder must not overlap with. */
export interface SecureDirGuard {
	home: string;
	/** Pi's agent folder: it holds brigadev.json, where this list lives. */
	agentDir: string;
	/** More folders a silent write must never reach: the harness docs home (every repo's evidence log), the install root. */
	protectedDirs?: readonly string[];
}

// Folders in the home directory that hold credentials or tool config.
const HOME_SECRET_FOLDERS = [".ssh", ".aws", ".docker", ".gnupg", ".kube", join(".config", "gh"), join(".config", "git"), join(".config", "fish")];

// macOS and Windows disks ignore letter case by default, so `~/.AWS` is `~/.aws` there: fold case before comparing.
const foldCase = process.platform === "darwin" || process.platform === "win32";
const fold = (path: string) => (foldCase ? path.toLowerCase() : path);
const overlaps = (a: string, b: string) => isInside(fold(a), fold(b)) || isInside(fold(b), fold(a));

export type SecureDirCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A folder may become a secure-yolo folder when it is absolute (or `~/…`), not the root, not the home folder or
 * one of its ancestors, does not overlap the agent folder (a folder inside it, or one holding it, would let a write
 * change this very list), a credential folder of the home directory, or `protectedDirs`, and does not commonly hold secrets.
 */
export function checkSecureDir(raw: string, guard: SecureDirGuard): SecureDirCheck {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: false, reason: "no folder given" };
	const expanded = expandHome(trimmed);
	if (!isAbsolute(expanded)) return { ok: false, reason: `${trimmed} is not absolute (use /… or ~/…)` };
	const path = canonicalPath(expanded);
	const home = canonicalPath(guard.home);
	const agent = canonicalPath(guard.agentDir);
	if (path === "/" || isInside(fold(path), fold(home))) return { ok: false, reason: `${path} is the root, your home folder, or holds it: too broad` };
	if (overlaps(path, agent)) return { ok: false, reason: `${path} overlaps the agent settings folder ${agent}` };
	const secret = HOME_SECRET_FOLDERS.map((rel) => join(home, rel)).find((dir) => overlaps(path, dir));
	if (secret || isSensitivePath(`${path}/`)) return { ok: false, reason: `${path} is, holds, or sits in a folder that holds credentials (${secret ?? path})` };
	const guarded = (guard.protectedDirs ?? []).map((dir) => canonicalPath(dir)).find((dir) => overlaps(path, dir));
	if (guarded) return { ok: false, reason: `${path} overlaps ${guarded}, which the harness protects` };
	return { ok: true, path };
}

/** The configured secure-yolo folders that pass `checkSecureDir`, canonical and deduplicated; anything else is dropped. */
export function secureYoloDirs(configured: unknown, guard: SecureDirGuard): string[] {
	if (!Array.isArray(configured)) return [];
	const dirs: string[] = [];
	for (const entry of configured) {
		if (typeof entry !== "string") continue;
		const check = checkSecureDir(entry, guard);
		if (check.ok && !dirs.includes(check.path)) dirs.push(check.path);
	}
	return dirs;
}

export interface YoloDirStore {
	read: () => BrigadevSettings;
	write: (update: BrigadevSettings) => void;
}

const YOLO_DIR_USAGE = "Usage: /brigadev:yolo-dir list | add <folder> | remove <folder>";

/** `/brigadev:yolo-dir list|add|remove`: manages `secureYoloDirs` in brigadev.json and names the result. */
export function runYoloDirCommand(args: string, store: YoloDirStore, env: SecureDirGuard & { tempRoots: readonly string[] }): string {
	const trimmed = args.trim();
	const [sub = ""] = trimmed.split(/\s+/);
	const rest = trimmed.slice(sub.length).trim();
	const raw = store.read().secureYoloDirs;
	const configured = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
	const active = secureYoloDirs(configured, env);

	if (sub === "" || sub === "list") {
		const temp = env.tempRoots.map((root) => `  ${root}  (system temp, built in)`);
		const mine = active.map((root) => `  ${root}`);
		const dropped = configured.filter((entry) => !checkSecureDir(entry, env).ok).map((entry) => `  ${entry}  (ignored: ${(checkSecureDir(entry, env) as { reason: string }).reason})`);
		return `Secure-yolo folders (parent write/edit run there without asking; subagents stay blocked):\n${[...temp, ...mine, ...dropped].join("\n")}\n${YOLO_DIR_USAGE}`;
	}
	if (sub === "add") {
		const check = checkSecureDir(rest, env);
		if (!check.ok) return `brigadev: refused, ${check.reason}`;
		if (active.includes(check.path)) return `brigadev: ${check.path} is already a secure-yolo folder`;
		store.write({ secureYoloDirs: [...configured, check.path] });
		return `brigadev: added ${check.path}; write and edit there run without asking`;
	}
	if (sub === "remove") {
		const expanded = expandHome(rest);
		const target = rest === "" ? "" : canonicalPath(expanded);
		const kept = configured.filter((entry) => entry !== rest && canonicalPath(expandHome(entry)) !== target);
		if (rest === "" || kept.length === configured.length) return `brigadev: ${rest || "(none)"} is not a secure-yolo folder`;
		store.write({ secureYoloDirs: kept });
		return `brigadev: removed ${target}`;
	}
	return YOLO_DIR_USAGE;
}
