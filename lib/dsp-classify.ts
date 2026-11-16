// What DSP mode needs to know about a shell command beyond the normal classification: which actions reach origin or
// a forge, which discard local work, what a script or Makefile target would run, and where a command is too opaque to
// decide. It rides on `classifyCommand`'s options, so normal and yolo never see any of it. Textual and best effort,
// like the rest of the guard: a program that opens its own network connection is not detectable here.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { extractWriteTargets } from "./bash-writes.ts";
import {
	basename,
	classifyCommand,
	COMMAND_KIND,
	gitSubcommand,
	RESERVED_WORDS,
	SHELLS,
	substitutionEnd,
	tokenize,
	VALUE_OPTIONS,
	type ClassifyOptions,
	type CommandKind,
	type CommandMatch,
	type DspTag,
	type SegmentInfo,
} from "./command-classifier.ts";

/** Scripts, Makefiles and package.json files larger than this are not scanned: the command asks instead. */
export const MAX_SCRIPT_BYTES = 256 * 1024;
const MAX_SCAN_DEPTH = 5;
const MAX_ALIAS_DEPTH = 5;
const MAX_SCAN_LINES = 20_000;

export type ScriptRead = { text: string } | { binary: true } | { tooLarge: true } | { missing: true } | { notFile: true } | { error: string };

/** Bounded read of a file a command would run. */
export function readScriptFile(path: string): ScriptRead {
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return { notFile: true };
		if (stat.size > MAX_SCRIPT_BYTES) return { tooLarge: true };
		const bytes = readFileSync(path);
		return bytes.subarray(0, 4096).includes(0) ? { binary: true } : { text: bytes.toString("utf8") };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? { missing: true } : { error: (error as Error).message };
	}
}

export interface DspClassifyEnv {
	/** Directory the command starts in. */
	cwd: string;
	/** Home directory for `~` (default: the user's). */
	home?: string;
	/** Reads a script (default: bounded read from disk). */
	readFile?: (path: string) => ScriptRead;
}

/** Looks up `git config --get alias.<name>`: the expansion, null when there is no such alias, undefined when git could not tell. */
export type AliasLookup = (name: string) => Promise<string | null | undefined>;

interface Scope {
	/** Directory relative paths resolve against; undefined after a `cd` that cannot be followed. */
	dir: string | undefined;
	/** The command has parentheses, so a `cd` may be confined to a subshell the tokenizer does not show. */
	parens: boolean;
}

interface Ctx {
	depth: number;
	/** Text of the command being classified, to tell when it writes the script it runs. */
	commandText: string;
	/** Files being scanned right now, against loops. */
	visited: Set<string>;
}

interface Runtime {
	env: DspClassifyEnv;
	scope: Scope;
	ctx: Ctx;
}

// ── wrappers ────────────────────────────────────────────────────────────────────────────────────────────────

const DSP_WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate", "stdbuf", "setsid", "ionice", "watch"]);
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D", "-R", "--user", "--group", "--host", "--prompt", "--chdir"]),
	doas: new Set(["-u", "-C"]),
	env: new Set(["-u", "--unset", "-C", "--chdir"]),
	exec: new Set(["-a"]),
	time: new Set(["-f", "-o", "--format", "--output"]),
	nice: new Set(["-n", "--adjustment"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	xargs: new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-E", "-a", "-J", "--max-args", "--max-procs", "--replace", "--delimiter", "--arg-file", "--max-lines", "--max-chars", "--eof"]),
	caffeinate: new Set(["-t", "-w"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
	watch: new Set(["-n", "--interval"]),
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Strips wrappers like the normal classifier does, but also each wrapper's options and their values
 * (`nice -n 5`, `timeout -s KILL 30`, `env -u HOME`, `env -S 'git push'`, `xargs -n 1`, `sudo -u me`).
 */
export function dspUnwrap(argv: string[]): { argv: string[]; privileged: boolean } {
	let rest = argv;
	let privileged = false;
	for (let turns = 0; rest.length > 0 && turns < 100; turns++) {
		const head = rest[0];
		if (RESERVED_WORDS.has(head) || ASSIGNMENT.test(head)) {
			rest = rest.slice(1);
			continue;
		}
		const name = basename(head);
		if (!DSP_WRAPPERS.has(name)) break;
		if (name === "sudo" || name === "doas") privileged = true;
		rest = rest.slice(1);
		const values = WRAPPER_VALUE_OPTIONS[name];
		let needsDuration = name === "timeout";
		while (rest.length > 0) {
			const word = rest[0];
			if (word === "--") {
				rest = rest.slice(1);
				break;
			}
			if (name === "env" && (word === "-S" || word === "--split-string") && rest.length > 1) {
				rest = [...tokenize(rest[1]).flatMap((segment) => segment.argv), ...rest.slice(2)];
				continue;
			}
			if (name === "env" && word.startsWith("--split-string=")) {
				rest = [...tokenize(word.slice("--split-string=".length)).flatMap((segment) => segment.argv), ...rest.slice(1)];
				continue;
			}
			if (word.startsWith("-") && word.length > 1) {
				rest = rest.slice(values?.has(word) ? 2 : 1);
				continue;
			}
			if (needsDuration && /^\d/.test(word)) {
				needsDuration = false;
				rest = rest.slice(1);
				continue;
			}
			if (name === "env" && ASSIGNMENT.test(word)) {
				rest = rest.slice(1);
				continue;
			}
			break;
		}
	}
	return { argv: rest, privileged };
}

// ── substitutions ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Command texts that run inside `$( )` and backticks, in the command and in the body of an unquoted heredoc. Single
 * quotes and quoted heredocs are data; double quotes still expand. Nested substitutions are found by recursion.
 */
export function extractSubstitutions(command: string): string[] {
	const found: string[] = [];
	const scan = (text: string, quotes: boolean) => {
		let single = false;
		let double = false;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (single) {
				if (ch === "'") single = false;
				continue;
			}
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === "'" && quotes && !double) {
				single = true;
				continue;
			}
			if (ch === '"' && quotes) {
				double = !double;
				continue;
			}
			if (ch === "$" && text[i + 1] === "(") {
				const end = substitutionEnd(text, i + 2);
				found.push(end === -1 ? text.slice(i + 2) : text.slice(i + 2, end - 1));
				if (end === -1) break;
				i = end - 1;
				continue;
			}
			if (ch === "`") {
				let j = i + 1;
				while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
				found.push(text.slice(i + 1, j));
				i = j;
			}
		}
	};
	const withoutBodies = command.replace(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/g, (raw, quote: string, _delimiter: string, body: string) => {
		if (!quote) scan(body, false);
		return raw.slice(0, raw.indexOf("\n") + 1);
	});
	scan(withoutBodies, true);
	return found;
}

function quote(word: string): string {
	return /^[\w@%+=:,./~-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

// ── shared builders ─────────────────────────────────────────────────────────────────────────────────────────

type RemoteTag = Extract<DspTag, { type: "remote" }>;

function remote(label: string, detail: Partial<Omit<RemoteTag, "type" | "label">> = {}): RemoteTag {
	const tag: RemoteTag = { type: "remote", label };
	for (const [key, value] of Object.entries(detail)) if (value !== undefined && value !== "") (tag as unknown as Record<string, unknown>)[key] = value;
	return tag;
}

const unknownTag = (reason: string, scan = false): DspTag => (scan ? { type: "unknown", reason, scan: true } : { type: "unknown", reason });

function carrier(tags: DspTag[], fallback: CommandKind = COMMAND_KIND.DESTRUCTIVE): CommandMatch {
	const first = tags[0];
	const reason = first.type === "remote" ? first.label : first.type === "unknown" ? first.reason : `DSP: ${first.type}`;
	return { kind: first.type === "remote" ? COMMAND_KIND.DELIVERY : fallback, reason, dsp: tags };
}

const unknownMatch = (reason: string): CommandMatch => carrier([unknownTag(reason)]);

const SQL_REASON = /^(SQL |MongoDB |Redis )/;

/** The match the normal rules made for this very command (not a wrapper's `sudo`, not a SQL pattern). */
function ownMatch(found: CommandMatch[]): CommandMatch | undefined {
	return found.find((match) => match.kind !== COMMAND_KIND.PRIVILEGED && !SQL_REASON.test(match.reason));
}

function attach(found: CommandMatch[], tags: DspTag[]): CommandMatch[] {
	if (tags.length === 0) return found;
	const own = ownMatch(found);
	if (own) own.dsp = [...(own.dsp ?? []), ...tags];
	else found.push(carrier(tags));
	return found;
}

function hasFlag(args: string[], ...flags: string[]): boolean {
	return args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));
}

/** Words that are not options, skipping the value after each of `valueOptions`. Everything after `--` counts. */
function positionals(args: string[], valueOptions: ReadonlySet<string> = new Set()): string[] {
	const found: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			found.push(...args.slice(i + 1));
			break;
		}
		if (valueOptions.has(arg)) i++;
		else if (!arg.startsWith("-") || arg === "-") found.push(arg);
	}
	return found;
}

