// Recognizes risky shell commands by their executable form. This is a
// best-effort guard, not a sandbox: it does not expand variables, load
// scripts, or follow aliases. Unknown shapes are allowed, never guessed.

import { tmpdir } from "node:os";

export const COMMAND_KIND = {
	DESTRUCTIVE: "destructive",
	DELIVERY: "delivery",
	PUBLISH: "publish",
	PRIVILEGED: "privileged",
} as const;
export type CommandKind = (typeof COMMAND_KIND)[keyof typeof COMMAND_KIND];

export interface CommandMatch {
	kind: CommandKind;
	reason: string;
	/** Catastrophic forms that are never allowed, whatever the mode. */
	hardDeny?: boolean;
}

const SEPARATORS = new Set([";", "&&", "||", "|", "&", "\n", "(", ")"]);
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "fish", "ksh"]);
// Commands whose arguments are data (search patterns, text), not actions.
const TEXT_COMMANDS = new Set(["grep", "rg", "ag", "echo", "printf", "cat", "less", "head", "tail", "sed", "awk", "jq", "wc"]);
const CATASTROPHIC_RM_TARGETS = new Set(["/", "/*", "~", "~/", "~/*", "$HOME", "${HOME}", "$HOME/", "${HOME}/", ".", "./", "..", "../", "*", "/Users", "/home", "/usr", "/etc", "/var", "/System"]);

interface Segment {
	argv: string[];
	/** Separator that precedes this segment ("" for the first one). */
	before: string;
}

/** Literal heredoc bodies are data, not commands. */
function blankHeredocs(command: string): string {
	return command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n[\s\S]*?\n\2(?=\n|$)/g, (raw) => {
		const header = raw.slice(0, raw.indexOf("\n") + 1);
		return header + " ".repeat(raw.length - header.length);
	});
}

function tokenize(command: string): Segment[] {
	const segments: Segment[] = [];
	let argv: string[] = [];
	let before = "";
	let current = "";
	let inToken = false;
	let quote: "'" | '"' | null = null;

	const pushToken = () => {
		if (inToken) argv.push(current);
		current = "";
		inToken = false;
	};
	const pushSegment = (separator: string) => {
		pushToken();
		if (argv.length > 0) segments.push({ argv, before });
		argv = [];
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

function basename(executable: string): string {
	const slash = executable.lastIndexOf("/");
	return slash === -1 ? executable : executable.slice(slash + 1);
}

/** Strips env assignments and wrapper commands; reports whether sudo was used. */
function unwrap(argv: string[]): { argv: string[]; privileged: boolean } {
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
			return { kind: COMMAND_KIND.DELIVERY, reason: hasAny(rest, "--amend") ? "git commit --amend" : "git commit" };
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
		if (script) matches.push(...classifyCommand(script));
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
			}
			break;
		case "cargo":
			if (args[0] === "publish" || args[0] === "yank") match = { kind: COMMAND_KIND.PUBLISH, reason: `cargo ${args[0]}` };
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
	for (const segment of tokenize(blankHeredocs(command))) {
		matches.push(...classifySegment(segment.argv, segment.before));
	}
	return matches;
}
