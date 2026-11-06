// Recognizes risky shell commands by their executable form. This is a
// best-effort guard, not a sandbox: it does not expand variables, load
// scripts, or follow aliases. Unknown shapes are allowed, never guessed.

import { tmpdir } from "node:os";

export const COMMAND_KIND = {
	DESTRUCTIVE: "destructive",
	DELIVERY: "delivery",
	PUBLISH: "publish",
	PRIVILEGED: "privileged",
	/** Changes installed dependencies or the environment (npm install, pip install, brew upgrade). */
	DEPENDENCY: "dependency",
} as const;
export type CommandKind = (typeof COMMAND_KIND)[keyof typeof COMMAND_KIND];

export interface CommandMatch {
	kind: CommandKind;
	reason: string;
	/** Catastrophic forms that are never allowed, whatever the mode. */
	hardDeny?: boolean;
	/** A `git commit` (set on that match only; kind and reason are unchanged). */
	commit?: boolean;
	/**
	 * Set with `commit` when it may not run in the session's directory or on
	 * its current branch: a preceding `cd`, branch switch, or `-C`/`--git-dir`/
	 * `--work-tree` style redirection.
	 */
	elsewhere?: boolean;
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate"]);
export const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
// Commands whose arguments are data (search patterns, text), not actions.
const TEXT_COMMANDS = new Set(["grep", "rg", "ag", "echo", "printf", "cat", "less", "head", "tail", "sed", "awk", "jq", "wc"]);
const CATASTROPHIC_RM_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "${HOME}/", ".", "./", "..", "../", "*", "/Users", "/home", "/usr", "/etc", "/var", "/System"]);

export interface Redirect {
	/** Output operator: >, >>, >|, >&, &>, &>>. */
	op: string;
	target: string;
}

export interface Segment {
	argv: string[];
	/** Separator that precedes this segment ("" for the first one). */
	before: string;
	/** Output redirections; only filled when tokenizing with `redirections`. */
	redirects: Redirect[];
}

/** Literal heredoc bodies are data, not commands. */
export function blankHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const header = raw.slice(0, raw.indexOf("\n") + 1);
		return header + " ".repeat(raw.length - header.length);
	});
}

/** Index just past the `))` closing an arithmetic expression whose `((` ends at `from`, or -1. */
function arithmeticEnd(text: string, from: number): number {
	let depth = 2;
	let loweredToOneAt = -1;
	for (let j = from; j < text.length; j++) {
		if (text[j] === "(") depth++;
		else if (text[j] === ")") {
			depth--;
			if (depth === 1) loweredToOneAt = j;
			else if (depth === 0) return loweredToOneAt === j - 1 ? j + 1 : -1;
		}
	}
	return -1;
}

/** Index just past the `]]` closing a `[[` whose opening ends at `from`, or -1. */
function conditionalEnd(text: string, from: number): number {
	let quote: "'" | '"' | null = null;
	for (let j = from; j < text.length; j++) {
		const ch = text[j];
		if (quote) {
			if (ch === "\\" && quote === '"') j++;
			else if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") j++;
		else if (ch === "]" && text[j + 1] === "]" && /\s/.test(text[j - 1]) && (j + 2 >= text.length || /[\s;&|)]/.test(text[j + 2]))) return j + 2;
	}
	return -1;
}

