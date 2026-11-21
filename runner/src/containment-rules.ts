// B1/B3 (the first layer): string rules for what an agent holding the user's credentials must not run, on top of the delivery rules in guard.ts. BEST EFFORT.
// A string guard cannot contain an agent (it can write a script and run it later); the barrier is the environment (src/contain.ts), and the detective layer
// is the integrity check around each conversation (src/integrity.ts). These rules make the obvious routes fail early, with a reason the agent can read:
//   - git: `-c`/`--config-env` and `git config` writes (an alias turns `push` into `p`), ref and remote plumbing (update-ref, send-pack, http-push,
//     commit-tree, a writing symbolic-ref, remote writes, forced branch moves), credential helpers;
//   - gh: `api` with a method other than GET, a body (`--input`, `-f`, `-F`, `--field`, `--raw-field`), or graphql; `alias`, `extension`, `auth`, ...;
//   - setting or unsetting the credential and containment variables (inline, `env`, `export`, `unset`);
//   - credential stores by name (`security`, `.git-credentials`, `.netrc`, `.config/gh`, `hosts.yml`, `credential-osxkeychain`);
//   - a shell that reads its program from stdin (a heredoc, a pipe): opaque, so blocked.
// The verifier (read-only) also may not write through a flag (`--output`, `--ext-diff`, `--textconv`) or run an interpreter with inline code.
import { basename, blankHeredocs, SHELLS, tokenize, unwrap } from "../../lib/command-classifier.ts";

const BLOCK = (what: string, why = "the runner contains the agent's credentials"): string => `Blocked by brigadev guard: ${what} (${why}). Use plain git for local work and commit on the branch; the runner pushes and opens the PR.`;

/** The variables that carry credentials or the containment itself: not set, unset, or exported by a command. */
const PROTECTED_VAR = /^(GH_CONFIG_DIR|GH_TOKEN|GITHUB_TOKEN|GH_ENTERPRISE_TOKEN|GITHUB_ENTERPRISE_TOKEN|GH_HOST|GH_PROMPT_DISABLED|GIT_SSH|GIT_SSH_COMMAND|GIT_CONFIG[A-Z0-9_]*|GIT_ASKPASS|GIT_TERMINAL_PROMPT|GIT_DIR|GIT_WORK_TREE|GIT_EXEC_PATH|GIT_EXTERNAL_DIFF|GIT_PROXY_COMMAND|GIT_INDEX_FILE|GCM_INTERACTIVE|SSH_AUTH_SOCK|SSH_AGENT_PID|SSH_ASKPASS|ANTHROPIC_API_KEY|HOME)$/;

/** Wrappers whose arguments may carry assignments (`env A=b cmd`) or flags before the command. Same set as the classifier's. */
const WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate"]);
const VAR_BUILTINS = new Set(["export", "unset", "declare", "typeset", "readonly", "local", "setenv", "set"]);

/** Names of credential stores: a command, a git helper, or a path. */
const CREDENTIAL_STORE = /\.git-credentials\b|\.netrc\b|\.config\/gh(?:\/|\b)|\bhosts\.yml\b|credential-osxkeychain/i;

/** A shell given its program as a heredoc or here-string: `bash <<EOF`, `sh <<< "…"`, `cat <<EOF | sh`. */
const HEREDOC_TO_SHELL = /(?:^|[\s;&|(){}])(?:\S*\/)?(?:bash|sh|zsh|dash|ksh|fish)\b[^\n;&|]*<<-?/;