function optionValue(args: string[], ...names: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		for (const name of names) {
			if (args[i] === name) return args[i + 1];
			if (name.startsWith("--") && args[i].startsWith(`${name}=`)) return args[i].slice(name.length + 1);
		}
	}
	return undefined;
}

// ── git ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Git's own subcommands: anything else may be an alias (or a `git-<name>` program). */
const KNOWN_GIT = new Set(
	`add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential daemon describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch filter-repo fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init instaweb interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email send-pack shell shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree svn switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/),
);

// Keys that reroute where git talks to, run hooks from elsewhere, or hand out credentials.
const RESHAPING_CONFIG_KEY = /^(remote\..+|url\..+|alias\..+|credential\..+|core\.hookspath|push\..+|include\..+|includeif\..+)$/i;
const CONFIG_READ_ONLY = ["--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--name-only", "--show-origin", "--show-scope"];
const PUSH_VALUE_OPTIONS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec", "--signed"]);

/** `-c key=value` overrides in the global options of a git command. */
function gitOverrides(prefix: string[]): Array<[string, string]> {
	const overrides: Array<[string, string]> = [];
	for (let i = 0; i < prefix.length; i++) {
		if (prefix[i] === "-c" && prefix[i + 1] !== undefined) {
			const [key, ...value] = prefix[++i].split("=");
			overrides.push([key, value.join("=")]);
		}
	}
	return overrides;
}

/** DSP facts about a git invocation. `own`: the match the normal rules made for it (only that one is turned into a discard). */
function gitTags(args: string[], own: CommandMatch | undefined): DspTag[] {
	const index = gitSubcommand(args);
	const prefix = index === -1 ? args : args.slice(0, index);
	const tags: DspTag[] = [];
	const overrides = gitOverrides(prefix);
	for (const [key] of overrides) if (RESHAPING_CONFIG_KEY.test(key)) tags.push(remote("git config change"));
	// `--config-env=alias.p=VAR` sets a key from the environment, where the guard cannot see the value.
	if (prefix.some((arg) => arg.startsWith("--config-env"))) tags.push(remote("git config change"));
	if (index === -1) return tags;

	const sub = args[index];
	const rest = args.slice(index + 1);
	const discard = (slug: string, extra: Partial<Extract<DspTag, { type: "discard" }>> = {}) => {
		if (own?.kind === COMMAND_KIND.DESTRUCTIVE) tags.push({ type: "discard", slug, ...extra });
	};
	const history = (label: string) => tags.push({ type: "history", label });

	if (!KNOWN_GIT.has(sub)) {
		const override = overrides.find(([key]) => key.toLowerCase() === `alias.${sub}`.toLowerCase());
		tags.push({ type: "alias", name: sub, prefix, rest, ...(override ? { value: override[1] } : {}) });
		return tags;
	}

	switch (sub) {
		case "push": {
			const [remoteName, ...specs] = positionals(rest, PUSH_VALUE_OPTIONS);
			const tagPush = hasFlag(rest, "--tags", "--follow-tags") || specs.some((spec) => spec.startsWith("refs/tags/") || spec === "tag");
			const deletes = hasFlag(rest, "--delete", "-d") || specs.some((spec) => spec.startsWith(":"));
			const forced = hasFlag(rest, "--force", "-f", "--force-with-lease", "--mirror", "--prune") || specs.some((spec) => spec.startsWith("+"));
			tags.push(remote(tagPush ? "tag push" : deletes ? "push (delete ref)" : forced ? "force push" : "push", { remote: remoteName, ref: specs[0] }));
			break;
		}
		case "remote": {
			const words = positionals(rest);
			if (["add", "set-url", "remove", "rm", "rename", "set-head", "set-branches"].includes(words[0])) tags.push(remote("remote config change", { remote: words[1] }));
			break;
		}
		case "config": {
			if (CONFIG_READ_ONLY.some((flag) => rest.includes(flag))) break;
			const words = rest.filter((arg) => !arg.startsWith("-"));
			if (hasFlag(rest, "-e", "--edit") || words.some((word) => RESHAPING_CONFIG_KEY.test(word))) tags.push(remote("git config change"));
			break;
		}
		case "lfs":
			if (rest[0] === "push") tags.push(remote("push (LFS)"));
			break;
		case "subtree":
			if (rest[0] === "push") tags.push(remote("subtree push"));
			break;
		case "svn":
			if (rest[0] === "dcommit") tags.push(remote("svn dcommit"));
			break;
		case "send-email":
			tags.push(remote("send email"));
			break;
		case "fetch":
		case "pull": {
			// `fetch origin x:main` moves the local main without checking it out.
			const targets = positionals(rest)
				.slice(1)
				.filter((spec) => spec.includes(":"))
				.map((spec) => spec.slice(spec.lastIndexOf(":") + 1).replace(/^refs\/heads\//, ""))
				.filter(Boolean);
			if (targets.length > 0) tags.push({ type: "default-ref", label: `${sub} into a local branch`, names: targets });
			if (sub === "pull") history("pull");
			break;
		}
		case "commit":
			history("commit");
			break;
		case "merge":
		case "cherry-pick":
		case "revert":
		case "am":
			history(sub);
			break;
		case "rebase":
			history("rebase");
			discard("rebase");
			break;
		case "reset": {
			const flagged = hasFlag(rest, "--hard", "--soft", "--mixed", "--merge", "--keep");
			const beforePaths = rest.includes("--") ? rest.slice(0, rest.indexOf("--")) : rest;
			const first = beforePaths.find((arg) => !arg.startsWith("-"));
			if (flagged || (first !== undefined && first !== "HEAD")) history("reset");
			if (hasFlag(rest, "--hard", "--merge", "--keep")) discard("reset-hard");
			break;
		}
		case "clean":
			discard("clean");
			break;
		case "checkout": {
			discard("checkout");
			const forced = optionValue(rest, "-B");
			if (forced) tags.push({ type: "default-ref", label: "checkout -B", names: [forced] });
			break;
		}
		case "switch": {
			discard("switch");
			const forced = optionValue(rest, "-C", "--force-create");
			if (forced) tags.push({ type: "default-ref", label: "switch -C", names: [forced] });
			break;
		}
		case "restore":
			discard("restore");
			break;
		case "branch": {
			const names = rest.filter((arg) => !arg.startsWith("-"));
			const deleting = hasFlag(rest, "-D", "-d", "--delete");
			const moving = hasFlag(rest, "-m", "-M", "--move") || rest.some((arg) => /^-[A-Za-z]*[mM][A-Za-z]*$/.test(arg));
			const forcing = hasFlag(rest, "-f", "--force") || rest.some((arg) => /^-[A-Za-z]*f[A-Za-z]*$/.test(arg));
			if (deleting && (hasFlag(rest, "-D") || forcing)) discard("branch-delete", { branches: names });
			if (deleting) tags.push({ type: "default-ref", label: "delete branch", names });
			else if (moving) tags.push({ type: "default-ref", label: "rename branch", names, current: names.length === 1 });
			else if (forcing && names.length > 0) tags.push({ type: "default-ref", label: "move branch", names: [names[0]] });
			break;
		}
		case "stash":
			if (rest[0] === "drop") discard("stash-drop", { stash: { ref: rest.slice(1).find((arg) => !arg.startsWith("-")) ?? "stash@{0}" } });
			else if (rest[0] === "clear") discard("stash-clear", { stash: "all" });
			break;
		case "worktree":
			discard("worktree-remove");
			break;
		case "update-ref": {
			if (rest.includes("--stdin")) {
				tags.push(unknownTag("git update-ref --stdin can rewrite any ref"));
				break;
			}
			const [ref] = positionals(rest, new Set(["-m"]));
			discard("update-ref", { refs: ref ? [ref] : [] });
			if (ref) tags.push({ type: "default-ref", label: "update-ref", names: [ref.replace(/^refs\/heads\//, "")], current: ref === "HEAD" });
			break;
		}
		case "reflog":
			discard("reflog");
			break;
		case "gc":
			discard("gc-prune");
			break;
		case "filter-branch":
		case "filter-repo":
			discard("filter-branch");
			break;
		default:
			break;
	}
	return tags;
}

// ── gh and hub ──────────────────────────────────────────────────────────────────────────────────────────────

const GH_READ_ACTIONS = new Set(["view", "list", "ls", "status", "checks", "diff", "checkout", "download", "watch", "get", "clone", "browse", "search", "help", "set-default"]);
const GH_LOCAL_GROUPS = new Set(["browse", "search", "status", "completion", "help", "version", "co"]);
const GH_GROUPS = new Set(["pr", "issue", "repo", "release", "workflow", "run", "auth", "alias", "config", "extension", "api", "gist", "secret", "variable", "label", "ssh-key", "gpg-key", "codespace", "cache", "ruleset", "project", "org", "attestation", "copilot", "licenses", "gitignore", "preview", "agent-task"]);
const GH_API_VALUE_OPTIONS = new Set(["-X", "--method", "-H", "--header", "-f", "-F", "--field", "--raw-field", "-q", "--jq", "-t", "--template", "--input", "--hostname", "-p", "--preview", "--cache"]);
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

function ghApiTag(args: string[]): RemoteTag | undefined {
	let method: string | undefined;
	let fields = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-X" || arg === "--method") method = args[++i]?.toUpperCase();
		else if (arg.startsWith("--method=")) method = arg.slice("--method=".length).toUpperCase();
		else if (/^-X./.test(arg)) method = arg.slice(2).toUpperCase();
		else if (["-f", "-F", "--field", "--raw-field", "--input"].includes(arg) || /^--(field|raw-field|input)=/.test(arg) || /^-[fF][^-\s]/.test(arg)) fields = true;
	}
	if (method === "GET" || method === "HEAD") return undefined;
	if (method === undefined && !fields) return undefined;
	return remote(`api ${method ?? "POST"}`, { ref: positionals(args, GH_API_VALUE_OPTIONS)[0] });
}

function ghTags(args: string[]): DspTag[] {
	const repo = optionValue(args, "-R", "--repo");
	const words = positionals(args, new Set(["-R", "--repo", "--hostname"]));
	const [group, action] = words;
	if (group === undefined || GH_LOCAL_GROUPS.has(group)) return [];
	if (group === "api") {
		const tag = ghApiTag(args.slice(args.indexOf("api") + 1));
		return tag ? [{ ...tag, ...(repo ? { repo } : {}) }] : [];
	}
	// Configuration groups: only their `set`/`login`-style actions change anything.
	if (group === "auth") return action === undefined || action === "status" ? [] : [remote("auth change")];
	if (group === "alias") return action === undefined || action === "list" ? [] : [remote("alias change")];
	if (group === "config") return action === undefined || action === "get" || action === "list" ? [] : [remote("config change")];
	if (!GH_GROUPS.has(group)) return [remote(`gh ${group}`)]; // an installed extension: unknown code
	if (action === undefined || action.startsWith("-") || GH_READ_ACTIONS.has(action)) return [];
	if (group === "extension" && ["list", "search", "browse"].includes(action)) return [];
	const base = optionValue(args, "--base", "-B");
	if (group === "pr") return [remote(`PR ${action}`, { repo, base, pr: words[2]?.replace(/^#/, "") })];
	return [remote(`${group} ${action}`, { repo, base })];
}

function hubTags(args: string[]): DspTag[] {
	const index = gitSubcommand(args);
	const sub = index === -1 ? undefined : args[index];
	if (sub === "api") return ghTags(args.slice(index));
	if (sub && ["pull-request", "create", "fork", "release", "issue", "delete", "transfer"].includes(sub)) return [remote(`hub ${sub}`)];
	return [];
}

// ── publish ─────────────────────────────────────────────────────────────────────────────────────────────────

function publishTags(name: string, args: string[]): DspTag[] {
	const publish = (): DspTag[] => [remote("publish", { ref: name })];
	switch (name) {
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun": {
			let words = positionals(args, VALUE_OPTIONS[name] ?? new Set<string>());
			if (name === "yarn" && words[0] === "npm") words = words.slice(1);
			const [sub, next] = words;
			if (["publish", "unpublish", "deprecate", "adduser", "login", "logout", "token"].includes(sub)) return publish();
			if (sub === "dist-tag" && next !== "ls" && next !== "list") return publish();
			if (["owner", "access", "team", "org", "hook"].includes(sub) && next && !["ls", "list", "get", "view"].includes(next)) return publish();
			return [];
		}
		case "cargo":
			return ["publish", "yank", "login", "logout"].includes(args[0]) || (args[0] === "owner" && !hasFlag(args, "--list", "-l")) ? publish() : [];
		case "twine":
			return args[0] === "upload" ? publish() : [];
		case "gem":
			return ["push", "yank", "owner", "signin"].includes(args[0]) ? publish() : [];
		case "poetry":
		case "uv":
		case "flit":
		case "hatch":
			return args[0] === "publish" ? publish() : [];
		case "helm":
			return args[0] === "push" || (args[0] === "registry" && args[1] === "login") ? publish() : [];
		case "docker":
		case "podman":
		case "buildah": {
			const words = positionals(args);
			if (words[0] === "push" || words[0] === "login" || words[0] === "logout") return publish();
			if ((words[0] === "image" || words[0] === "manifest") && words[1] === "push") return publish();
			if (words[0] === "buildx" && words[1] === "imagetools" && words[2] === "create") return publish();
			return hasFlag(args, "--push") ? publish() : [];
		}
		default:
			return [];
	}
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────────────────────────────

const LOOPBACK = /^(https?:\/\/)?(localhost|[\w-]+\.localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0)(:\d+)?([/?#]|$)/i;
const CURL_VALUE_FLAGS = new Set(["-H", "--header", "-o", "--output", "-u", "--user", "-A", "--user-agent", "-e", "--referer", "-b", "--cookie", "-c", "--cookie-jar", "-w", "--write-out", "--connect-timeout", "-m", "--max-time", "-x", "--proxy", "--retry", "--cacert", "--cert", "--key", "-K", "--config", "-r", "--range", "-C", "--continue-at", "--resolve", "--interface", "-E", "--limit-rate"]);
const CURL_DATA_FLAGS = new Set(["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--data-ascii", "-F", "--form", "--form-string", "--json", "-T", "--upload-file"]);

/** A write over HTTP asks unless every URL it names is on this machine. */
function httpWriteTag(urls: string[]): DspTag[] {
	const local = urls.length > 0 && urls.every((url) => LOOPBACK.test(url));
	return local ? [] : [remote("HTTP write", { ref: urls[0] })];
}

function curlTags(args: string[]): DspTag[] {
	let method: string | undefined;
	let data = false;
	let get = false;
	const urls: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-X" || arg === "--request") method = args[++i]?.toUpperCase();
		else if (arg.startsWith("--request=")) method = arg.slice("--request=".length).toUpperCase();
		else if (/^-X./.test(arg)) method = arg.slice(2).toUpperCase();
		else if (arg === "-G" || arg === "--get") get = true;
		else if (CURL_DATA_FLAGS.has(arg)) {
			data = true;
			i++;
		} else if (/^--(data|data-raw|data-binary|data-urlencode|data-ascii|form|form-string|json|upload-file)=/.test(arg) || /^-[dFT]./.test(arg)) data = true;
		else if (/^-[A-Za-z]{2,}$/.test(arg)) {
			// A cluster such as -sSd or -sX: the last letter that takes a value takes the next word.
			const last = arg[arg.length - 1];
			if (last === "X") method = args[++i]?.toUpperCase();
			else if ("dFT".includes(last)) {
				data = true;
				i++;
			} else if (arg.slice(1).split("").some((letter) => "dFT".includes(letter))) data = true;
		} else if (CURL_VALUE_FLAGS.has(arg)) i++;
		else if (!arg.startsWith("-")) urls.push(arg);
	}
	// A method the shell computes (`-X $METHOD`) may be a write.
	const writes = method !== undefined ? WRITE_METHODS.has(method) || /[$`]/.test(method) : data && !get;
	return writes ? httpWriteTag(urls) : [];
}