/** Index just past the `)` closing a `$(` whose opening ends at `from`, or -1. */
function substitutionEnd(text: string, from: number): number {
	let depth = 1;
	let quote: "'" | '"' | null = null;
	for (let j = from; j < text.length; j++) {
		const ch = text[j];
		if (quote) {
			if (ch === "\\" && quote === '"') j++;
			else if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") j++;
		else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return j + 1;
	}
	return -1;
}

/** Blanks a conditional's text (newlines kept), leaving its `$( )` substitutions, which run as commands. */
function blankAroundSubstitutions(region: string): string {
	let out = "";
	let quote: "'" | '"' | null = null;
	for (let j = 0; j < region.length; j++) {
		const ch = region[j];
		if (quote) {
			if (ch === "\\" && quote === '"') {
				out += region.slice(j, j + 2).replace(/[^\n]/g, " ");
				j++;
				continue;
			}
			if (ch === quote) quote = null;
		} else if (ch === "'" || ch === '"') quote = ch;
		else if (ch === "\\") {
			out += region.slice(j, j + 2).replace(/[^\n]/g, " ");
			j++;
			continue;
		}
		if (quote !== "'" && ch === "$" && region[j + 1] === "(" && region[j + 2] !== "(") {
			const end = substitutionEnd(region, j + 2);
			if (end !== -1) {
				out += blankConditionals(region.slice(j, end));
				j = end - 1;
				continue;
			}
		}
		out += ch === "\n" ? ch : " ";
	}
	return out;
}

/**
 * `(( ))`, `$(( ))` and `[[ ]]` hold comparisons, where `>` is not a
 * redirection. Blanks them (newlines kept) so offsets and line structure
 * stay, except for the `$( )` substitutions inside, which still run.
 */
export function blankConditionals(command: string): string {
	let out = command;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === "\\" && quote === '"') i++;
			else if (ch === quote) quote = null;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "\\") {
			i++;
			continue;
		}
		const atWordStart = i === 0 || /[\s;&|(){]/.test(command[i - 1]);
		let end = -1;
		if (ch === "$" && command.startsWith("((", i + 1)) end = arithmeticEnd(command, i + 3);
		else if (ch === "(" && command[i + 1] === "(" && (i === 0 || !/[\w$]/.test(command[i - 1]))) end = arithmeticEnd(command, i + 2);
		else if (ch === "[" && command[i + 1] === "[" && atWordStart && /\s/.test(command[i + 2] ?? "")) end = conditionalEnd(command, i + 2);
		if (end > i) {
			out = out.slice(0, i) + blankAroundSubstitutions(out.slice(i, end)) + out.slice(end);
			i = end - 1;
		}
	}
	return out;
}

/**
 * Splits a command into segments of words. With `redirections`, unquoted
 * output operators (`>`, `>>`, `>|`, `>&`, `&>`, with an optional fd prefix)
 * and their target word are moved out of argv into `redirects`, and every
 * `(` or `)` is kept as the `before` of a segment, even an empty one, so the
 * scope of a subshell can be followed.
 */
export function tokenize(command: string, options: { redirections?: boolean } = {}): Segment[] {
	const redirections = options.redirections === true;
	const segments: Segment[] = [];
	let argv: string[] = [];
	let redirects: Redirect[] = [];
	let pendingOp: string | null = null;
	let before = "";
	let current = "";
	let inToken = false;
	let quote: "'" | '"' | null = null;

	const pushToken = () => {
		if (inToken) {
			if (pendingOp !== null) redirects.push({ op: pendingOp, target: current });
			else argv.push(current);
			pendingOp = null;
		}
		current = "";
		inToken = false;
	};
	const pushSegment = (separator: string) => {
		pushToken();
		const scopeMarker = redirections && (before === "(" || before === ")");
		if (argv.length > 0 || redirects.length > 0 || scopeMarker) segments.push({ argv, before, redirects });
		argv = [];
		redirects = [];
		pendingOp = null;
		before = separator;
	};

	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = null;
			else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
			else current += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			inToken = true;
			continue;
		}
		if (ch === "\\" && i + 1 < command.length) {
			if (command[i + 1] !== "\n") {
				current += command[i + 1];
				inToken = true;
			}
			i++;
			continue;
		}
		if (redirections && (ch === ">" || (ch === "&" && command[i + 1] === ">"))) {
			// A word of digits right before ">" is the file descriptor, not an argument.
			if (ch === ">" && inToken && /^\d+$/.test(current)) {
				current = "";
				inToken = false;
			} else pushToken();
			let op = ch;
			let next = i + 1;
			if (ch === "&") {
				op += ">";
				next++;
			}
			if (command[next] === ">") {
				op += ">";
				next++;
			} else if (ch === ">" && (command[next] === "|" || command[next] === "&")) {
				op += command[next];
				next++;
			}
			pendingOp = op;
			i = next - 1;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === "&&" || two === "||") {
			pushSegment(two);
			i++;
			continue;
		}
		if (SEPARATORS.has(ch)) {
			pushSegment(ch);
			continue;
		}
		if (ch === " " || ch === "\t") {
			pushToken();
			continue;
		}
		current += ch;
		inToken = true;
	}
	pushSegment("");
	return segments;
}