const GIT_PLUMBING = new Set(["update-ref", "send-pack", "http-push", "commit-tree", "fast-import", "receive-pack"]);
const GIT_VALUE_OPTIONS = new Set(["-C", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--attr-source"]);
const GH_VALUE_OPTIONS = new Set(["-R", "--repo", "--hostname"]);
const GH_BLOCKED_GROUPS = new Set(["alias", "extension", "extensions", "auth", "ssh-key", "gpg-key", "secret", "variable"]);

interface Seg {
	/** The tokens as written (assignments and wrappers included). */
	raw: string[];
	/** The command and its arguments, wrappers and assignments stripped. */
	argv: string[];
}

/** Every command of a string, with the scripts of `bash -c '…'` and `eval` expanded in place of their shell, and `$(…)` and backticks as commands of their own. */
function segmentsOf(command: string, depth = 0): Seg[] {
	const out: Seg[] = [];
	for (const segment of tokenize(blankHeredocs(command.replaceAll("`", ";")), { redirections: true })) {
		if (segment.argv.length === 0) continue;
		const { argv } = unwrap(segment.argv);
		out.push({ raw: segment.argv, argv });
		if (argv.length === 0) continue;
		const name = basename(argv[0]);
		if ((SHELLS.has(name) || name === "eval") && depth < 4) {
			const args = argv.slice(1);
			const flag = name === "eval" ? 0 : args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			const script = name === "eval" ? args.join(" ") : flag >= 0 ? args[flag + 1] : undefined;
			if (script !== undefined) out.push(...segmentsOf(script, depth + 1));
		}
	}
	return out;
}

const varName = (token: string): string => /^([A-Za-z_][A-Za-z0-9_]*)/.exec(token.replace(/^-+/, ""))?.[1] ?? "";

/** The protected variable a segment sets (inline, `env`, `-u`) or touches (`export`, `unset`, ...), or undefined. */
function protectedVar(seg: Seg): string | undefined {
	// The prefix: assignments and wrapper words before the command.
	for (let i = 0; i < seg.raw.length; i++) {
		const token = seg.raw[i];
		const assigned = /^([A-Za-z_][A-Za-z0-9_]*)\+?=/.exec(token)?.[1];
		if (assigned !== undefined) {
			if (PROTECTED_VAR.test(assigned)) return assigned;
			continue;
		}
		if ((token === "-u" || token === "--unset") && PROTECTED_VAR.test(varName(seg.raw[i + 1] ?? ""))) return varName(seg.raw[i + 1]);
		if (WRAPPERS.has(basename(token)) || token.startsWith("-") || /^\d/.test(token)) continue;
		break;
	}
	const name = seg.argv[0] ? basename(seg.argv[0]) : "";
	if (VAR_BUILTINS.has(name)) {
		for (const token of seg.argv.slice(1)) if (!token.startsWith("-") && PROTECTED_VAR.test(varName(token))) return varName(token);
	}
	return undefined;
}

/** The subcommand of a git command line, the global options before it, and its arguments. */
function gitParts(args: string[]): { globals: string[]; sub?: string; rest: string[] } {
	const globals: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (GIT_VALUE_OPTIONS.has(arg) || arg === "-c" || arg === "--config-env") {
			globals.push(arg, args[i + 1] ?? "");
			i++;
			continue;
		}
		if (arg.startsWith("-")) {
			globals.push(arg);
			continue;
		}
		return { globals, sub: arg, rest: args.slice(i + 1) };
	}
	return { globals, rest: [] };
}

const positionals = (args: string[]): string[] => args.filter((arg) => !arg.startsWith("-"));
const hasFlag = (args: string[], ...flags: string[]): boolean => args.some((arg) => flags.includes(arg) || flags.some((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`)));

function gitReason(args: string[]): string | undefined {
	const { globals, sub, rest } = gitParts(args);
	for (const option of globals) {
		if (option === "-c" || /^-c./.test(option)) return BLOCK("git -c sets configuration for one command (an alias can turn `p` into `push`)");
		if (option === "--config-env" || option.startsWith("--config-env=")) return BLOCK("git --config-env sets configuration for one command");
		if (option === "--exec-path" || option.startsWith("--exec-path=")) return BLOCK("git --exec-path runs git commands from a directory of the agent's choosing");
	}
	if (sub === undefined) return undefined;
	if (GIT_PLUMBING.has(sub)) return BLOCK(`git ${sub} writes refs or sends objects to a remote`);
	if (sub.startsWith("credential")) return BLOCK(`git ${sub} reads the credential helpers`);
	if (sub === "symbolic-ref" && (positionals(rest).length >= 2 || hasFlag(rest, "-d", "--delete"))) return BLOCK("git symbolic-ref would move or delete a ref");
	if (sub === "config") {
		const reads = hasFlag(rest, "--get", "--get-all", "--get-regexp", "--get-urlmatch", "--list", "-l", "--show-origin", "--show-scope", "--get-color", "--get-colorbool");
		const writes = hasFlag(rest, "--add", "--unset", "--unset-all", "--replace-all", "--edit", "-e", "--rename-section", "--remove-section", "--unset-all");
		const wide = hasFlag(rest, "--global", "--system", "--file", "-f", "--worktree", "--blob");
		const plainRead = positionals(rest).length === 1 && !writes;
		if (wide || writes || !(reads || plainRead)) return BLOCK("git config changes configuration (aliases, remotes, credential helpers, hooks)");
		if (positionals(rest).some((key) => /^alias\./i.test(key)) && !reads) return BLOCK("git config alias.* defines an alias");
	}
	if (sub === "remote" && positionals(rest).length > 0 && ["add", "set-url", "remove", "rm", "rename", "set-head", "set-branches", "prune", "update"].includes(positionals(rest)[0])) {
		return BLOCK(`git remote ${positionals(rest)[0]} changes where the runner pushes`);
	}
	if (sub === "branch" && hasFlag(rest, "-f", "--force", "-M", "-D")) return BLOCK("git branch with -f, -M, or -D moves or deletes a branch");
	if ((sub === "checkout" || sub === "switch") && hasFlag(rest, "-B", "-C", "--force-create")) return BLOCK(`git ${sub} -B resets a branch`);
	if (sub === "fetch" && rest.some((arg) => !arg.startsWith("-") && (arg.includes(":") || arg.startsWith("+")) && !/^[a-z+.-]+:\/\//i.test(arg) && !/^[\w.-]+@[\w.-]+:/.test(arg))) {
		return BLOCK("git fetch with a refspec writes local refs");
	}
	return undefined;
}

/** `gh api` flags that make a write: a method other than GET, a body, graphql. */
function ghApiReason(args: string[]): string | undefined {
	const write = (what: string) => BLOCK(`gh api ${what} can change GitHub`);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "graphql" || arg.startsWith("graphql?")) return write("graphql");
		if (!arg.startsWith("-")) continue;
		if (arg.startsWith("--")) {
			const name = arg.split("=")[0];
			if (name === "--method") {
				const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : (args[i + 1] ?? "");
				if (value.toUpperCase() !== "GET") return write(`--method ${value}`);
			}
			if (["--input", "--field", "--raw-field"].includes(name)) return write(name);
			continue;
		}
		// A short cluster (`-XPUT`, `-fk=v`, `-if k=v`): letters up to the first one that takes a value.
		for (let c = 1; c < arg.length; c++) {
			const letter = arg[c];
			if (letter === "f" || letter === "F") return write(`-${letter}`);
			if (letter === "X") {
				const value = arg.slice(c + 1) || (args[i + 1] ?? "");
				if (value.toUpperCase() !== "GET") return write(`-X ${value}`);
				break;
			}
			if ("HqtpR".includes(letter)) break;
		}
	}
	return undefined;
}

function ghReason(args: string[]): string | undefined {
	let group: string | undefined;
	let at = 0;
	for (; at < args.length; at++) {
		if (GH_VALUE_OPTIONS.has(args[at])) {
			at++;
			continue;
		}
		if (args[at].startsWith("-")) continue;
		group = args[at];
		break;
	}
	if (group === undefined) return undefined;
	if (GH_BLOCKED_GROUPS.has(group)) return BLOCK(`gh ${group} changes the GitHub login or the tools gh runs`);
	if (group === "api") return ghApiReason(args.slice(at + 1));
	return undefined;
}

/** Positional words of a shell command line that are not flags or redirections: a script file. */
const shellReadsStdin = (args: string[]): boolean => {
	if (args.some((arg) => arg.startsWith("<"))) return true;
	if (args.some((arg) => /^-[a-z]*c[a-z]*$/.test(arg))) return false; // `-c script`: expanded and read as commands
	if (args.includes("-s")) return true;
	return !args.some((arg) => !arg.startsWith("-"));
};

/**
 * Why a command may not run for an agent that holds the user's credentials (worker and verifier alike), or undefined. Best effort: see the file header.
 */
export function containmentReason(command: string): string | undefined {
	if (HEREDOC_TO_SHELL.test(command)) return BLOCK("a shell fed a heredoc or here-string runs a program that cannot be inspected", "the guard reads commands, not scripts");
	if (CREDENTIAL_STORE.test(command)) return BLOCK("it names a credential store (keychain helper, .git-credentials, .netrc, the gh config)", "agents never read the user's credential stores");
	for (const seg of segmentsOf(command)) {
		const set = protectedVar(seg);
		if (set) return BLOCK(`it sets or unsets ${set}, a credential or containment variable`);
		if (seg.argv.length === 0) continue;
		const name = basename(seg.argv[0]);
		const args = seg.argv.slice(1);
		if (name === "security") return BLOCK("the macOS `security` command reads the keychain", "agents never read the user's credential stores");
		if (name.startsWith("git-credential") || name.startsWith("credential-")) return BLOCK(`${name} is a credential helper`, "agents never read the user's credential stores");
		if (SHELLS.has(name) && shellReadsStdin(args)) return BLOCK("a shell reading its program from stdin runs code that cannot be inspected", "the guard reads commands, not scripts");
		const reason = name === "git" ? gitReason(args) : name === "gh" ? ghReason(args) : undefined;
		if (reason) return reason;
	}
	return undefined;
}

const INLINE_CODE: Array<{ name: RegExp; flag: RegExp }> = [
	{ name: /^python[0-9.]*$/, flag: /^-[A-Za-z]*c[A-Za-z]*$/ },
	{ name: /^(node|nodejs|bun|deno)$/, flag: /^(-e|-p|--eval|--print|-pe|-ep)$/ },
	{ name: /^perl[0-9.]*$/, flag: /^-[A-Za-z]*[eEi][A-Za-z]*$/ },
	{ name: /^ruby[0-9.]*$/, flag: /^-[A-Za-z]*e[A-Za-z]*$/ },
	{ name: /^php[0-9.]*$/, flag: /^-r$/ },
];

/** What a read-only conversation may not do beyond the worker's limits: write through a git flag, or run an interpreter on inline code (it can write anywhere). */
export function readOnlyExtraReason(command: string): string | undefined {
	const blocked = (what: string) => `Blocked by brigadev guard: the verifier is read-only (${what}). It never edits, commits, or changes git state; run probes in a scratch copy outside the worktree.`;
	for (const seg of segmentsOf(command)) {
		if (seg.argv.length === 0) continue;
		const name = basename(seg.argv[0]);
		const args = seg.argv.slice(1);
		if (name === "git") {
			const flag = args.find((arg) => /^--(output|ext-diff|textconv)(=|$)/.test(arg));
			if (flag) return blocked(`git ${flag.split("=")[0]} writes files or runs a program`);
		}
		const interpreter = INLINE_CODE.find((entry) => entry.name.test(name));
		if (interpreter && args.some((arg) => interpreter.flag.test(arg))) return blocked(`${name} with inline code can write anywhere`);
	}
	return undefined;
}