function wgetTags(args: string[]): DspTag[] {
	const method = optionValue(args, "--method")?.toUpperCase();
	const writes = hasFlag(args, "--post-data", "--post-file", "--body-data", "--body-file") || (method !== undefined && WRITE_METHODS.has(method));
	return writes ? httpWriteTag(positionals(args, new Set(["-O", "-o", "-P", "--header", "--user", "--password", "-e", "-t", "-T"]))) : [];
}

const HTTPIE_VALUE_FLAGS = new Set(["-a", "--auth", "-A", "--auth-type", "-p", "--print", "-s", "--style", "--pretty", "--timeout", "--proxy", "--verify", "--cert", "--cert-key", "-o", "--output", "--session", "--session-read-only", "--max-redirects", "--default-scheme", "--ssl"]);

function httpieTags(args: string[], piped: boolean): DspTag[] {
	const words = positionals(args, HTTPIE_VALUE_FLAGS);
	let method: string | undefined;
	if (words[0] && ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(words[0].toUpperCase())) method = words.shift()!.toUpperCase();
	const [url, ...items] = words;
	const dataItem = (item: string) => /^[^=:]+:=/.test(item) || /^[^=:]+=(?!=)/.test(item) || /^[^=:@]+@/.test(item);
	const writes = method !== undefined ? WRITE_METHODS.has(method) : items.some(dataItem) || piped;
	return writes ? httpWriteTag(url ? [url] : []) : [];
}