export function basename(executable: string): string {
	const slash = executable.lastIndexOf("/");
	return slash === -1 ? executable : executable.slice(slash + 1);
}

/** Strips env assignments and wrapper commands; reports whether sudo was used. */
export function unwrap(argv: string[]): { argv: string[]; privileged: boolean } {
	let rest = argv;
	let privileged = false;
	while (rest.length > 0) {
		const head = rest[0];
		if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(head)) {
			rest = rest.slice(1);
			continue;
		}
		const name = basename(head);
		if (!WRAPPERS.has(name)) break;
		if (name === "sudo" || name === "doas") privileged = true;
		rest = rest.slice(1);
		// Skip wrapper options and the timeout duration.
		while (rest.length > 0 && (rest[0].startsWith("-") || (name === "timeout" && /^\d/.test(rest[0])))) rest = rest.slice(1);
	}
	return { argv: rest, privileged };
}

function hasShortFlag(args: string[], letter: string): boolean {
	return args.some((a) => /^-[A-Za-z]+$/.test(a) && a.includes(letter));
}

function hasAny(args: string[], ...flags: string[]): boolean {
	return args.some((a) => flags.includes(a) || flags.some((f) => f.startsWith("--") && a.startsWith(`${f}=`)));
}

/**
 * True for an absolute, literal path strictly inside the system temp dir.
 * Rejects the temp dir itself, "." / ".." / empty segments, and anything the
 * shell could expand (globs, variables, substitutions, tilde).
 */
