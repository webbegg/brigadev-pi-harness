// B2/B3 (the detective layer): what the agent must not change, checked around every conversation that runs its code.
//
// The string guard (src/guard.ts) and the contained environment (src/contain.ts) make misuse hard; neither can see a script the agent wrote and ran later.
// So the runner snapshots what a worker has no business touching before the conversation and compares after it, BEFORE the ticket's `done` check or the
// verdict is trusted: the feature document, the brigadev settings, git's config and hooks, every branch and tag (and where HEAD is), and the remote's refs.
// Any change other than the feature branch moving (its commit, with HEAD staying on it) parks the loop as needs-you with the list; `resume` accepts the state.
//
// Taking a snapshot runs no git hook and no fsmonitor program (every git call carries `-c core.hooksPath=/dev/null -c core.fsmonitor=false`) and reads files with
// fs. The remote's refs are read with the runner's real environment, so they are skipped when the config changed (a changed config could point `ls-remote`
// at a program of the agent's): the config change is reported on its own.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { agentDir } from "../../lib/runtime.ts";
import type { ExecFn } from "../../lib/worktree-snapshot.ts";

const GIT_SAFE = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const GIT_TIMEOUT = 30_000;
const ABSENT = "absent";

/** What was observed; plain JSON (it is memoized in the task's storage). */
export interface Integrity {
	/** sha256 of the feature document, or `absent`. */
	doc: string;
	/** sha256 of `<agent dir>/brigadev.json`, or `absent`. */
	settings: string;
	/** sha256 of each git config file that applies (`git config`, `git config.worktree`, the global files), keyed by a short name. */
	config: Record<string, string>;
	/** sha256 of each file of `<common git dir>/hooks`. */
	hooks: Record<string, string>;
	/** HEAD's symbolic ref (`refs/heads/x`; "" when detached) and commit. */
	head: { ref: string; sha: string };
	/** `refs/heads/*` and `refs/tags/*`: name to commit. */
	refs: Record<string, string>;
	/** The remote's refs (`origin`): name to commit; undefined when there is no `origin`, it could not be read, or it was skipped. */
	remote?: Record<string, string>;
}

export interface IntegrityOptions {
	/** The feature document. */
	docPath: string;
	/** The snapshot taken before: with it, the remote is not asked when the config changed since. */
	previous?: Integrity;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function hashFile(path: string): string {
	try {
		return sha256(readFileSync(path));
	} catch {
		return ABSENT;
	}
}

const git = (exec: ExecFn, cwd: string, ...args: string[]) => exec("git", [...GIT_SAFE, ...args], { cwd, timeout: GIT_TIMEOUT });

/** `<sha> <name>` lines of `for-each-ref` (as formatted below), or `ls-remote`'s `<sha>\t<name>`. */
function parseRefs(output: string): Record<string, string> {
	const refs: Record<string, string> = {};
	for (const line of output.split("\n")) {
		const [sha, name] = line.trim().split(/\s+/);
		if (sha && name) refs[name] = sha;
	}
	return refs;
}

/** The git config files other than the repository's own that apply to every repository of the user. */
function globalConfigs(): Record<string, string> {
	const files: Record<string, string> = {};
	const explicit = process.env.GIT_CONFIG_GLOBAL;
	if (explicit) files["global config"] = hashFile(explicit);
	else {
		files["~/.gitconfig"] = hashFile(join(homedir(), ".gitconfig"));
		files["~/.config/git/config"] = hashFile(join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "git", "config"));
	}
	return files;
}

function hooksOf(dir: string): Record<string, string> {
	const hooks: Record<string, string> = {};
	try {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isFile()) hooks[name] = hashFile(path);
		}
	} catch {
		// No hooks directory: nothing to hash.
	}
	return hooks;
}