// ── files a command deletes or overwrites ───────────────────────────────────────────────────────────────────

const FIND_PREDICATES = /^-(name|iname|path|ipath|wholename|regex|iregex|type|newer|mtime|mmin|atime|ctime|size|empty|user|group|perm|lname|links|inum|samefile)$/;

function filesTag(name: string, args: string[], dir: string | undefined, viaXargs: boolean): DspTag | undefined {
	const base = { type: "files" as const, dir };
	switch (name) {
		case "rm":
			return { ...base, label: "rm", targets: positionals(args), unknown: viaXargs };
		case "shred":
			return { ...base, label: "shred", targets: positionals(args, new Set(["-n", "-s", "--iterations", "--size", "--random-source"])), unknown: viaXargs };
		case "truncate":
			return { ...base, label: "truncate", targets: positionals(args, new Set(["-s", "-r", "--size", "--reference"])), unknown: viaXargs };
		case "dd":
			return { ...base, label: "dd", targets: args.filter((arg) => arg.startsWith("of=")).map((arg) => arg.slice(3)), unknown: viaXargs };
		case "find": {
			let from = 0;
			while (["-H", "-L", "-P"].includes(args[from])) from++;
			const stop = args.findIndex((arg, i) => i >= from && (arg.startsWith("-") || arg === "(" || arg === "!" || arg === ","));
			const starts = args.slice(from, stop === -1 ? undefined : stop);
			// Without a name, type or time filter, `-delete` empties everything below the start (the repository included).
			const filtered = args.some((arg) => FIND_PREDICATES.test(arg));
			return { ...base, label: "find -delete", targets: starts.length > 0 ? starts : ["."], unknown: viaXargs || !filtered, rootOk: true };
		}
		default:
			return undefined;
	}
}