function isScratchPath(target: string, root: string = tmpdir().replace(/\/+$/, "")): boolean {
	if (!root.startsWith("/") || root.split("/").some((seg) => seg === "." || seg === "..")) return false;
	if (/[*?[\]{}()$`~\\!<>@+^#]/.test(target)) return false;
	if (!target.startsWith(`${root}/`)) return false;
	const segments = target.slice(root.length + 1).replace(/\/$/, "").split("/");
	return segments.every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

// Options that take a separate value, per manager, so the value is not
// mistaken for the subcommand. The same flag can differ: npm -w takes a
// workspace name, pnpm -w means --workspace-root and takes none.
const VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	npm: new Set(["--prefix", "-w", "--workspace", "--registry", "-C"]),
	pnpm: new Set(["--filter", "-F", "-C", "--dir", "--registry"]),
	yarn: new Set(["--cwd", "--registry"]),
	bun: new Set(["--cwd", "--registry"]),
};
const JS_DEPENDENCY_SUBCOMMANDS = new Set(["install", "i", "add", "ci", "remove", "rm", "uninstall", "update", "upgrade", "up"]);

/** First argument that is not an option (or an option's value). */
function firstSubcommand(args: string[], valueOptions: ReadonlySet<string>): { sub: string | undefined; index: number } {
	for (let i = 0; i < args.length; i++) {
		if (valueOptions.has(args[i])) i++;
		else if (!args[i].startsWith("-")) return { sub: args[i], index: i };
	}
	return { sub: undefined, index: -1 };
}

function dependencyMatch(command: string): CommandMatch {
	return { kind: COMMAND_KIND.DEPENDENCY, reason: `${command} changes installed dependencies` };
}

function classifyJsPackageManager(name: string, args: string[]): CommandMatch | undefined {
	const { sub } = firstSubcommand(args, VALUE_OPTIONS[name] ?? new Set());
	if (sub === undefined) {
		// `yarn` alone installs; `yarn --version` and friends do not.
		return name === "yarn" && !hasAny(args, "--version", "-v", "--help", "-h") ? dependencyMatch("yarn install") : undefined;
	}
	return JS_DEPENDENCY_SUBCOMMANDS.has(sub) ? dependencyMatch(`${name} ${sub}`) : undefined;
}

function classifyPip(label: string, args: string[]): CommandMatch | undefined {
	return args[0] === "install" || args[0] === "uninstall" ? dependencyMatch(`${label} ${args[0]}`) : undefined;
}

function classifyRm(args: string[], viaXargs: boolean): CommandMatch | undefined {
	const recursive = hasShortFlag(args, "r") || hasShortFlag(args, "R") || hasAny(args, "--recursive");
	const force = hasShortFlag(args, "f") || hasAny(args, "--force");
	if (!recursive && !force) return undefined;
	// Everything after "--" is a target, even when it starts with a dash.
	const endOfOptions = args.indexOf("--");
	const targets = args.filter((a, i) => (endOfOptions === -1 || i < endOfOptions ? !a.startsWith("-") : i > endOfOptions));
	if (recursive && targets.some((t) => CATASTROPHIC_RM_TARGETS.has(t.replace(/\/+$/, "") || "/") || CATASTROPHIC_RM_TARGETS.has(t))) {
		return { kind: COMMAND_KIND.DESTRUCTIVE, reason: `rm on a root, home, or wildcard target (${targets.join(" ")})`, hardDeny: true };
	}
	// xargs appends targets from stdin, so the visible ones are not the full list.
	if (recursive && !viaXargs && targets.length > 0 && targets.every((t) => isScratchPath(t))) return undefined;
	return { kind: COMMAND_KIND.DESTRUCTIVE, reason: `rm ${recursive ? "recursive" : "forced"} removal` };
}

// Git subcommands that neither move HEAD to another branch nor change which
// repository a later command in the same line acts on.
const STAYS_ON_BRANCH_GIT = new Set(["add", "rm", "mv", "status", "diff", "log", "show", "apply", "fetch", "pull", "push", "commit", "stash", "tag", "blame", "ls-files", "rev-parse", "remote", "describe"]);

// Variables that point git at another repository, work tree, ref store, or index.
const GIT_LOCATION_ASSIGNMENT = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)=/;

/** Any word of the segment assigns a git-location variable (prefix, `env`, `export`, `declare -x`, ...). */
function setsGitLocation(rawArgv: string[]): boolean {
	return rawArgv.some((a) => GIT_LOCATION_ASSIGNMENT.test(a));
}

/** Directory or branch changes by the segment, which make a later `git commit` land somewhere the guard did not inspect. */
function changesCommitTarget(rawArgv: string[]): boolean {
	if (setsGitLocation(rawArgv)) return true;
	const { argv } = unwrap(rawArgv);
	if (argv.length === 0) return false;
	const name = basename(argv[0]);
	const args = argv.slice(1);
	if (name === "cd" || name === "pushd" || name === "popd") return true;
	if (name === "git") {
		const index = gitSubcommand(args);
		return index === -1 || !STAYS_ON_BRANCH_GIT.has(args[index]);
	}
	if (name === "gh") return args.includes("checkout");
	if (SHELLS.has(name) || name === "eval") {
		const scriptIndex = name === "eval" ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
		const script = name === "eval" ? args.join(" ") : scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
		return script !== undefined && tokenize(blankHeredocs(script)).some((segment) => changesCommitTarget(segment.argv));
	}
	return false;
}

/** True when the git invocation targets another repository or work tree than the current directory's. */
function gitTargetsElsewhere(args: string[], rawArgv: string[]): boolean {
	const gitAt = rawArgv.findIndex((a) => basename(a) === "git");
	if (setsGitLocation(rawArgv.slice(0, Math.max(gitAt, 0)))) return true;
	const index = gitSubcommand(args);
	return args.slice(0, Math.max(index, 0)).some((a, i) => a === "-C" || a.startsWith("--git-dir") || a.startsWith("--work-tree") || (a === "-c" && /^core\.(worktree|bare)\b/i.test(args[i + 1] ?? "")));
}

/** Returns the git subcommand index, skipping global options such as -C <dir>. */
function gitSubcommand(args: string[]): number {
	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		if (a === "-C" || a === "-c" || a === "--git-dir" || a === "--work-tree" || a === "--namespace") {
			i++;
			continue;
		}
		if (a.startsWith("-")) continue;
		return i;
	}
	return -1;
}

function classifyGit(args: string[]): CommandMatch | undefined {
	const index = gitSubcommand(args);
	if (index === -1) return undefined;
	const sub = args[index];
	const rest = args.slice(index + 1);
	const destructive = (reason: string): CommandMatch => ({ kind: COMMAND_KIND.DESTRUCTIVE, reason: `git ${reason}` });

	switch (sub) {
		case "reset":
			return hasAny(rest, "--hard", "--merge", "--keep") ? destructive("reset discards work") : undefined;
		case "clean":
			return (hasShortFlag(rest, "f") || hasAny(rest, "--force")) && !(hasShortFlag(rest, "n") || hasAny(rest, "--dry-run"))
				? destructive("clean deletes untracked files")
				: undefined;
		case "checkout":
			return hasAny(rest, "--", ".", "-f", "--force") ? destructive("checkout discards changes") : undefined;
		case "restore": {
			const onlyStaged = hasAny(rest, "--staged", "-S") && !hasAny(rest, "--worktree", "-W");
			return onlyStaged ? undefined : destructive("restore discards working-tree changes");
		}
		case "switch":
			return hasAny(rest, "--discard-changes", "-f", "--force") ? destructive("switch discards changes") : undefined;
		case "branch":
			return hasAny(rest, "-D") || (hasAny(rest, "--delete", "-d") && hasAny(rest, "--force", "-f"))
				? destructive("branch force-delete")
				: undefined;
		case "stash":
			return rest[0] === "drop" || rest[0] === "clear" ? destructive(`stash ${rest[0]}`) : undefined;
		case "rebase":
			return destructive("rebase rewrites history");
		case "filter-branch":
		case "filter-repo":
			return destructive(`${sub} rewrites history`);
		case "reflog":
			return rest[0] === "expire" || rest[0] === "delete" ? destructive(`reflog ${rest[0]}`) : undefined;
		case "gc":
			return rest.some((a) => a.startsWith("--prune")) ? destructive("gc prune") : undefined;
		case "update-ref":
			return hasAny(rest, "-d") ? destructive("update-ref delete") : undefined;
		case "worktree":
			return rest[0] === "remove" && hasAny(rest, "-f", "--force") ? destructive("worktree force-remove") : undefined;
		case "push": {
			const forced = hasAny(rest, "--force", "-f", "--force-with-lease", "--mirror", "--delete", "-d", "--prune");
			const forcedRefspec = rest.some((a) => !a.startsWith("-") && (a.startsWith("+") || a.startsWith(":")));
			if (forced || forcedRefspec) return destructive("push rewrites or deletes remote refs");
			return { kind: COMMAND_KIND.DELIVERY, reason: "git push" };
		}
		case "commit":
			return { kind: COMMAND_KIND.DELIVERY, reason: hasAny(rest, "--amend") ? "git commit --amend" : "git commit", commit: true };
		default:
			return undefined;
	}
}

function classifyGh(args: string[]): CommandMatch | undefined {
	const [group, action] = args;
	if (group === "repo" && (action === "delete" || action === "archive")) {
		return { kind: COMMAND_KIND.DESTRUCTIVE, reason: `gh repo ${action}` };
	}
	if ((group === "pr" && action === "merge") || (group === "release" && ["create", "delete", "upload", "edit"].includes(action))) {
		return { kind: COMMAND_KIND.PUBLISH, reason: `gh ${group} ${action}` };
	}
	if ((group === "pr" || group === "issue") && ["create", "comment", "review", "edit", "close", "reopen"].includes(action)) {
		return { kind: COMMAND_KIND.DELIVERY, reason: `gh ${group} ${action}` };
	}
	if (group === "api") {
		const all = args.slice(1);
		const methodIndex = all.findIndex((a) => a === "-X" || a === "--method");
		const method = methodIndex >= 0 ? all[methodIndex + 1]?.toUpperCase() : all.find((a) => a.startsWith("--method="))?.split("=")[1]?.toUpperCase();
		if (method === "DELETE") return { kind: COMMAND_KIND.DESTRUCTIVE, reason: "gh api DELETE" };
		if (method && method !== "GET") return { kind: COMMAND_KIND.DELIVERY, reason: `gh api ${method}` };
		if (all.some((a) => a === "-f" || a === "-F" || a === "--field" || a === "--raw-field")) {
			return { kind: COMMAND_KIND.DELIVERY, reason: "gh api with fields (POST)" };
		}
	}
	return undefined;
}

const SQL_PATTERNS: Array<[RegExp, string]> = [
	[/\bDROP\s+(TABLE|DATABASE|SCHEMA|VIEW|INDEX|COLLECTION)\b/i, "SQL DROP"],
	[/\bTRUNCATE\s+(TABLE\s+)?[`"\w]/i, "SQL TRUNCATE"],
	[/\bDELETE\s+FROM\s+[`"\w.]+\s*(;|$)(?![\s\S]*\bWHERE\b)/i, "SQL DELETE without WHERE"],
	[/\.dropDatabase\s*\(|\.drop\s*\(\s*\)/, "MongoDB drop"],
	[/\bFLUSH(ALL|DB)\b/i, "Redis flush"],
];

function classifySegment(rawArgv: string[], before: string): CommandMatch[] {
	const { argv, privileged } = unwrap(rawArgv);
	const matches: CommandMatch[] = [];
	if (privileged) matches.push({ kind: COMMAND_KIND.PRIVILEGED, reason: "elevated privileges (sudo)" });
	if (argv.length === 0) return matches;

	const name = basename(argv[0]);
	const args = argv.slice(1);

	if (SHELLS.has(name) || name === "eval") {
		const scriptIndex = name === "eval" ? 0 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
		const script = name === "eval" ? args.join(" ") : scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
		if (script) {
			const nested = classifyCommand(script);
			// A location variable set on the wrapper applies to every git call inside its script.
			if (setsGitLocation(rawArgv)) for (const match of nested) if (match.commit) match.elsewhere = true;
			matches.push(...nested);
		}
		else if (before === "|") matches.push({ kind: COMMAND_KIND.PRIVILEGED, reason: `piping into ${name} executes downloaded or generated code` });
		return matches;
	}

	if (TEXT_COMMANDS.has(name)) return matches;

	let match: CommandMatch | undefined;
	switch (name) {
		case "rm":
			match = classifyRm(args, rawArgv.some((a) => basename(a) === "xargs"));
			break;
		case "git":
			match = classifyGit(args);
			if (match?.commit && gitTargetsElsewhere(args, rawArgv)) match.elsewhere = true;
			break;
		case "gh":
			match = classifyGh(args);
			break;
		case "find":
			if (args.includes("-delete") || args.some((a, i) => (a === "-exec" || a === "-execdir") && basename(args[i + 1] ?? "") === "rm")) {
				match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "find deletes files" };
			}
			break;
		case "shred":
		case "wipefs":
		case "truncate":
			match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: `${name} destroys file contents` };
			break;
		case "dd":
			if (args.some((a) => a.startsWith("of=/dev/"))) match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "dd writes to a device", hardDeny: true };
			else if (args.some((a) => a.startsWith("of="))) match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "dd overwrites a file" };
			break;
		case "diskutil":
			if (args.some((a) => /^(erase|zero|secureErase|partitionDisk)/i.test(a))) match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "diskutil erases a disk", hardDeny: true };
			break;
		case "dropdb":
			match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "dropdb" };
			break;
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			if (args[0] === "publish" || args[0] === "unpublish" || (args[0] === "dist-tag" && args[1] !== "ls")) {
				match = { kind: COMMAND_KIND.PUBLISH, reason: `${name} ${args[0]}` };
			} else {
				match = classifyJsPackageManager(name, args);
			}
			break;
		case "pip":
		case "pip3":
			match = classifyPip(name, args);
			break;
		case "python":
		case "python3":
			if (args[0] === "-m" && (args[1] === "pip" || args[1] === "pip3")) match = classifyPip(`${name} -m ${args[1]}`, args.slice(2));
			break;
		case "uv":
			if (args[0] === "pip") match = classifyPip("uv pip", args.slice(1));
			else if (["add", "remove", "sync"].includes(args[0])) match = dependencyMatch(`uv ${args[0]}`);
			break;
		case "poetry":
			if (["add", "remove", "install", "update"].includes(args[0])) match = dependencyMatch(`poetry ${args[0]}`);
			break;
		case "go":
			if (args[0] === "get" || args[0] === "install") match = dependencyMatch(`go ${args[0]}`);
			break;
		case "brew":
			if (["install", "uninstall", "upgrade"].includes(args[0])) match = dependencyMatch(`brew ${args[0]}`);
			break;
		case "gem":
			if (args[0] === "install") match = dependencyMatch("gem install");
			break;
		case "cargo":
			if (args[0] === "publish" || args[0] === "yank") match = { kind: COMMAND_KIND.PUBLISH, reason: `cargo ${args[0]}` };
			else if (["add", "remove", "install"].includes(args[0])) match = dependencyMatch(`cargo ${args[0]}`);
			break;
		case "twine":
			if (args[0] === "upload") match = { kind: COMMAND_KIND.PUBLISH, reason: "twine upload" };
			break;
		case "docker":
		case "podman":
			if (args[0] === "push") match = { kind: COMMAND_KIND.PUBLISH, reason: `${name} push` };
			else if (args[0] === "system" && args[1] === "prune") match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: `${name} system prune` };
			break;
		case "prisma":
			if (args[0] === "migrate" && args[1] === "reset") match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "prisma migrate reset" };
			break;
		case "rails":
		case "rake":
			if (args.some((a) => /^db:(drop|reset|purge)/.test(a))) match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: `${name} ${args.find((a) => a.startsWith("db:"))}` };
			break;
		default:
			if (/^mkfs(\.|$)/.test(name)) match = { kind: COMMAND_KIND.DESTRUCTIVE, reason: "mkfs formats a filesystem", hardDeny: true };
	}
	if (match) matches.push(match);

	const text = argv.join(" ");
	for (const [pattern, reason] of SQL_PATTERNS) {
		if (pattern.test(text)) {
			matches.push({ kind: COMMAND_KIND.DESTRUCTIVE, reason });
			break;
		}
	}
	return matches;
}

/** Classifies every recognizable risky segment of a shell command. */
export function classifyCommand(command: string): CommandMatch[] {
	const matches: CommandMatch[] = [];
	let moved = false;
	for (const segment of tokenize(blankHeredocs(command))) {
		const found = classifySegment(segment.argv, segment.before);
		if (moved) for (const match of found) if (match.commit) match.elsewhere = true;
		matches.push(...found);
		moved ||= changesCommitTarget(segment.argv);
	}
	return matches;
}