export async function takeIntegrity(cwd: string, exec: ExecFn, options: IntegrityOptions): Promise<Integrity> {
	const dirs = await git(exec, cwd, "rev-parse", "--git-dir", "--git-common-dir");
	const [gitDirRaw, commonRaw] = dirs.code === 0 ? dirs.stdout.trim().split("\n") : [];
	const gitDir = gitDirRaw ? resolve(cwd, gitDirRaw) : undefined;
	const common = commonRaw ? resolve(cwd, commonRaw) : undefined;

	const config: Record<string, string> = { ...globalConfigs() };
	if (common) config["git config"] = hashFile(join(common, "config"));
	if (gitDir && existsSync(join(gitDir, "config.worktree"))) config["git config.worktree"] = hashFile(join(gitDir, "config.worktree"));

	const symbolic = await git(exec, cwd, "symbolic-ref", "-q", "HEAD");
	const headSha = await git(exec, cwd, "rev-parse", "-q", "--verify", "HEAD");
	const listed = await git(exec, cwd, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/tags");

	let remote: Record<string, string> | undefined;
	const configChanged = options.previous !== undefined && JSON.stringify(options.previous.config) !== JSON.stringify(config);
	if (!configChanged) {
		const remotes = await git(exec, cwd, "remote");
		if (remotes.code === 0 && remotes.stdout.split("\n").map((name) => name.trim()).includes("origin")) {
			const refs = await git(exec, cwd, "ls-remote", "origin");
			if (refs.code === 0) remote = parseRefs(refs.stdout);
		}
	}

	return {
		doc: hashFile(options.docPath),
		settings: hashFile(join(agentDir(), "brigadev.json")),
		config,
		hooks: common ? hooksOf(join(common, "hooks")) : {},
		head: { ref: symbolic.code === 0 ? symbolic.stdout.trim() : "", sha: headSha.code === 0 ? headSha.stdout.trim() : "" },
		refs: parseRefs(listed.code === 0 ? listed.stdout : ""),
		...(remote ? { remote } : {}),
	};
}

export interface CompareOptions {
	/** The branch the worker commits on: its ref and HEAD's commit may move while HEAD stays on it. Without it, nothing may move. */
	featureBranch?: string;
	/** sha256 of document texts the runner wrote itself (allowed as a change of the document). */
	ownDocHashes?: readonly string[];
}

const changedKeys = (before: Record<string, string>, after: Record<string, string>): string[] =>
	[...new Set([...Object.keys(before), ...Object.keys(after)])].sort().filter((key) => before[key] !== after[key]);

/** The branch name of `refs/heads/<name>`, or the ref itself. */
export const branchOf = (ref: string): string | undefined => (ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : undefined);

/** What changed between two snapshots, as short names for a sentence (`brigadev.json, refs/heads/main, origin refs/heads/x`); empty when nothing but the feature branch moved. */
export function compareIntegrity(before: Integrity, after: Integrity, options: CompareOptions = {}): string[] {
	const changes: string[] = [];
	if (before.doc !== after.doc && !(options.ownDocHashes ?? []).includes(after.doc)) changes.push("the feature document");
	if (before.settings !== after.settings) changes.push("brigadev.json");
	for (const name of changedKeys(before.config, after.config)) changes.push(name);
	for (const name of changedKeys(before.hooks, after.hooks)) changes.push(`git hook ${name}`);

	const featureRef = options.featureBranch ? `refs/heads/${options.featureBranch}` : undefined;
	const stayed = featureRef !== undefined && before.head.ref === featureRef && after.head.ref === featureRef;
	if (before.head.ref !== after.head.ref) changes.push(`HEAD (${before.head.ref || "detached"} to ${after.head.ref || "detached"})`);
	else if (before.head.sha !== after.head.sha && !stayed) changes.push("HEAD");
	for (const name of changedKeys(before.refs, after.refs)) if (!(stayed && name === featureRef)) changes.push(name);
	if (before.remote && after.remote) for (const name of changedKeys(before.remote, after.remote)) changes.push(`origin ${name}`);
	return changes;
}

/** The sentence the loop parks with. */
export const integrityReason = (who: "worker" | "verifier", changes: readonly string[]): string => `the ${who} changed ${changes.join(", ")}; check them, then resume`;

export { sha256 as hashText };