// ── scripts, Makefiles, package scripts ─────────────────────────────────────────────────────────────────────

const INLINE_FLAGS: Record<string, string[]> = { node: ["-e", "--eval", "-p", "--print"], nodejs: ["-e", "--eval", "-p", "--print"], ruby: ["-e"], perl: ["-e", "-E"], php: ["-r"], lua: ["-e"], python: ["-c"] };
const FILE_INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "tsx", "ts-node", "babel-node", "ruby", "perl", "php", "lua", "Rscript", "python"]);
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const UNCERTAIN_CONTENT = /\$[A-Za-z_{(@*#!0-9]|`/;
// Words that start a command somewhere in a line of code (a script is not always shell).
const COMMAND_WORDS = /\b(git|gh|hub|npm|pnpm|yarn|bun|cargo|twine|gem|poetry|uv|flit|helm|docker|podman|buildah|curl|wget|http|https|xh|xhs|bash|sh|zsh|make|gmake|node|python3?|ruby|perl|source)\b|\.\/[\w./-]+/g;

/** Bodies of the heredocs in a command (what a shell or interpreter reads from standard input). */
function heredocBodies(command: string): string[] {
	return [...command.matchAll(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/g)].map((match) => match[3]);
}

/** A shell or interpreter with no script argument reads its program from standard input: a heredoc, a file, or a process substitution. */
function stdinProgramTags(args: string[], rt: Runtime): DspTag[] {
	const tags: DspTag[] = [];
	const redirect = args.findIndex((arg) => arg === "<" || (arg.startsWith("<") && !arg.startsWith("<<") && !arg.startsWith("<(")));
	if (redirect >= 0) {
		const file = args[redirect] === "<" ? args[redirect + 1] : args[redirect].slice(1);
		if (file) tags.push(...scriptFileTags(file, rt));
	}
	for (const body of heredocBodies(rt.ctx.commandText)) tags.push(...describeHits("program from standard input", scanText(body, rt)));
	if (/<\(/.test(rt.ctx.commandText)) tags.push(unknownTag("it runs text from a process substitution, which cannot be checked for remote actions"));
	return tags;
}

const interpreterOf = (name: string) => (/^python[\d.]*$/.test(name) ? "python" : name);

function nestedMatches(text: string, rt: Runtime, depth = rt.ctx.depth): CommandMatch[] {
	return classifyCommand(text, makeOptions(rt.env, { ...rt.scope }, { depth, commandText: text, visited: rt.ctx.visited }));
}

/** What a body of code (a script, a recipe, an inline program) runs that reaches a remote, and why it could not be scanned. */
function scanText(text: string, rt: Runtime): { hits: string[]; unknown: string[] } {
	if (rt.ctx.depth >= MAX_SCAN_DEPTH) return { hits: [], unknown: ["scripts are nested too deeply to scan"] };
	const hits = new Set<string>();
	const unknown = new Set<string>();
	const depth = rt.ctx.depth + 1;
	const collect = (matches: CommandMatch[]) => {
		for (const match of matches) {
			for (const tag of match.dsp ?? []) {
				if (tag.type === "remote") hits.add(tag.label);
				else if (tag.type === "unknown" && tag.scan) unknown.add(tag.reason);
			}
		}
	};
	for (const raw of text.split("\n").slice(0, MAX_SCAN_LINES)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;
		collect(nestedMatches(line, rt, depth));
		// Code such as `execSync("git push")` or `["git", "push"]`: look at what follows each command word.
		const spaced = line.replace(/["'`,[\](){}]/g, " ");
		for (const match of spaced.matchAll(COMMAND_WORDS)) collect(nestedMatches(spaced.slice(match.index), rt, depth));
	}
	return { hits: [...hits], unknown: [...unknown] };
}

function describeHits(label: string, scanned: { hits: string[]; unknown: string[] }): DspTag[] {
	const tags: DspTag[] = [];
	if (scanned.hits.length > 0) tags.push(remote(`${label} runs ${scanned.hits.join(", ")}`));
	for (const reason of scanned.unknown) tags.push(unknownTag(reason, true));
	return tags;
}

/** True when the same file name shows up twice in the command, or the command writes it: it is probably created and run in one go. */
function writtenHere(raw: string, rt: Runtime): boolean {
	const name = basename(raw);
	if (name === "") return false;
	let count = 0;
	for (let at = rt.ctx.commandText.indexOf(name); at !== -1; at = rt.ctx.commandText.indexOf(name, at + name.length)) count++;
	if (count >= 2) return true;
	try {
		return extractWriteTargets(rt.ctx.commandText, rt.scope.dir ?? rt.env.cwd).some((target) => basename(target) === name);
	} catch {
		return false;
	}
}

function resolveFrom(raw: string, rt: Runtime): string | undefined {
	const home = rt.env.home ?? homedir();
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
	if (/[$`]/.test(expanded)) return undefined;
	if (isAbsolute(expanded)) return resolve(expanded);
	return rt.scope.dir === undefined ? undefined : resolve(rt.scope.dir, expanded);
}

const reader = (rt: Runtime) => rt.env.readFile ?? readScriptFile;

/** Tags for running the file `raw`. A file that does not exist is left to fail, unless this very command writes it. */
function scriptFileTags(raw: string, rt: Runtime): DspTag[] {
	const same = () => [unknownTag(`${raw} is written and run in the same command, so its text cannot be checked`, true)];
	const path = resolveFrom(raw, rt);
	if (path === undefined) return [unknownTag(`cannot tell which file ${raw} is (its name or directory is not literal)`, true)];
	if (rt.ctx.visited.has(path)) return [];
	const read = reader(rt)(path);
	if ("missing" in read) return writtenHere(raw, rt) ? same() : [];
	if ("notFile" in read) return [];
	if (writtenHere(raw, rt)) return same();
	if ("error" in read) return [unknownTag(`cannot read script ${raw}: ${read.error}`, true)];
	if ("tooLarge" in read) return [unknownTag(`script ${raw} is too large to scan (over ${MAX_SCRIPT_BYTES / 1024} KB)`, true)];
	if ("binary" in read) return [];
	rt.ctx.visited.add(path);
	try {
		return describeHits(`script ${raw}`, scanText(read.text, rt));
	} finally {
		rt.ctx.visited.delete(path);
	}
}

/** Rules of a Makefile as target -> prerequisites and recipe lines. */
function parseMakefile(text: string): { rules: Map<string, { prerequisites: string[]; recipe: string[] }>; firstGoal: string | undefined } {
	const rules = new Map<string, { prerequisites: string[]; recipe: string[] }>();
	let current: string[] = [];
	let firstGoal: string | undefined;
	for (const line of text.replace(/\\\n/g, " ").split("\n")) {
		if (line.startsWith("\t")) {
			for (const target of current) rules.get(target)?.recipe.push(line.slice(1).replace(/^[@+-]+/, ""));
			continue;
		}
		const rule = /^([^\s#:=][^:=#]*):(?!=)\s*([^#=]*?)\s*(?:#.*)?$/.exec(line);
		if (!rule) {
			if (line.trim() !== "") current = [];
			continue;
		}
		const [prerequisites, inline] = rule[2].split(";");
		current = rule[1].trim().split(/\s+/);
		for (const target of current) {
			const entry = rules.get(target) ?? { prerequisites: [], recipe: [] };
			entry.prerequisites.push(...prerequisites.split(/\s+/).filter(Boolean));
			if (inline?.trim()) entry.recipe.push(inline.trim());
			rules.set(target, entry);
			if (firstGoal === undefined && !target.startsWith(".") && !target.includes("%")) firstGoal = target;
		}
	}
	return { rules, firstGoal };
}

const MAKE_VALUE_OPTIONS = new Set(["-f", "--file", "--makefile", "-C", "--directory", "-j", "--jobs", "-I", "--include-dir", "-o", "--old-file", "-W", "--what-if", "-l", "--load-average"]);

function makeTags(args: string[], rt: Runtime): DspTag[] {
	const file = optionValue(args, "-f", "--file", "--makefile");
	const directory = optionValue(args, "-C", "--directory");
	const targets = positionals(args, MAKE_VALUE_OPTIONS).filter((word) => !word.includes("="));
	const dir = directory === undefined ? rt.scope.dir : resolveFrom(directory, rt);
	if (dir === undefined) return [unknownTag("cannot tell which Makefile make reads (its directory is not literal)", true)];
	const here: Runtime = { ...rt, scope: { ...rt.scope, dir } };
	let text: string | undefined;
	let used = "Makefile";
	for (const candidate of file ? [file] : ["GNUmakefile", "makefile", "Makefile"]) {
		const path = resolveFrom(candidate, here);
		if (path === undefined) return [unknownTag(`cannot tell which Makefile make reads (${candidate})`, true)];
		const read = reader(rt)(path);
		if ("missing" in read) continue;
		if ("text" in read) {
			text = read.text;
			used = candidate;
			break;
		}
		return [unknownTag("tooLarge" in read ? `${candidate} is too large to scan (over ${MAX_SCRIPT_BYTES / 1024} KB)` : `cannot read ${candidate} as a Makefile`, true)];
	}
	if (text === undefined) return [];
	const { rules, firstGoal } = parseMakefile(text);
	const wanted = targets.length > 0 ? targets : firstGoal ? [firstGoal] : [];
	const seen = new Set<string>();
	const recipe: string[] = [];
	const visit = (target: string, depth: number) => {
		if (seen.has(target) || depth > 20) return;
		seen.add(target);
		const rule = rules.get(target);
		if (!rule) return;
		rule.prerequisites.forEach((prerequisite) => visit(prerequisite, depth + 1));
		recipe.push(...rule.recipe);
	};
	wanted.forEach((target) => visit(target, 0));
	return recipe.length === 0 ? [] : describeHits(`${used} target ${wanted.join(" ")}`, scanText(recipe.join("\n"), here));
}

// Subcommands the package managers run themselves, not as a package.json script.
const PACKAGE_BUILTINS = new Set("install i add ci remove rm uninstall update upgrade up exec dlx x init link unlink pack audit outdated ls list why config cache version help info create set get prune rebuild dedupe fund prefix root bin store env doctor fetch patch licenses import login logout whoami ping search star stars repo docs bugs home explain publish unpublish deprecate dist-tag owner access team adduser token".split(" "));

function packageScriptTags(manager: string, args: string[], rt: Runtime): DspTag[] {
	const [sub, next] = positionals(args, VALUE_OPTIONS[manager] ?? new Set());
	let script: string | undefined;
	if (sub === "run" || sub === "run-script" || sub === "rum" || sub === "urn") script = next;
	else if (manager === "npm" && ["test", "t", "tst", "start", "stop", "restart"].includes(sub ?? "")) script = sub === "t" || sub === "tst" ? "test" : sub;
	else if (manager !== "npm" && sub !== undefined && !PACKAGE_BUILTINS.has(sub)) script = sub;
	if (script === undefined) return [];

	// package.json: in the directory or the nearest parent that has one.
	let dir = rt.scope.dir;
	if (dir === undefined) return [unknownTag(`cannot tell which package.json ${manager} reads (the directory is not literal)`, true)];
	for (let up = 0; up < 12; up++) {
		const read = reader(rt)(join(dir, "package.json"));
		if ("missing" in read || "notFile" in read) {
			const parent = dirname(dir);
			if (parent === dir) return [];
			dir = parent;
			continue;
		}
		if (!("text" in read)) return [unknownTag("tooLarge" in read ? "package.json is too large to scan" : "cannot read package.json", true)];
		let scripts: Record<string, unknown>;
		try {
			const parsed = JSON.parse(read.text);
			scripts = parsed && typeof parsed.scripts === "object" && parsed.scripts ? parsed.scripts : {};
		} catch {
			return [unknownTag("cannot read package.json (not valid JSON)", true)];
		}
		const bodies = [`pre${script}`, script, `post${script}`].flatMap((name) => (typeof scripts[name] === "string" ? [scripts[name] as string] : []));
		return bodies.length === 0 ? [] : describeHits(`${manager} script ${script}`, scanText(bodies.join("\n"), { ...rt, scope: { ...rt.scope, dir } }));
	}
	return [];
}

// ── the refine hook ─────────────────────────────────────────────────────────────────────────────────────────

function shellFileArgument(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (SHELL_VALUE_OPTIONS.has(args[i])) i++;
		else if (!args[i].startsWith("-") && !args[i].startsWith("+")) return args[i];
	}
	return undefined;
}

function refineSegment(seg: SegmentInfo, found: CommandMatch[], rt: Runtime): CommandMatch[] {
	const { argv, rawArgv, before } = seg;
	const { scope, env } = rt;
	if (argv.length === 0) return found;
	const head = argv[0];
	const name = basename(head);
	const args = argv.slice(1);
	const home = env.home ?? homedir();

	// The command itself comes from a variable or a substitution.
	if (UNCERTAIN_CONTENT.test(head)) return [...found, unknownMatch(`the command name (${head}) comes from a variable or substitution`)];
	// `/usr/bin/gi?` and `{git,x}` name a command the shell expands.
	if (head !== "[[" && head.length > 1 && /[*?[{]/.test(head)) return [...found, unknownMatch(`the command name (${head}) is a pattern the shell expands`)];
	// A git setting passed through the environment can define an alias or a remote the guard cannot see.
	if (rawArgv.some((word) => /^GIT_CONFIG[A-Z_0-9]*=/.test(word))) found = [...found, carrier([remote("git config change")])];

	// Follow literal directory changes, so relative paths mean what they will mean.
	if (name === "cd" || name === "pushd" || name === "popd") {
		const target = args.find((arg) => !arg.startsWith("-"));
		if (scope.parens || name === "popd") scope.dir = undefined;
		else if (target === undefined) scope.dir = home;
		else if (target === "-" || /[$`*?[{]/.test(target) || /^~[^/]/.test(target)) scope.dir = undefined;
		else if (scope.dir !== undefined || isAbsolute(target) || target.startsWith("~")) {
			const expanded = target === "~" ? home : target.startsWith("~/") ? join(home, target.slice(2)) : target;
			scope.dir = isAbsolute(expanded) ? resolve(expanded) : scope.dir === undefined ? undefined : resolve(scope.dir, expanded);
		}
		return found;
	}

	// A shell run on text: opaque text asks; a shell run on a file scans the file.
	if (SHELLS.has(name) || name === "eval" || name === "source" || name === ".") {
		const scriptIndex = name === "eval" ? 0 : args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
		const script = name === "eval" ? args.join(" ") : scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
		if (script !== undefined) {
			return UNCERTAIN_CONTENT.test(script) ? [...found, unknownMatch(`${name} runs text built from a variable or substitution: it cannot be checked for remote actions`)] : found;
		}
		if (name === "eval") return found;
		const file = name === "source" || name === "." ? args[0] : shellFileArgument(args);
		if (file !== undefined && file !== "<" && !file.startsWith("<")) return attach(found, scriptFileTags(file, rt));
		return attach(found, stdinProgramTags(args, rt));
	}

	const own = ownMatch(found);
	const tags: DspTag[] = [];
	const nested: CommandMatch[] = [];
	let handled = true;

	switch (name) {
		case "git":
			tags.push(...gitTags(args, own));
			break;
		case "hub":
			tags.push(...hubTags(args));
			if (tags.length === 0) tags.push(...gitTags(args, own));
			break;
		case "gh":
			tags.push(...ghTags(args));
			break;
		case "curl":
			tags.push(...curlTags(args));
			break;
		case "wget":
			tags.push(...wgetTags(args));
			break;
		case "http":
		case "https":
		case "xh":
		case "xhs":
			tags.push(...httpieTags(args, before === "|"));
			break;
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun":
			tags.push(...publishTags(name, args), ...packageScriptTags(name, args, rt));
			break;
		case "cargo":
		case "twine":
		case "gem":
		case "poetry":
		case "uv":
		case "flit":
		case "hatch":
		case "helm":
		case "docker":
		case "podman":
		case "buildah":
			tags.push(...publishTags(name, args));
			break;
		case "make":
		case "gmake":
			tags.push(...makeTags(args, rt));
			break;
		case "rm":
		case "shred":
		case "truncate":
		case "dd":
		case "find": {
			if (own?.kind === COMMAND_KIND.DESTRUCTIVE && !own.hardDeny) {
				const tag = filesTag(name, args, scope.dir, rawArgv.some((word) => basename(word) === "xargs"));
				if (tag) tags.push(tag);
			}
			if (name === "find") {
				// `-exec cmd ... ;` runs cmd.
				for (let i = 0; i < args.length; i++) {
					if (!["-exec", "-execdir", "-ok", "-okdir"].includes(args[i])) continue;
					const end = args.findIndex((word, j) => j > i && (word === ";" || word === "+"));
					const words = args.slice(i + 1, end === -1 ? undefined : end);
					if (words.length > 0) nested.push(...nestedMatches(words.map(quote).join(" "), rt));
				}
			}
			break;
		}
		default:
			handled = false;
	}

	if (!handled) {
		// An interpreter running a file or inline code, or a file run directly.
		const interpreter = interpreterOf(name);
		if (FILE_INTERPRETERS.has(interpreter)) {
			const inlineAt = args.findIndex((arg) => (INLINE_FLAGS[interpreter] ?? []).includes(arg));
			if (inlineAt >= 0 && args[inlineAt + 1] !== undefined) {
				tags.push(...describeHits("inline code", scanText(args[inlineAt + 1], rt)));
			} else {
				const candidates = args.filter((arg) => !arg.startsWith("-")).slice(0, 4);
				let scanned = false;
				for (const candidate of candidates) {
					const path = resolveFrom(candidate, rt);
					if (path !== undefined && "missing" in reader(rt)(path)) continue;
					tags.push(...scriptFileTags(candidate, rt));
					scanned = true;
					break;
				}
				if (!scanned && candidates[0] !== undefined && writtenHere(candidates[0], rt)) tags.push(unknownTag(`${candidates[0]} is written and run in the same command, so its text cannot be checked`, true));
				if (!scanned || args.includes("-")) tags.push(...stdinProgramTags(args, rt));
			}
		} else if (head.includes("/")) {
			tags.push(...scriptFileTags(head, rt));
		}
	}

	const result = attach(found, tags);
	result.push(...nested);
	return result;
}

function makeOptions(env: DspClassifyEnv, scope: Scope, ctx: Ctx): ClassifyOptions {
	const rt: Runtime = { env, scope, ctx };
	return {
		unwrap: dspUnwrap,
		inner: extractSubstitutions,
		fork: () => makeOptions(env, { ...scope }, ctx),
		refine: (segment, found) => refineSegment(segment, found, rt),
	};
}

/**
 * The normal classification plus DSP's facts (`CommandMatch.dsp`), for a command that starts in `env.cwd`. Synchronous:
 * unknown git subcommands come back as `alias` tags; `analyzeDsp` resolves them.
 */
export function classifyDsp(command: string, env: DspClassifyEnv): CommandMatch[] {
	const scope: Scope = { dir: resolve(env.cwd), parens: /[()]/.test(command) };
	return classifyCommand(command, makeOptions(env, scope, { depth: 0, commandText: command, visited: new Set() }));
}

/** `classifyDsp`, then every git alias resolved through `gitAlias` and classified as what it expands to. */
export async function analyzeDsp(command: string, env: DspClassifyEnv & { gitAlias?: AliasLookup }, depth = 0): Promise<CommandMatch[]> {
	const out: CommandMatch[] = [];
	for (const match of classifyDsp(command, env)) {
		const alias = match.dsp?.find((tag): tag is Extract<DspTag, { type: "alias" }> => tag.type === "alias");
		if (!alias) {
			out.push(match);
			continue;
		}
		const others = (match.dsp ?? []).filter((tag) => tag.type !== "alias");
		if (others.length > 0) out.push({ ...match, dsp: others });
		if (depth >= MAX_ALIAS_DEPTH) {
			out.push(unknownMatch(`git alias ${alias.name} nests too deeply to resolve`));
			continue;
		}
		let value: string | null | undefined = alias.value;
		if (value === undefined) {
			try {
				value = await env.gitAlias?.(alias.name);
			} catch {
				value = undefined;
			}
		}
		if (value === null) continue; // no such alias: git itself will say so (or it is a `git-<name>` program)
		if (value === undefined) {
			out.push(unknownMatch(`could not resolve git alias ${alias.name}: it may run a remote action`));
			continue;
		}
		const expansion = value.trim();
		const text = expansion.startsWith("!") ? `${expansion.slice(1)} ${alias.rest.map(quote).join(" ")}` : `git ${alias.prefix.map(quote).join(" ")} ${expansion} ${alias.rest.map(quote).join(" ")}`;
		out.push(...(await analyzeDsp(text, env, depth + 1)));
	}
	return out;
}
