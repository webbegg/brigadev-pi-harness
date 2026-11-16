// What DSP mode needs to know about a shell command beyond the normal classification: which actions reach origin or
// a forge, which discard local work, what a script or Makefile target would run, and where a command is too opaque to
// decide. It rides on `classifyCommand`'s options, so normal and yolo never see any of it. Textual and best effort,
// like the rest of the guard: a program that opens its own network connection is not detectable here.

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { extractWriteTargets } from "./bash-writes.ts";
import { AGENT_VARIABLES, isLockedVariable, OVERRIDDEN_VARIABLES } from "./dsp-credlock.ts";
import { isCredentialPath } from "./dsp-paths.ts";
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
	/** An earlier part of the command changed directory (`cd`, `pushd`, `popd`) or set a git location variable: a git command after it may act on another repository. */
	repoMoved?: boolean;
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

const DSP_WRAPPERS = new Set(["sudo", "doas", "env", "command", "builtin", "nohup", "time", "nice", "exec", "xargs", "timeout", "caffeinate", "stdbuf", "setsid", "ionice", "watch", "chroot", "unshare", "sshpass", "busybox", "toybox", "unbuffer", "chronic", "taskset", "chrt", "systemd-run", "firejail", "numactl", "cpulimit", "trickle", "proxychains", "proxychains4", "torsocks", "sandbox-exec", "arch", "taskpolicy"]);
/** Wrappers whose first words (after the options) name something other than the command. */
const WRAPPER_SKIP_POSITIONALS: Record<string, number> = { chroot: 1, taskset: 1, chrt: 1 };
const WRAPPER_VALUE_OPTIONS: Record<string, ReadonlySet<string>> = {
	sudo: new Set(["-u", "-g", "-h", "-p", "-C", "-r", "-t", "-T", "-U", "-D", "-R", "--user", "--group", "--host", "--prompt", "--chdir"]),
	doas: new Set(["-u", "-C"]),
	// macOS: `arch [-x86_64|-arm64|-arch NAME] [-e VAR=VAL] [-d VAR] cmd`, `taskpolicy [-c clamp] [-t tier] [-l tier] [-g|-d policy] cmd`.
	arch: new Set(["-arch", "-e", "-d"]),
	taskpolicy: new Set(["-c", "-t", "-l", "-g", "-d", "-p"]),
	env: new Set(["-u", "--unset", "-C", "--chdir"]),
	taskset: new Set(["-c", "--cpu-list"]),
	exec: new Set(["-a"]),
	time: new Set(["-f", "-o", "--format", "--output"]),
	nice: new Set(["-n", "--adjustment"]),
	timeout: new Set(["-s", "-k", "--signal", "--kill-after"]),
	xargs: new Set(["-n", "-I", "-P", "-L", "-s", "-d", "-E", "-a", "-J", "--max-args", "--max-procs", "--replace", "--delimiter", "--arg-file", "--max-lines", "--max-chars", "--eof"]),
	caffeinate: new Set(["-t", "-w"]),
	stdbuf: new Set(["-i", "-o", "-e"]),
	ionice: new Set(["-c", "-n", "-p", "-P", "-u"]),
	watch: new Set(["-n", "--interval"]),
	sshpass: new Set(["-p", "-f", "-d", "-P"]),
	chroot: new Set(["--userspec", "--groups"]),
	numactl: new Set(["-C", "-N", "-m", "-i", "-p", "-c", "-w", "--physcpubind", "--cpunodebind", "--membind", "--interleave", "--preferred", "--preferred-many", "--weighted-interleave"]),
	"systemd-run": new Set(["-u", "--unit", "-p", "--property", "-E", "--setenv", "--slice", "-M", "--machine", "-H", "--host", "--description", "--uid", "--gid", "--working-directory", "--on-active", "--on-boot", "--on-startup", "--on-unit-active", "--on-unit-inactive", "--on-calendar", "--timer-property", "--service-type", "--nice", "-d"]),
	cpulimit: new Set(["-l", "--limit", "-p", "--pid", "-e", "--exe", "-P", "--path", "-c", "--cpu"]),
	trickle: new Set(["-d", "-u", "-w", "-t", "-l", "-n"]),
	proxychains: new Set(["-f"]),
	proxychains4: new Set(["-f"]),
	torsocks: new Set(["-a", "--address", "-P", "--port", "-u", "--user", "-p", "--pass", "--password"]),
	"sandbox-exec": new Set(["-p", "-f", "-n", "-D"]),
	unshare: new Set(["-R", "-w", "-S", "-G", "--root", "--wd", "--setuid", "--setgid", "--propagation", "--map-user", "--map-group", "--map-users", "--map-groups"]),
};
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** Words a wrapper such as `xargs` or `parallel` adds to its command from outside the command line (standard input, `:::`). */
export interface XargsInfo {
	/** Replacement strings (`xargs -I{}`): where the input is substituted into the command. */
	replace: string[];
	/** Placeholder syntax (parallel's `{}`, `{1}`, `{.}`). */
	placeholder?: RegExp;
}

export interface UnwrapResult {
	argv: string[];
	privileged: boolean;
	xargs?: XargsInfo;
	/** Why a wrapper's command could not be read (it comes from a file, standard input, a script file, ...). */
	opaque?: string[];
	/** What `env` or `exec` did to the directory and the environment (`-C dir`, `-u NAME`, `-i`). */
	env?: EnvInfo;
	/** `env -C dir`: the directory the command runs in (`classifyCommand` reads it as a move for a git command). */
	chdir?: string;
}

export interface EnvInfo {
	chdir?: string;
	unset: string[];
	/** `env -i`, `env -`, `exec -c`: the command starts with an empty environment (the credential lock is gone). */
	clear: boolean;
}

function noteEnvOption(info: EnvInfo, word: string, next: string | undefined) {
	if (word === "-C" || word === "--chdir") info.chdir = next;
	else if (word.startsWith("--chdir=")) info.chdir = word.slice("--chdir=".length);
	else if (/^-C./.test(word)) info.chdir = word.slice(2);
	else if (word === "-u" || word === "--unset") info.unset.push(next ?? "");
	else if (word.startsWith("--unset=")) info.unset.push(word.slice("--unset=".length));
	else if (/^-u./.test(word)) info.unset.push(word.slice(2));
	else if (word === "--ignore-environment" || /^-[A-Za-z]*i[A-Za-z]*$/.test(word)) info.clear = true;
}

function collectReplace(info: XargsInfo, word: string, next: string | undefined) {
	if ((word === "-I" || word === "-J") && next !== undefined) info.replace.push(next);
	else if (/^-[IJ]./.test(word)) info.replace.push(word.slice(2));
	else if (word === "-i" || word === "--replace") info.replace.push("{}");
	else if (/^-i./.test(word)) info.replace.push(word.slice(2));
	else if (word.startsWith("--replace=")) info.replace.push(word.slice("--replace=".length));
}

// Runners that take the command as a text or after their own operands: `su -c 'cmd'`, `script -q /dev/null cmd`, ...
const RUNNERS = new Set(["su", "runuser", "sg", "script", "flock", "osascript", "parallel", "npx", "npm", "pnpm", "yarn", "bun", "bunx", "uv", "uvx", "poetry", "pdm", "pipenv", "rye", "hatch", "pipx", "bundle", "tmux", "screen", "pnpx", "mise", "rtx", "direnv", "nix-shell", "nix", "conda", "mamba", "micromamba", "devbox", "pixi", "asdf"]);
const SU_VALUES = new Set(["-s", "--shell", "-g", "--group", "-G", "--supp-group", "-w", "--whitelist-environment"]);
const SCRIPT_VALUES = new Set(["-T", "-I", "-O", "-B", "-E", "-m", "-F", "-t", "--timing", "--log-in", "--log-out", "--log-io", "--log-timing", "--logging-format", "--echo", "--output-limit"]);
const FLOCK_VALUES = new Set(["-w", "--timeout", "--wait", "-E", "--conflict-exit-code"]);
const PARALLEL_VALUES = new Set(["-j", "--jobs", "-n", "--max-args", "-N", "-L", "--max-lines", "-S", "--sshlogin", "--sshloginfile", "--slf", "-a", "--arg-file", "--arg-file-sep", "--colsep", "-C", "-d", "--delimiter", "-I", "--replace", "-E", "--eof", "--results", "--joblog", "--tagstring", "--timeout", "--retries", "--delay", "--load", "--memfree", "--rpl"]);
const PARALLEL_MARKER = /^::::?\+?$/;
const MISE_VALUES = new Set(["-C", "--cd", "-j", "--jobs", "-E", "--env"]);
const NIX_VALUES = new Set(["--option", "--extra-experimental-features", "-I", "--arg", "--argstr", "-E", "--expr", "-A", "--attr", "-j", "--max-jobs", "--override-input", "--keep", "--exclude", "--include", "--profile"]);
const CONDA_VALUES = new Set(["-n", "--name", "-p", "--prefix", "-r", "--root-prefix", "--cwd", "-a", "--attach"]);
const DEVBOX_VALUES = new Set(["-c", "--config", "-e", "--env", "--env-file"]);
const PIXI_VALUES = new Set(["--manifest-path", "-e", "--environment", "--color", "--platform"]);
/** Registries `nix run <registry>#<program>` takes a program from by name. */
const NIX_REGISTRY_PROGRAM = /^(?:nixpkgs(?:\/[^#]*)?|nixpkgs-unstable|nixos-[\w.-]+)#([\w.+-]+)/;

interface RunnerResult {
	rest: string[];
	privileged?: boolean;
	opaque?: string;
	xargs?: XargsInfo;
	/** Do not unwrap further: `rest` is the runner itself. */
	stop?: boolean;
}

const shellText = (text: string): string[] => ["sh", "-c", text];

/** The text after one of `flags` (`--run 'cmd'`, `--run=cmd`), skipping the values of the other options. */
function flagText(args: string[], flags: readonly string[], values: ReadonlySet<string> = new Set()): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (flags.includes(arg)) return args[i + 1];
		const joined = flags.find((flag) => flag.startsWith("--") && arg.startsWith(`${flag}=`));
		if (joined) return arg.slice(joined.length + 1);
		if (values.has(arg)) i++;
	}
	return undefined;
}

/** A launcher's command: the text after a shell flag (`-c 'text'`), or the words after `--` (`mise exec node@20 -- npm test`). */
function dashedCommand(args: string[], flags: readonly string[]): RunnerResult | undefined {
	const dashes = args.indexOf("--");
	const text = flagText(dashes === -1 ? args : args.slice(0, dashes), flags);
	if (text !== undefined) return { rest: shellText(text) };
	return dashes !== -1 && args.length > dashes + 1 ? { rest: args.slice(dashes + 1) } : undefined;
}

/** The text after `-c`/`--command` (also in a cluster such as `-lc`, or `--command=text`). `stopAtOperand`: only options before the first operand count. */
function commandText(args: string[], valueOptions: ReadonlySet<string>, stopAtOperand = false): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return undefined;
		if (arg === "--command") return args[i + 1];
		if (arg.startsWith("--command=")) return arg.slice("--command=".length);
		if (/^-[A-Za-z]*c$/.test(arg)) return args[i + 1];
		if (valueOptions.has(arg)) i++;
		else if (stopAtOperand && !arg.startsWith("-")) return undefined;
	}
	return undefined;
}

/** Words after the options and `skip` operands. */
function afterOptions(args: string[], valueOptions: ReadonlySet<string>, skip: number): string[] {
	let optionsDone = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (!optionsDone && arg === "--") {
			optionsDone = true;
			continue;
		}
		if (!optionsDone && arg.startsWith("-") && arg.length > 1) {
			if (valueOptions.has(arg)) i++;
			continue;
		}
		if (skip > 0) {
			skip--;
			continue;
		}
		return args.slice(i);
	}
	return [];
}

/** The shell commands of every `do shell script "..."` in AppleScript, or why they cannot be read. */
function appleScriptCommands(text: string): { commands: string[]; opaque?: string } {
	const commands: string[] = [];
	for (const found of text.matchAll(/do\s+shell\s+script\b/gi)) {
		const tail = text.slice(found.index + found[0].length).trimStart();
		if (!tail.startsWith('"')) return { commands, opaque: "osascript runs a shell script that is not a plain string" };
		let literal = "";
		let i = 1;
		for (; i < tail.length && tail[i] !== '"'; i++) {
			if (tail[i] === "\\" && i + 1 < tail.length) {
				i++;
				literal += tail[i] === "n" ? "\n" : tail[i] === "t" ? "\t" : tail[i];
			} else literal += tail[i];
		}
		if (i >= tail.length) return { commands, opaque: "osascript runs a shell script that is not a plain string" };
		if (tail.slice(i + 1).trimStart().startsWith("&")) return { commands, opaque: "osascript builds its shell script from several parts" };
		commands.push(literal);
	}
	return { commands };
}

// Package runners and terminal multiplexers: the words after their own options are the command they run.
const NPX_VALUES = new Set(["-p", "--package", "--registry", "--cache", "--userconfig", "-w", "--workspace", "--prefix"]);
const BUNX_VALUES = new Set(["-p", "--package", "--cwd"]);
const EXEC_VALUES = new Set(["-p", "--package", "-w", "--workspace", "--prefix", "--registry", "--filter", "-F", "-C", "--dir", "--cwd"]);
const UV_VALUES = new Set(["--with", "--with-editable", "--with-requirements", "--from", "-p", "--python", "--project", "--directory", "--env-file", "--package", "--extra", "--group", "--only-group", "--no-group", "--index", "--default-index", "--index-url", "--extra-index-url", "--config-file", "--cache-dir", "--python-preference"]);
const PIPX_VALUES = new Set(["--spec", "--python", "--index-url", "--pip-args"]);
const TMUX_GLOBAL_VALUES = new Set(["-f", "-L", "-S", "-T"]);
const TMUX_VALUES = new Set(["-s", "-n", "-t", "-c", "-x", "-y", "-e", "-F", "-l", "-p", "-N", "-f"]);
/** tmux commands that run a shell command (or type one into a pane). */
const TMUX_RUNNERS = new Set(["new", "new-session", "neww", "new-window", "splitw", "split-window", "respawn-pane", "respawnp", "respawn-window", "respawnw", "run", "run-shell", "if", "if-shell", "send", "send-keys", "pipep", "pipe-pane", "popup", "display-popup"]);

/** The first word that is not an option (skipping the values of `values`) and the words after it. */
function subcommandAt(args: string[], values: ReadonlySet<string>): { sub: string; rest: string[] } | undefined {
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--") return undefined;
		if (values.has(args[i])) i++;
		else if (!args[i].startsWith("-")) return { sub: args[i], rest: args.slice(i + 1) };
	}
	return undefined;
}

/** The command a package launcher runs: the text after its shell flag (`npm exec -c 'text'`), or the words after its options. */
function launched(args: string[], values: ReadonlySet<string>, shellFlags: readonly string[] = []): RunnerResult | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args.length > i + 1 ? { rest: args.slice(i + 1) } : undefined;
		const flag = shellFlags.find((name) => arg === name || (name.startsWith("--") && arg.startsWith(`${name}=`)));
		if (flag) return { rest: shellText(arg === flag ? (args[i + 1] ?? "") : arg.slice(flag.length + 1)) };
		if (values.has(arg)) i++;
		else if (!arg.startsWith("-")) return { rest: args.slice(i) };
	}
	return undefined;
}

/** `tmux new -d 'cmd'`, `tmux run-shell 'cmd'`, `tmux send-keys 'cmd' Enter`, `tmux -c 'cmd'`. */
function tmuxCommand(args: string[]): RunnerResult | undefined {
	let i = 0;
	for (; i < args.length; i++) {
		if (args[i] === "-c") return { rest: shellText(args[i + 1] ?? "") };
		if (TMUX_GLOBAL_VALUES.has(args[i])) i++;
		else if (!args[i].startsWith("-")) break;
	}
	const sub = args[i];
	if (sub === undefined || !TMUX_RUNNERS.has(sub)) return undefined;
	const words = positionals(args.slice(i + 1), TMUX_VALUES);
	return words.length === 0 ? undefined : { rest: shellText(words.join(/^if/.test(sub) ? "\n" : " ")) };
}

/** `screen -dm cmd`, `screen -dmS name cmd`, `screen -X stuff 'cmd'`. */
function screenCommand(args: string[]): RunnerResult | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return args.length > i + 1 ? { rest: args.slice(i + 1) } : undefined;
		if (arg === "-X") {
			const [command, ...words] = args.slice(i + 1);
			if (command === "stuff" && words[0] !== undefined) return { rest: shellText(words[0].replace(/(\\n|\\r|\^M|\r|\n)+$/, "")) };
			const typed = command === "exec" ? words.filter((word) => !/^[.!]+$/.test(word)) : [];
			return typed.length > 0 ? { rest: typed } : undefined;
		}
		if (/^-(r|R|RR|x|ls|list|wipe|v)$/.test(arg)) return undefined;
		if (arg === "-Logfile") i++;
		else if (/^-[A-Za-z]+$/.test(arg)) {
			// A cluster such as -dmS: its last letter takes the next word when it takes a value.
			if ("StcpheTs".includes(arg[arg.length - 1])) i++;
		} else if (!arg.startsWith("-")) return { rest: args.slice(i) };
	}
	return undefined;
}

/** Runners that take the command as text or after their own operands: the command they run, when it can be read. */
function unwrapRunner(name: string, args: string[]): RunnerResult | undefined {
	switch (name) {
		case "su":
		case "runuser": {
			const at = name === "runuser" ? args.findIndex((arg) => arg === "-u" || arg === "--user" || arg.startsWith("--user=")) : -1;
			if (at >= 0) {
				const after = args.slice(args[at].includes("=") ? at + 1 : at + 2);
				const command = after[0] === "--" ? after.slice(1) : after;
				return command.length > 0 ? { rest: command, privileged: true } : undefined;
			}
			const text = commandText(args, SU_VALUES);
			return text === undefined ? undefined : { rest: shellText(text), privileged: true };
		}
		case "sg": {
			const words = afterOptions(args, new Set(), 0).filter((word) => !word.startsWith("-"));
			return words.length >= 2 ? { rest: shellText(words[1]) } : undefined;
		}
		case "script": {
			const text = commandText(args, SCRIPT_VALUES, true);
			if (text !== undefined) return { rest: shellText(text) };
			// BSD form: script [options] file command ...
			const command = afterOptions(args, SCRIPT_VALUES, 1);
			if (command.length === 0) return undefined;
			return command[0].startsWith("-") ? { rest: ["script", ...args], opaque: "script runs a command the guard cannot read", stop: true } : { rest: command };
		}
		case "flock": {
			const text = commandText(args, FLOCK_VALUES, true);
			if (text !== undefined) return { rest: shellText(text) };
			const command = afterOptions(args, FLOCK_VALUES, 1);
			return command.length > 0 ? { rest: command } : undefined;
		}
		case "osascript": {
			const scripts: string[] = [];
			let operand = false;
			for (let i = 0; i < args.length; i++) {
				if (args[i] === "-e" && args[i + 1] !== undefined) scripts.push(args[++i]);
				else if (args[i] === "-l" || args[i] === "-s") i++;
				else if (!args[i].startsWith("-")) operand = true;
			}
			const opaque = (reason: string): RunnerResult => ({ rest: ["osascript", ...args], opaque: reason, stop: true });
			if (scripts.length === 0) return operand ? opaque("osascript runs a script file, which cannot be checked for remote actions") : undefined;
			const text = scripts.join("\n");
			if (/doShellScript|NSTask|\bObjC\b|\$\.NS|\bdo\s+script\b|write\s+text|\brun\s+script\b|\bdo\s+JavaScript\b/i.test(text)) return opaque("osascript can run commands the guard cannot read");
			const { commands, opaque: reason } = appleScriptCommands(text);
			if (reason) return opaque(reason);
			return commands.length > 0 ? { rest: shellText(commands.join("\n")), privileged: /with\s+administrator\s+privileges/i.test(text) } : undefined;
		}
		case "parallel": {
			const remoteHost = args.some((arg) => ["-S", "--sshlogin", "--sshloginfile", "--slf"].includes(arg) || /^(-S.|--sshlogin=|--sshloginfile=|--slf=)/.test(arg));
			// Input redirections (`< cmds.txt`, `<<< text`) are not part of the command template.
			const words: string[] = [];
			const operands = afterOptions(args, PARALLEL_VALUES, 0);
			for (let i = 0; i < operands.length; i++) {
				if (operands[i] === "<" || operands[i] === "<<" || operands[i] === "<<<") i++;
				else if (!/^<[^(]/.test(operands[i])) words.push(operands[i]);
			}
			const marker = words.findIndex((word) => PARALLEL_MARKER.test(word));
			const template = marker === -1 ? words : words.slice(0, marker);
			const sources = marker === -1 ? [] : words.slice(marker);
			const host = remoteHost ? "parallel -S runs its commands on another host" : undefined;
			if (template.length > 0) return { rest: template, xargs: { replace: [], placeholder: /\{[^{}\s]*\}/ }, ...(host ? { opaque: host } : {}) };
			// No command template: the arguments after `:::` are the commands.
			const literal = sources[0] === ":::" ? sources.slice(1) : [];
			const end = literal.findIndex((word) => PARALLEL_MARKER.test(word));
			if (sources[0] === ":::" && end === -1) return { rest: shellText(literal.join("\n")), ...(host ? { opaque: host } : {}) };
			return { rest: ["parallel", ...args], opaque: "parallel takes its commands from a file or standard input", stop: true };
		}
		case "npx":
			return launched(args, NPX_VALUES, ["-c", "--call"]);
		case "bunx":
			return launched(args, BUNX_VALUES);
		case "uvx":
			return launched(args, UV_VALUES);
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun": {
			const found = subcommandAt(args, VALUE_OPTIONS[name] ?? new Set());
			const launchers = name === "npm" ? ["exec", "x"] : name === "bun" ? ["x"] : ["exec", "dlx"];
			if (!found || !launchers.includes(found.sub)) return undefined;
			return launched(found.rest, EXEC_VALUES, name === "npm" || name === "pnpm" ? ["-c", "--call", "--shell-mode"] : []);
		}
		case "uv": {
			const found = subcommandAt(args, UV_VALUES);
			if (!found) return undefined;
			if (found.sub === "tool" && found.rest[0] === "run") return launched(found.rest.slice(1), UV_VALUES);
			if (found.sub !== "run") return undefined;
			const run = launched(found.rest, UV_VALUES);
			// `uv run script.py` runs the script with python.
			return run && /\.py$/.test(run.rest[0]) ? { rest: ["python", ...run.rest] } : run;
		}
		case "poetry":
		case "pdm":
		case "pipenv":
		case "rye":
		case "hatch":
		case "pipx":
		case "bundle": {
			const found = subcommandAt(args, new Set());
			if (!found || found.sub !== (name === "bundle" ? "exec" : "run")) return undefined;
			return launched(found.rest, name === "pipx" ? PIPX_VALUES : new Set());
		}
		case "pnpx":
			return launched(args, NPX_VALUES, ["-c", "--call"]);
		case "mise":
		case "rtx": {
			const found = subcommandAt(args, MISE_VALUES);
			return found && (found.sub === "x" || found.sub === "exec") ? dashedCommand(found.rest, ["-c", "--command"]) : undefined;
		}
		case "direnv": {
			const found = subcommandAt(args, new Set());
			const command = found?.sub === "exec" ? afterOptions(found.rest, new Set(), 1) : [];
			return command.length > 0 ? { rest: command } : undefined;
		}
		case "asdf": {
			const found = subcommandAt(args, new Set());
			return found?.sub === "exec" ? launched(found.rest, new Set()) : undefined;
		}
		case "nix-shell": {
			const text = flagText(args, ["--run", "--command"], NIX_VALUES);
			return text === undefined ? undefined : { rest: shellText(text) };
		}
		case "nix": {
			const found = subcommandAt(args, NIX_VALUES);
			if (!found) return undefined;
			if (found.sub === "develop" || found.sub === "shell") {
				const at = found.rest.findIndex((arg) => arg === "-c" || arg === "--command");
				return at >= 0 && found.rest.length > at + 1 ? { rest: found.rest.slice(at + 1) } : undefined;
			}
			if (found.sub !== "run") return undefined;
			// `nix run nixpkgs#git -- push` runs git; any other flake app is code the guard cannot read.
			const program = NIX_REGISTRY_PROGRAM.exec(found.rest.find((arg) => !arg.startsWith("-")) ?? "");
			const dashes = found.rest.indexOf("--");
			if (program) return { rest: [program[1], ...(dashes === -1 ? [] : found.rest.slice(dashes + 1))] };
			return { rest: ["nix", ...args], opaque: "nix run runs a flake app the guard cannot read", stop: true };
		}
		case "conda":
		case "mamba":
		case "micromamba": {
			const found = subcommandAt(args, CONDA_VALUES);
			return found?.sub === "run" ? launched(found.rest, CONDA_VALUES) : undefined;
		}
		case "devbox":
		case "pixi": {
			const found = subcommandAt(args, name === "pixi" ? PIXI_VALUES : DEVBOX_VALUES);
			return found?.sub === "run" ? launched(found.rest, name === "pixi" ? PIXI_VALUES : DEVBOX_VALUES) : undefined;
		}
		case "tmux":
			return tmuxCommand(args);
		case "screen":
			return screenCommand(args);
		default:
			return undefined;
	}
}

/**
 * Strips wrappers like the normal classifier does, but also each wrapper's options and their values
 * (`nice -n 5`, `timeout -s KILL 30`, `env -u HOME`, `env -S 'git push'`, `xargs -n 1`, `sudo -u me`).
 */
export function dspUnwrap(argv: string[]): UnwrapResult {
	let rest = argv;
	let privileged = false;
	let xargs: XargsInfo | undefined;
	const opaque: string[] = [];
	const envInfo: EnvInfo = { unset: [], clear: false };
	for (let turns = 0; rest.length > 0 && turns < 100; turns++) {
		const head = rest[0];
		if (RESERVED_WORDS.has(head) || ASSIGNMENT.test(head)) {
			rest = rest.slice(1);
			continue;
		}
		const name = basename(head);
		if (RUNNERS.has(name)) {
			const run = unwrapRunner(name, rest.slice(1));
			if (!run) break;
			rest = run.rest;
			privileged ||= run.privileged === true;
			if (run.opaque) opaque.push(run.opaque);
			if (run.xargs) xargs = { replace: [...(xargs?.replace ?? []), ...run.xargs.replace], placeholder: run.xargs.placeholder ?? xargs?.placeholder };
			if (run.stop) break;
			continue;
		}
		if (!DSP_WRAPPERS.has(name)) break;
		if (name === "sudo" || name === "doas" || name === "chroot") privileged = true;
		if (name === "xargs") xargs ??= { replace: [] };
		// The service manager starts the command with its own environment, so the credential lock does not reach it.
		if (name === "systemd-run") opaque.push("systemd-run starts the command from the service manager, outside the credential lock");
		rest = rest.slice(1);
		const values = WRAPPER_VALUE_OPTIONS[name];
		let needsDuration = name === "timeout";
		let skip = WRAPPER_SKIP_POSITIONALS[name] ?? 0;
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
			// `env -S'cmd'` (the string attached) and `env -iS 'cmd'` (after a cluster of flags).
			const attached = name === "env" ? /^-([iv0]*)S([\s\S]+)$/.exec(word) : null;
			if (attached) {
				if (attached[1].includes("i")) envInfo.clear = true;
				rest = [...tokenize(attached[2]).flatMap((segment) => segment.argv), ...rest.slice(1)];
				continue;
			}
			const cluster = name === "env" ? /^-([iv0]+)S$/.exec(word) : null;
			if (cluster && rest.length > 1) {
				if (cluster[1].includes("i")) envInfo.clear = true;
				rest = [...tokenize(rest[1]).flatMap((segment) => segment.argv), ...rest.slice(2)];
				continue;
			}
			if (name === "env" && word === "-") {
				envInfo.clear = true;
				rest = rest.slice(1);
				continue;
			}
			if (word.startsWith("-") && word.length > 1) {
				if (name === "xargs" && xargs) collectReplace(xargs, word, rest[1]);
				if (name === "env") noteEnvOption(envInfo, word, rest[1]);
				if (name === "exec" && /^-[a-z]*c[a-z]*$/.test(word)) envInfo.clear = true;
				// `taskset -c 0,1 cmd` has no mask operand.
				if (name === "taskset" && (word === "-c" || word === "--cpu-list")) skip = 0;
				rest = rest.slice(values?.has(word) ? 2 : 1);
				continue;
			}
			if (skip > 0) {
				skip--;
				rest = rest.slice(1);
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
	const touched = envInfo.chdir !== undefined || envInfo.unset.length > 0 || envInfo.clear;
	return { argv: rest, privileged, ...(xargs ? { xargs } : {}), ...(opaque.length > 0 ? { opaque } : {}), ...(touched ? { env: envInfo } : {}), ...(envInfo.chdir !== undefined ? { chdir: envInfo.chdir } : {}) };
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

const unknownMatch = (reason: string, scan = false): CommandMatch => carrier([unknownTag(reason, scan)]);

const SQL_REASON = /^(SQL |MongoDB |Redis )/;

/** The match the normal rules made for this very command (not a wrapper's `sudo`, not a SQL pattern). */
function ownMatch(found: CommandMatch[]): CommandMatch | undefined {
	return found.find((match) => match.kind !== COMMAND_KIND.PRIVILEGED && !SQL_REASON.test(match.reason));
}

/** A script that cannot be scanned may have switched branch: what follows it in the same command is treated as moved. */
function withMove(tags: DspTag[]): DspTag[] {
	return tags.some((tag) => tag.type === "unknown" && tag.scan === true) && !tags.some((tag) => tag.type === "branch-move") ? [...tags, { type: "branch-move" }] : tags;
}

function attach(found: CommandMatch[], tags: DspTag[]): CommandMatch[] {
	if (tags.length === 0) return found;
	tags = withMove(tags);
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
	`add am annotate apply archive bisect blame branch bugreport bundle cat-file check-attr check-ignore check-mailmap check-ref-format checkout checkout-index cherry cherry-pick citool clean clone column commit commit-graph commit-tree config count-objects credential daemon describe diagnose diff diff-files diff-index diff-tree difftool fast-export fast-import fetch fetch-pack filter-branch filter-repo fmt-merge-msg for-each-ref for-each-repo format-patch fsck gc get-tar-commit-id grep gui hash-object help hook index-pack init instaweb interpret-trailers lfs log ls-files ls-remote ls-tree mailinfo mailsplit maintenance merge merge-base merge-file merge-index merge-tree mergetool mktag mktree multi-pack-index mv name-rev notes pack-objects pack-refs p4 patch-id prune prune-packed pull push range-diff read-tree rebase receive-pack reflog remote repack replace request-pull rerere reset restore rev-list rev-parse revert rm scalar send-email send-pack shell shortlog show show-branch show-index show-ref sparse-checkout stage stash status stripspace submodule subtree svn switch symbolic-ref tag unpack-file unpack-objects update-index update-ref update-server-info upload-archive upload-pack var verify-commit verify-pack verify-tag version whatchanged worktree write-tree`.split(/\s+/),
);

// Keys that reroute where git talks to, run hooks from elsewhere, or hand out credentials.
// (`core.sshCommand` and `protocol.*.allow` are here too: they replace the credential lock's ssh or open the `ext::` transport.)
const RESHAPING_CONFIG_KEY = /^(remote\..+|url\..+|alias\..+|credential\..+|core\.(hookspath|sshcommand)|push\..+|include\..+|includeif\..+|init\.templatedir|protocol\..+\.allow)$/i;
// Settings whose value is a command string git runs (a pager, an editor, a filter, a diff driver, an ssh program).
const COMMAND_CONFIG_KEY = /^(core\.(sshcommand|fsmonitor|pager|editor|askpass|gitproxy)|sequence\.editor|diff\.external|.+\.textconv|diff\..+\.command|merge\..+\.(driver|recursivedriver)|filter\..+|gpg\.(.+\.)?program|pager\..+|uploadpack\.packobjectshook|(mergetool|difftool|browser|man)\..+\.(cmd|path)|web\.browser)$/i;
const REBASE_VALUE_OPTIONS = new Set(["--onto", "-x", "--exec", "-s", "--strategy", "-X", "--strategy-option"]);
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

/** The command a command-valued setting (`core.pager=less`, `core.fsmonitor=cmd`) runs, or undefined when the value is a boolean or empty. */
function configCommand(key: string, value: string): string | undefined {
	if (!COMMAND_CONFIG_KEY.test(key) || /^(true|false|yes|no|on|off|0|1|)$/i.test(value.trim())) return undefined;
	return value.startsWith("!") ? value.slice(1) : value;
}

/** `ext::<command> <args>` runs the command (`% ` is a space, `%%` a percent sign, `%s` and the like the service name). */
function extCommand(url: string): string {
	const words: string[] = [];
	let word = "";
	const body = url.slice("ext::".length);
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "%" && i + 1 < body.length) {
			const next = body[++i];
			word += next === " " ? " " : next === "%" ? "%" : "service";
		} else if (ch === " ") {
			if (word !== "") words.push(word);
			word = "";
		} else word += ch;
	}
	if (word !== "") words.push(word);
	return words.map(quote).join(" ");
}

/** The values of `--name=v`, `--name v`, `-x v` and `-xv` options. */
function optionValues(args: string[], long: readonly string[], short: readonly string[] = []): string[] {
	const found: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		const joined = long.find((name) => arg.startsWith(`${name}=`));
		if (joined) found.push(arg.slice(joined.length + 1));
		else if (long.includes(arg) || short.includes(arg)) {
			if (args[i + 1] !== undefined) found.push(args[++i]);
		} else if (arg.length > 2 && !arg.startsWith("--") && short.includes(arg.slice(0, 2))) found.push(arg.slice(2));
	}
	return found;
}

/** `-c key=value` after `git clone`, which also applies to the clone's own fetch. */
function cloneOverrides(rest: string[]): Array<[string, string]> {
	return optionValues(rest, ["--config"], ["-c"]).map((entry): [string, string] => {
		const [key, ...value] = entry.split("=");
		return [key, value.join("=")];
	});
}

/**
 * Command strings a git invocation hands to a shell or program: command-valued `-c` settings, `ext::` URLs,
 * `--upload-pack`/`--receive-pack`/`--exec`, `rebase -x`, `difftool -x`, `submodule foreach`, `bisect run`,
 * `filter-branch` filters. Each is classified like a shell command by the caller.
 */
function gitCommandStrings(args: string[]): string[] {
	const index = gitSubcommand(args);
	const prefix = index === -1 ? args : args.slice(0, index);
	const texts: string[] = [];
	const add = (key: string, value: string) => {
		const text = configCommand(key, value);
		if (text !== undefined) texts.push(text);
	};
	for (const [key, value] of gitOverrides(prefix)) add(key, value);
	if (index === -1) return texts;
	const sub = args[index];
	const rest = args.slice(index + 1);
	texts.push(...rest.filter((word) => word.startsWith("ext::")).map(extCommand));
	texts.push(...optionValues(rest, ["--upload-pack", "--receive-pack", "--exec", "--upload-archive", "--extcmd"]));
	switch (sub) {
		case "clone":
			texts.push(...optionValues(rest, [], ["-u"]));
			for (const [key, value] of cloneOverrides(rest)) add(key, value);
			break;
		case "rebase":
			texts.push(...optionValues(rest, [], ["-x"]));
			break;
		case "difftool":
			texts.push(...optionValues(rest, [], ["-x"]));
			break;
		case "grep":
			texts.push(...rest.filter((word) => /^-O./.test(word)).map((word) => word.slice(2)));
			texts.push(...rest.filter((word) => word.startsWith("--open-files-in-pager=")).map((word) => word.slice(word.indexOf("=") + 1)));
			break;
		case "filter-branch":
			texts.push(...optionValues(rest, ["--env-filter", "--tree-filter", "--index-filter", "--parent-filter", "--msg-filter", "--commit-filter", "--tag-name-filter"]));
			break;
		case "submodule": {
			const at = rest.indexOf("foreach");
			const words = at === -1 ? [] : rest.slice(at + 1);
			while (words[0]?.startsWith("-")) words.shift();
			if (words.length > 0) texts.push(words.join(" "));
			break;
		}
		case "bisect":
			// git runs the words as a program and its arguments (`bisect run sh -c 'git push'`), so keep each word whole.
			if (rest[0] === "run" && rest.length > 1) texts.push(rest.slice(1).map(quote).join(" "));
			break;
		default:
			break;
	}
	return texts;
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
	// `--exec-path=<dir>` runs the git subcommands found in another directory.
	if (prefix.some((arg) => arg.startsWith("--exec-path="))) tags.push(unknownTag("git --exec-path runs git subcommands from another directory", true));
	if (index === -1) return tags;

	const sub = args[index];
	const rest = args.slice(index + 1);
	const discard = (slug: string, extra: Partial<Extract<DspTag, { type: "discard" }>> = {}) => {
		if (own?.kind === COMMAND_KIND.DESTRUCTIVE) tags.push({ type: "discard", slug, ...extra });
	};
	const history = (label: string) => tags.push({ type: "history", label });

	// `git remote-https`, `git http-push`: transports that push or fetch on their own.
	if (/^remote-/.test(sub) || sub === "http-push" || sub === "imap-send") {
		tags.push(remote(`git ${sub}`));
		return tags;
	}
	// `git credential fill|approve|reject` and `git credential-osxkeychain get` hand out the stored credentials.
	if (/^credential(-.+)?$/.test(sub)) {
		tags.push(remote("credential access (git credential)"));
		return tags;
	}
	if (UNCERTAIN_CONTENT.test(sub)) {
		tags.push(unknownTag("the git subcommand comes from a variable or substitution: it cannot be checked for remote actions", true));
		return tags;
	}
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
		case "send-pack":
			tags.push(remote("push (send-pack)", { remote: positionals(rest)[0] }));
			break;
		case "p4":
			if (rest[0] === "submit") tags.push(remote("p4 submit"));
			break;
		case "remote": {
			const words = positionals(rest);
			if (["add", "set-url", "remove", "rm", "rename", "set-head", "set-branches"].includes(words[0])) tags.push(remote("remote config change", { remote: words[1] }));
			break;
		}
		case "config": {
			if (CONFIG_READ_ONLY.some((flag) => rest.includes(flag))) break;
			const words = rest.filter((arg) => !arg.startsWith("-"));
			if (hasFlag(rest, "-e", "--edit") || words.some((word) => RESHAPING_CONFIG_KEY.test(word) || COMMAND_CONFIG_KEY.test(word))) tags.push(remote("git config change"));
			break;
		}
		case "difftool":
		case "mergetool":
			if (!hasFlag(rest, "--tool-help")) tags.push(unknownTag(`git ${sub} runs the tool command configured for it`, true));
			break;
		case "clone":
			for (const [key] of cloneOverrides(rest)) if (RESHAPING_CONFIG_KEY.test(key)) tags.push(remote("git config change"));
			if (hasFlag(rest, "--template")) tags.push(unknownTag("git clone --template copies hooks from a template directory", true));
			break;
		case "init":
			if (hasFlag(rest, "--template")) tags.push(unknownTag("git init --template copies hooks from a template directory", true));
			break;
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
		case "rebase": {
			history("rebase");
			discard("rebase");
			// `git rebase <upstream> <branch>` switches to <branch> first, so naming the default branch rewrites it.
			const words = positionals(rest, REBASE_VALUE_OPTIONS);
			const branch = hasFlag(rest, "--root") ? words[0] : words[1];
			if (branch !== undefined && UNCERTAIN_CONTENT.test(branch)) tags.push(unknownTag("the branch git rebase switches to comes from a variable or substitution", true));
			else if (branch !== undefined) tags.push({ type: "default-ref", label: "rebase", names: [branch.replace(/^refs\/heads\//, "")] });
			break;
		}
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
	// (`gh auth status --show-token` prints the token.)
	if (group === "auth") return action === undefined || (action === "status" && !hasFlag(args, "-t", "--show-token")) ? [] : [remote("auth change")];
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
	let config = false;
	const urls: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		// A config file can carry any option, the method and the data included.
		if (arg === "-K" || arg === "--config" || /^-[A-Za-z]*K$/.test(arg)) {
			config = true;
			i++;
			continue;
		}
		// `-Kcfg` (attached) and `-sKcfg` (after flags that take no value).
		const clustered = /^-([A-Za-z]*?)K.+$/.exec(arg);
		if (arg.startsWith("--config=") || (clustered && !/[AbcCdDeEFHmoPQrtTuUwxXyYz]/.test(clustered[1]))) {
			config = true;
			continue;
		}
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
	if (config) return [remote("HTTP request (curl config file)", { ref: urls[0] })];
	// A method the shell computes (`-X $METHOD`) may be a write.
	const writes = method !== undefined ? WRITE_METHODS.has(method) || /[$`]/.test(method) : data && !get;
	return writes ? httpWriteTag(urls) : [];
}

// wgetrc and curlrc settings that make a request a write (wgetrc names ignore case, `-` and `_`).
const WGET_WRITE_KEY = /post[-_]*(data|file)|body[-_]*(data|file)|\bmethod\b/i;
const CURL_WRITE_KEY = /^\s*(-X|-d|-F|-T|--(request|data[\w-]*|form[\w-]*|json|upload-file)|request|data[\w-]*|form[\w-]*|json|upload-file)\b/im;

/** A config file (`wget --config`, `WGETRC`, `.curlrc`) that sets a write, or cannot be read: it asks. A missing file is left to fail. */
function rcWrites(raw: string, rt: Runtime, key: RegExp): boolean {
	const path = resolveFrom(raw, rt);
	if (path === undefined) return true;
	const read = reader(rt)(path);
	if ("missing" in read || "notFile" in read) return false;
	return !("text" in read) || key.test(read.text);
}

function wgetTags(args: string[], rt: Runtime): DspTag[] {
	const method = optionValue(args, "--method")?.toUpperCase();
	let writes = hasFlag(args, "--post-data", "--post-file", "--body-data", "--body-file") || (method !== undefined && WRITE_METHODS.has(method));
	// `-e 'post_data=x'` and `--execute=...` run wgetrc commands; `--config=file` reads a whole wgetrc.
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		let command: string | undefined;
		if (arg === "-e" || arg === "--execute" || /^-[A-Za-z]+e$/.test(arg)) command = args[++i] ?? "";
		else if (arg.startsWith("--execute=")) command = arg.slice("--execute=".length);
		else if (/^-e./.test(arg)) command = arg.slice(2);
		if (command !== undefined && (WGET_WRITE_KEY.test(command) || UNCERTAIN_CONTENT.test(command))) writes = true;
		const config = arg === "--config" ? (args[++i] ?? "") : arg.startsWith("--config=") ? arg.slice("--config=".length) : undefined;
		if (config !== undefined && rcWrites(config, rt, WGET_WRITE_KEY)) writes = true;
	}
	return writes ? httpWriteTag(positionals(args, new Set(["-O", "-o", "-P", "--header", "--user", "--password", "-e", "-t", "-T", "--config", "--execute"]))) : [];
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

// ── raw remote access, xargs and parallel ──

const REMOTE_SHELL = "remote shell/copy";
const SSH_VALUES = new Set(["-b", "-c", "-D", "-E", "-e", "-F", "-I", "-i", "-J", "-L", "-l", "-m", "-O", "-o", "-p", "-Q", "-R", "-S", "-W", "-w"]);
const SCP_VALUES = new Set(["-c", "-F", "-i", "-J", "-l", "-o", "-P", "-S", "-D"]);
const SFTP_VALUES = new Set(["-B", "-b", "-c", "-D", "-F", "-i", "-J", "-l", "-o", "-P", "-R", "-S", "-s"]);
const RSYNC_VALUES = new Set(["-e", "--rsh", "--exclude", "--include", "--exclude-from", "--include-from", "--filter", "-f", "--files-from", "--log-file", "--backup-dir", "--suffix", "--partial-dir", "--temp-dir", "-T", "--bwlimit", "--port", "--chmod", "--chown", "--usermap", "--groupmap", "--compare-dest", "--copy-dest", "--link-dest", "-B", "--block-size", "--timeout", "--contimeout", "--max-size", "--min-size", "--out-format", "--info", "--debug", "-M", "--remote-option", "--rsync-path"]);
/** Programs that talk to a host on their own: always remote work. */
const NETWORK_PROGRAMS = new Set(["nc", "ncat", "netcat", "socat", "telnet", "ftp", "lftp", "tftp", "tnftp", "pftp"]);

/** `host:path`, `user@host:path`, `[::1]:path` or a `scp://`, `rsync://`, `ssh://` URL: an operand on another machine. */
function isRemoteOperand(word: string): boolean {
	return /^(rsync|scp|ssh|sftp):\/\//.test(word) || /^(?:[^/:@\s]*@)?(?:\[[^\]]+\]|[^/:@\s]+):/.test(word);
}

function rawRemoteTags(name: string, args: string[]): DspTag[] {
	const tag = (what: string) => [remote(REMOTE_SHELL, { ref: what })];
	switch (name) {
		case "ssh":
		case "mosh":
		case "autossh": {
			const host = positionals(args, SSH_VALUES)[0];
			return host === undefined ? [] : tag(`ssh ${host}`);
		}
		case "scp": {
			const operand = positionals(args, SCP_VALUES).find(isRemoteOperand);
			return operand === undefined ? [] : tag(`scp ${operand}`);
		}
		case "rsync": {
			const operand = positionals(args, RSYNC_VALUES).find(isRemoteOperand);
			return operand === undefined ? [] : tag(`rsync ${operand}`);
		}
		case "sftp": {
			const host = positionals(args, SFTP_VALUES)[0];
			return host === undefined ? [] : tag(`sftp ${host}`);
		}
		case "openssl":
			return args[0] === "s_client" ? tag("openssl s_client") : [];
		default:
			return NETWORK_PROGRAMS.has(name) ? tag(name) : [];
	}
}

/** Commands whose subcommand decides what they do: a word from standard input or a variable in that place cannot be judged. */
const SUBCOMMAND_TOOLS = new Set(["git", "hub", "gh", "npm", "pnpm", "yarn", "bun", "cargo", "twine", "gem", "poetry", "uv", "flit", "hatch", "helm", "docker", "podman", "buildah"]);
const HTTP_TOOLS = new Set(["curl", "wget", "http", "https", "xh", "xhs"]);

function stripInputRedirects(words: string[]): string[] {
	const kept: string[] = [];
	for (let i = 0; i < words.length; i++) {
		if (words[i] === "<" || words[i] === "<<" || words[i] === "<<<") i++;
		else if (!/^<[^(]/.test(words[i])) kept.push(words[i]);
	}
	return kept;
}

/**
 * `xargs` and `parallel` append words from standard input (or `:::`) to the command, or substitute them where the
 * replacement string is. When those words can decide whether the command is remote, it cannot be judged.
 */
function xargsReason(info: XargsInfo, argv: string[]): string | undefined {
	const name = basename(argv[0]);
	// `xargs git < args.txt`: the redirection feeds xargs, it is not a git subcommand.
	const args = stripInputRedirects(argv.slice(1));
	const holds = (word: string) => info.replace.some((text) => text !== "" && word.includes(text)) || (info.placeholder?.test(word) ?? false);
	const input = "words that xargs or parallel take from their input";
	if (holds(argv[0])) return `the command name is one of the ${input}`;
	if (name === "git" || name === "hub") {
		const index = gitSubcommand(args);
		if (index === -1) return `the git subcommand would come from the ${input}`;
		if (holds(args[index]) || args.slice(0, index).some((word, i) => args[i - 1] === "-c" && holds(word))) return `the git subcommand is one of the ${input}`;
		return undefined;
	}
	if (HTTP_TOOLS.has(name) || (name === "gh" && positionals(args, new Set(["-R", "--repo", "--hostname"]))[0] === "api")) return `${name} takes its method and options from the ${input}`;
	if (name === "gh") {
		const words = positionals(args, new Set(["-R", "--repo", "--hostname"]));
		return words.length < 2 || words.slice(0, 2).some(holds) ? `the gh subcommand would come from the ${input}` : undefined;
	}
	if (SUBCOMMAND_TOOLS.has(name)) {
		const words = positionals(args, VALUE_OPTIONS[name] ?? new Set());
		return words.length === 0 || words.slice(0, 2).some(holds) ? `the ${name} subcommand would come from the ${input}` : undefined;
	}
	if (SHELLS.has(name) || name === "eval") {
		const at = name === "eval" ? 0 : args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
		const script = name === "eval" ? args.join(" ") : at >= 0 ? args[at + 1] : undefined;
		return script === undefined || holds(script) || args.some(holds) ? `${name} would run a program built from the ${input}` : undefined;
	}
	if (FILE_INTERPRETERS.has(interpreterOf(name)) || name === "make" || name === "gmake") {
		const inline = inlineProgram(interpreterOf(name), args) !== undefined;
		if (args.some(holds)) return `${name} would run a file or target named by the ${input}`;
		return inline || args.some((arg) => !arg.startsWith("-")) ? undefined : `${name} would run a file named by the ${input}`;
	}
	return argv.slice(0, 1).some((word) => word.includes("/")) && args.some(holds) ? `${name} receives the ${input}` : undefined;
}

// ── inline interpreter code ──

// Options that take a value before the program, so that the value is not taken for the script.
const INTERPRETER_VALUES = new Set(["-W", "-X", "-r", "-I", "-C", "-d", "-M", "--require", "--import", "--loader", "--experimental-loader", "--input-type", "--conditions", "-x"]);
const INLINE_FLAG: Record<string, RegExp> = {
	node: /^-[a-zA-Z]*[ep]$/,
	nodejs: /^-[a-zA-Z]*[ep]$/,
	bun: /^-[a-zA-Z]*[ep]$/,
	ruby: /^-[a-zA-Z]*e$/,
	perl: /^-[a-zA-Z]*[eE]$/,
	php: /^-[a-zA-Z]*r$/,
	lua: /^-[a-zA-Z]*e$/,
	python: /^-[a-zA-Z]*c$/,
	expect: /^-c$/,
};

/** The program text a `python -c`, `node -e`, `perl -e`, `php -r`, `deno eval`, `bun -e` command runs, when it is inline. */
function inlineProgram(interpreter: string, args: string[]): string | undefined {
	if (interpreter === "deno") {
		const words = args.filter((arg) => !arg.startsWith("-"));
		return words[0] === "eval" ? words[1] : undefined;
	}
	const flag = INLINE_FLAG[interpreter];
	if (!flag) return undefined;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (flag.test(arg) || ((interpreter === "node" || interpreter === "nodejs" || interpreter === "bun") && (arg === "--eval" || arg === "--print"))) return args[i + 1];
		if (/^--(eval|print)=/.test(arg) && (interpreter === "node" || interpreter === "nodejs" || interpreter === "bun")) return arg.slice(arg.indexOf("=") + 1);
		if (arg === "-m") return undefined; // a module: its own options follow
		if (INTERPRETER_VALUES.has(arg)) i++;
		else if (!arg.startsWith("-")) return undefined;
	}
	return undefined;
}

// Process spawning in inline code: the command it starts can be assembled at run time (`'g' + 'it push'`).
const SPAWN_CODE = new RegExp(
	[
		String.raw`\bos\.(?:system|popen|exec\w*|spawn\w*|posix_spawn\w*|fork\w*|execute)\b`,
		String.raw`\b(?:subprocess|Popen|child_process|Open3|ctypes|importlib|__import__|mainModule|pty\.spawn)\b`,
		String.raw`\bDeno\.(?:Command|run)\b`,
		String.raw`\bBun\.(?:spawn\w*|\$)`,
		String.raw`\$\``,
		String.raw`\bprocess\.binding\b`,
		String.raw`\b(?:system|exec|spawn|spawnSync|execSync|execFile|execFileSync|fork|popen|shell_exec|passthru|proc_open|pcntl_exec|execute|getoutput|getstatusoutput|eval|Function|getattr)\s*[("'\`$@]`,
		String.raw`\brequire\s*\(\s*(?!["'][\w:@./-]+["']\s*\))`,
		String.raw`\bimport\s*\(`,
	].join("|"),
);

function spawnsProcesses(interpreter: string, code: string): boolean {
	if (SPAWN_CODE.test(code)) return true;
	// tcl runs a program with `exec` (or `open "|cmd"`), expect with `spawn`.
	if (interpreter === "tclsh" || interpreter === "wish" || interpreter === "expect") return /\b(?:exec|eval|spawn|uplevel|subst)\b|\bopen\s+["{]?\|/.test(code);
	// Backticks and `qx`, `%x`, `open("cmd |")` run a shell in perl, ruby and php.
	return ["perl", "ruby", "php"].includes(interpreter) && /`|%x[({[<|!]|\bqx\b|\bopen\s*\(?[^;]*\||\b(?:system|exec|spawn)\s+[\w$@"'(]/.test(code);
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

const FILE_INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "tsx", "ts-node", "babel-node", "ruby", "perl", "php", "lua", "Rscript", "python", "tclsh", "wish", "expect"]);
/** Paths that name the program a shell or interpreter reads from standard input. */
const STDIN_PATH = /^(\/dev\/stdin|\/dev\/fd\/0|\/proc\/self\/fd\/0)$/;
const SHELL_VALUE_OPTIONS = new Set(["-o", "+o", "-O", "+O", "--rcfile", "--init-file"]);
const UNCERTAIN_CONTENT = /\$[A-Za-z_{(@*#!0-9]|`/;
// Words that start a command somewhere in a line of code (a script is not always shell).
const COMMAND_WORDS = /\b(git|gh|hub|npm|pnpm|yarn|bun|cargo|twine|gem|poetry|uv|flit|helm|docker|podman|buildah|curl|wget|http|https|xh|xhs|bash|sh|zsh|make|gmake|node|python3?|ruby|perl|source|ssh|scp|sftp|rsync|nc|ncat|netcat|socat|telnet|xargs|parallel|osascript|script|su)\b|\.\/[\w./-]+/g;
// A branch change (`git switch main`, `git checkout main`) earlier in a script: a merge after it lands somewhere else.
const BRANCH_MOVE = /\bgit\b[^\n;&|]*\b(checkout|switch)\b/;

/** Bodies of the heredocs in a command (what a shell or interpreter reads from standard input). */
function heredocBodies(command: string): string[] {
	return [...command.matchAll(/<<-?\s*(['"]?)([A-Za-z_]\w*)\1[^\n]*\n([\s\S]*?)\n\2(?=\n|$)/g)].map((match) => match[3]);
}

/** A shell or interpreter with no script argument reads its program from standard input: a heredoc, a file, or a process substitution. */
function stdinProgramTags(args: string[], rt: Runtime, interpreter?: string): DspTag[] {
	const tags: DspTag[] = [];
	const redirect = args.findIndex((arg) => arg === "<" || (arg.startsWith("<") && !arg.startsWith("<<") && !arg.startsWith("<(")));
	if (redirect >= 0) {
		const file = args[redirect] === "<" ? args[redirect + 1] : args[redirect].slice(1);
		if (file) tags.push(...scriptFileTags(file, rt));
	}
	for (const body of heredocBodies(rt.ctx.commandText)) {
		tags.push(...describeHits("program from standard input", scanText(body, rt)));
		if (interpreter && spawnsProcesses(interpreter, body)) tags.push(unknownTag(`${interpreter} reads code that starts processes, so the command it runs cannot be checked for remote actions`, true));
	}
	// Here-strings (`bash <<< 'git push'`) are programs too.
	for (let i = 0; i < args.length; i++) {
		const text = args[i] === "<<<" ? args[i + 1] : args[i].startsWith("<<<") ? args[i].slice(3) : undefined;
		if (text === undefined) continue;
		tags.push(...describeHits("program from a here-string", scanText(text, rt)));
		if (UNCERTAIN_CONTENT.test(text)) tags.push(unknownTag("it runs a here-string built from a variable or substitution, which cannot be checked for remote actions", true));
		if (interpreter && spawnsProcesses(interpreter, text)) tags.push(unknownTag(`${interpreter} reads code that starts processes, so the command it runs cannot be checked for remote actions`, true));
	}
	if (/<\(/.test(rt.ctx.commandText)) tags.push(unknownTag("it runs text from a process substitution, which cannot be checked for remote actions"));
	return tags;
}

const interpreterOf = (name: string) => (/^python[\d.]*$/.test(name) ? "python" : /^(tclsh|wish)[\d.]*$/.test(name) ? name.replace(/[\d.]+$/, "") : name);

function nestedMatches(text: string, rt: Runtime, depth = rt.ctx.depth): CommandMatch[] {
	return classifyCommand(text, makeOptions(rt.env, { ...rt.scope }, { depth, commandText: text, visited: rt.ctx.visited }));
}

/** What a body of code (a script, a recipe, an inline program) runs that reaches a remote, and why it could not be scanned. */
function scanText(text: string, rt: Runtime): { hits: string[]; unknown: string[]; moves?: boolean } {
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
	let branchMoved = false;
	for (const raw of text.split("\n").slice(0, MAX_SCAN_LINES)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#") || line.startsWith("//")) continue;
		const lineMatches = nestedMatches(line, rt, depth);
		collect(lineMatches);
		// A merge, rebase or cherry-pick after a branch change (on this line or an earlier one) lands on a branch the guard cannot name.
		for (const match of lineMatches) {
			if ((branchMoved || match.elsewhere) && !match.commit && match.dsp?.some((tag) => tag.type === "history")) hits.add("a merge or rebase after a branch switch");
		}
		if (BRANCH_MOVE.test(line) || lineMatches.some((match) => match.dsp?.some((tag) => tag.type === "branch-move"))) branchMoved = true;
		// Code such as `execSync("git push")` or `["git", "push"]`: look at what follows each command word.
		const spaced = line.replace(/["'`,[\](){}]/g, " ");
		for (const match of spaced.matchAll(COMMAND_WORDS)) collect(nestedMatches(spaced.slice(match.index), rt, depth));
	}
	return { hits: [...hits], unknown: [...unknown], moves: branchMoved };
}

function describeHits(label: string, scanned: { hits: string[]; unknown: string[]; moves?: boolean }): DspTag[] {
	const tags: DspTag[] = [];
	if (scanned.hits.length > 0) tags.push(remote(`${label} runs ${scanned.hits.join(", ")}`));
	for (const reason of scanned.unknown) tags.push(unknownTag(reason, true));
	if (scanned.moves) tags.push({ type: "branch-move" });
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

// ── editors, stream editors, `at`, `just` and HTTP clients that run or send what their arguments say ──────────

/** Command texts a program runs through a shell, and why some of what it runs cannot be read. */
interface CommandTexts {
	commands: string[];
	opaque: string[];
}

const noTexts = (): CommandTexts => ({ commands: [], opaque: [] });
const mergeTexts = (into: CommandTexts, from: CommandTexts) => {
	into.commands.push(...from.commands);
	into.opaque.push(...from.opaque);
};

/** The string literal that starts at `at` (single quotes too with `single`) and the index after it. */
function readLiteral(text: string, at: number, single: boolean): { value: string; end: number } | undefined {
	const open = text[at];
	if (open !== '"' && !(single && open === "'")) return undefined;
	let value = "";
	for (let i = at + 1; i < text.length; i++) {
		const ch = text[i];
		if (ch === "\\" && open === '"') {
			const next = text[++i] ?? "";
			value += next === "n" || next === "r" || next === "t" ? " " : next;
			continue;
		}
		if (ch === open) {
			if (open === "'" && text[i + 1] === "'") {
				value += "'";
				i++;
				continue;
			}
			return { value, end: i + 1 };
		}
		value += ch;
	}
	return undefined;
}

/** The command in the first argument of `system('git push')` or `job_start(['git', 'push'])`; undefined when it is not a plain literal. */
function callCommand(text: string, from: number): string | undefined {
	let at = from;
	while (text[at] === " ") at++;
	const first = readLiteral(text, at, true);
	if (first) return /^\s*[,)\]}]/.test(text.slice(first.end)) ? first.value : undefined;
	if (text[at] !== "[") return undefined;
	const words: string[] = [];
	for (at++; ; ) {
		while (text[at] === " " || text[at] === ",") at++;
		if (text[at] === "]") return words.length > 0 ? words.map(quote).join(" ") : undefined;
		const word = readLiteral(text, at, true);
		if (!word) return undefined;
		words.push(word.value);
		at = word.end;
	}
}

const EX_EXECUTE = /\bexe(?:c(?:u(?:t(?:e)?)?)?)?(?![\w-])/;
const EX_PLAIN_EXECUTE = /^[:\s]*(?:silent!?\s+)?exe(?:c(?:u(?:t(?:e)?)?)?)?\s+(["'])((?:(?!\1).)*)\1\s*$/;
const EX_CALLS = /\b(?:system|systemlist|job_start|term_start|jobstart|termopen|nvim_command|libcall)\s*\(\s*/g;
const EX_EMBEDDED = /^[\s:]*(?:silent!?\s+)?(?:py3?|python3?|pyx|pythonx|py3do|pydo|lua|luado|perl|perldo|ruby|rubydo|rb|tcl|tcldo|mz|mzscheme)(?![\w])/;
const cleanEx = (text: string) => text.replace(/^[\s!]+/, "").replace(/(?:\\?<cr>|\\[rn]|["'\s])+$/gi, "");

/** Shell commands in ex/vim command text: `!cmd`, `r !cmd`, `%!cmd`, `system('cmd')`, `:terminal cmd`; code that builds its command at run time asks. */
function exShellCommands(text: string): CommandTexts {
	const out = noTexts();
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "") continue;
		let body = line;
		if (EX_EXECUTE.test(line)) {
			const plain = EX_PLAIN_EXECUTE.exec(line);
			if (!plain) {
				out.opaque.push("the editor runs a command built by execute");
				continue;
			}
			body = plain[2];
		}
		const bang = body.indexOf("!");
		if (bang >= 0) {
			const command = cleanEx(body.slice(bang + 1));
			if (command !== "") out.commands.push(command);
		}
		for (const call of body.matchAll(EX_CALLS)) {
			const command = callCommand(body, (call.index ?? 0) + call[0].length);
			if (command === undefined) out.opaque.push(`${call[0].replace(/\s*\(\s*$/, "")}() is given a command the guard cannot read`);
			else out.commands.push(command);
		}
		const terminal = /(?:^|[\s:|])term(?:inal)?!?\s+(?:\+\+\S+\s+)*(\S.*)$/.exec(body);
		if (terminal) out.commands.push(cleanEx(terminal[1]));
		if (EX_EMBEDDED.test(body)) out.opaque.push("the editor runs code in an embedded interpreter");
	}
	return out;
}

const EDITOR_NAMES = new Set(["vim", "vi", "nvim", "ex", "view", "vimdiff", "nvimdiff", "gvim", "mvim", "rvim", "rview", "evim", "ed"]);
const EDITOR_SKIP_VALUES = new Set(["-i", "-t", "-T", "-U", "-w", "-W", "--startuptime", "--servername", "--listen"]);
const EX_MODE_FLAG = /^-[A-Za-z]*[eE][A-Za-z]*$/;

/** What vim, nvim, ex and ed run through a shell: `-c`, `+cmd`, `--cmd`, `-S file`, `-u file`, and (in ex mode) commands from standard input. */
function editorTexts(name: string, args: string[], rt: Runtime, before: string): CommandTexts {
	const out = noTexts();
	const readInto = (file: string) => {
		const path = resolveFrom(file, rt);
		if (path === undefined) {
			out.opaque.push(`cannot tell which editor script ${file} is`);
			return;
		}
		const read = reader(rt)(path);
		if ("text" in read) mergeTexts(out, exShellCommands(read.text));
		else if (!("missing" in read) && !("notFile" in read)) out.opaque.push(`cannot read the editor script ${file}`);
	};
	if (name !== "ed") {
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "--") break;
			if (arg === "-c" || arg === "--cmd") {
				if (args[i + 1] !== undefined) mergeTexts(out, exShellCommands(args[++i]));
			} else if (arg.startsWith("--cmd=")) mergeTexts(out, exShellCommands(arg.slice("--cmd=".length)));
			else if (/^\+./.test(arg)) mergeTexts(out, exShellCommands(arg.slice(1)));
			else if (arg === "-S" || arg === "-u") {
				const file = args[++i];
				if (file !== undefined && !/^(NONE|NORC|DEFAULTS)$/.test(file)) readInto(file);
			} else if (EDITOR_SKIP_VALUES.has(arg)) i++;
		}
	}
	if (name === "ed" || name === "ex" || args.some((arg) => EX_MODE_FLAG.test(arg))) {
		let fromInput = false;
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === "<<<" || arg.startsWith("<<<")) {
				fromInput = true;
				mergeTexts(out, exShellCommands(arg === "<<<" ? (args[++i] ?? "") : arg.slice(3)));
			} else if (arg === "<" || /^<[^<(]/.test(arg)) {
				fromInput = true;
				const file = arg === "<" ? args[++i] : arg.slice(1);
				if (file !== undefined) readInto(file);
			}
		}
		for (const body of heredocBodies(rt.ctx.commandText)) {
			fromInput = true;
			mergeTexts(out, exShellCommands(body));
		}
		if (!fromInput && before === "|") out.opaque.push("the editor reads its commands from another command's output");
	}
	return out;
}

const ELISP_SHELL = /\(\s*(?:shell-command-to-string|async-shell-command|shell-command-on-region|shell-command|call-process-shell-command|start-process-shell-command|process-file-shell-command|compile|eshell-command|ansi-term|term|vterm)(?![\w-])/g;
const ELISP_PROGRAM = /\(\s*(call-process-region|call-process|process-file|process-lines|start-file-process|start-process|make-process|async-start-process|make-comint|magit-run-git-async|magit-run-git|magit-call-git)(?![\w-])/g;
const ELISP_EVAL = /\(\s*(?:load|load-file|eval|funcall|apply|url-retrieve|url-retrieve-synchronously)(?![\w-])/;

/** The s-expression that starts at `start` (a `(`). */
function sexpFrom(text: string, start: number): string {
	let depth = 0;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (ch === '"') {
			const literal = readLiteral(text, i, false);
			if (!literal) break;
			i = literal.end - 1;
		} else if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return text.slice(start, i + 1);
	}
	return text.slice(start);
}

/** Commands in Emacs Lisp text: the string literals given to `shell-command`, `call-process`, `start-process`, ...; other evaluation asks. */
function elispCommands(text: string): CommandTexts {
	const out = noTexts();
	const strings = (sexp: string) => [...sexp.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)].map((found) => found[1].replace(/\\([\s\S])/g, "$1"));
	for (const found of text.matchAll(ELISP_SHELL)) {
		const literals = strings(sexpFrom(text, found.index ?? 0));
		if (literals.length === 0) out.opaque.push(`emacs runs ${found[0].slice(1).trim()} with a command the guard cannot read`);
		else out.commands.push(...literals);
	}
	for (const found of text.matchAll(ELISP_PROGRAM)) {
		const words = strings(sexpFrom(text, found.index ?? 0));
		if (words.length === 0) out.opaque.push(`emacs runs ${found[1]} with a program the guard cannot read`);
		else if (found[1].startsWith("magit-")) out.commands.push(["git", ...words].map(quote).join(" "));
		else {
			// The first string may be a process name (`start-process "name" nil "git" "push"`).
			out.commands.push(words.map(quote).join(" "));
			if (words.length > 1) out.commands.push(words.slice(1).map(quote).join(" "));
		}
	}
	if (ELISP_EVAL.test(text)) out.opaque.push("emacs loads or evaluates code the guard cannot read");
	return out;
}

/** What `emacs --eval`, `-l file` and `emacsclient -e` run. */
function emacsTexts(args: string[], rt: Runtime, client: boolean): CommandTexts {
	const out = noTexts();
	const loadFile = (file: string) => {
		const path = resolveFrom(file, rt);
		const read = path === undefined ? undefined : reader(rt)(path);
		if (read && "text" in read) mergeTexts(out, elispCommands(read.text));
		else if (!read || (!("missing" in read) && !("notFile" in read))) out.opaque.push(`cannot read the Emacs Lisp file ${file}`);
	};
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		const joined = /^--?(?:eval|execute)=([\s\S]*)$/.exec(arg);
		if (joined) mergeTexts(out, elispCommands(joined[1]));
		else if (/^--?(?:eval|execute)$/.test(arg) || (client && arg === "-e")) mergeTexts(out, elispCommands(args[++i] ?? ""));
		else if (!client && (arg === "-l" || arg === "--load" || arg === "-load" || arg === "--script")) {
			const file = args[++i];
			if (file !== undefined) loadFile(file);
		}
	}
	return out;
}

const SED_S = /(?:^|[;{}\n]|[\d$\/!,])\s*s([^\w\s\\;])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1((?:\\[\s\S]|(?!\1)[^\\\n])*)\1([A-Za-z0-9]*)/g;
const SED_E = /(?:^|[;{}\n])\s*(?:(?:\d+|\$|\/(?:\\.|[^\/\\])*\/)(?:\s*,\s*(?:\d+|\$|\/(?:\\.|[^\/\\])*\/))?\s*)?!?\s*e(?![A-Za-z0-9_])([^\n]*)/g;

/** `e command` and `s///e` in a sed script run a shell command (`e` alone and the `e` flag run the pattern space). */
function sedScriptTexts(script: string): CommandTexts {
	const out = noTexts();
	for (const found of script.matchAll(SED_S)) if (found[4].includes("e")) out.opaque.push("sed s///e runs the result of the substitution as a command");
	for (const found of script.matchAll(SED_E)) {
		const command = (found[1] ?? "").trim();
		if (command === "" || /^[;}]/.test(command)) out.opaque.push("sed e runs the pattern space as a command");
		else out.commands.push(command);
	}
	return out;
}

/** The scripts sed is given (`-e`, `-f file`, or the first operand). */
function sedTexts(args: string[], rt: Runtime): CommandTexts {
	const out = noTexts();
	if (args.includes("--sandbox")) return out;
	const scripts: string[] = [];
	const files: string[] = [];
	const operands: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			operands.push(...args.slice(i + 1));
			break;
		}
		if (arg === "--expression" || /^-[A-Za-z]*e$/.test(arg)) {
			if (args[i + 1] !== undefined) scripts.push(args[++i]);
		} else if (arg.startsWith("--expression=")) scripts.push(arg.slice("--expression=".length));
		else if (arg === "--file" || /^-[A-Za-z]*f$/.test(arg)) {
			if (args[i + 1] !== undefined) files.push(args[++i]);
		} else if (arg.startsWith("--file=")) files.push(arg.slice("--file=".length));
		else if (arg === "-l" || arg === "--line-length") i++;
		else if (!arg.startsWith("-")) operands.push(arg);
	}
	// BSD `sed -i '' 's/a/b/' file`: the empty word is the backup suffix.
	if (scripts.length === 0 && files.length === 0) {
		const first = operands.find((word) => word !== "");
		if (first !== undefined) scripts.push(first);
	}
	for (const script of scripts) mergeTexts(out, sedScriptTexts(script));
	for (const file of files) {
		const path = resolveFrom(file, rt);
		const read = path === undefined ? undefined : reader(rt)(path);
		if (read && "text" in read) mergeTexts(out, sedScriptTexts(read.text));
		else if (!read || (!("missing" in read) && !("notFile" in read))) out.opaque.push(`cannot read the sed script ${file}`);
	}
	return out;
}

/** `at` and `batch` run the commands they are given in a file (`-f`) or on standard input. */
function atTags(args: string[], rt: Runtime, before: string): DspTag[] {
	const file = optionValue(args, "-f", "--file");
	if (file !== undefined) return scriptFileTags(file, rt);
	const hasInput = args.some((arg) => /^<(?!\()/.test(arg)) || heredocBodies(rt.ctx.commandText).length > 0;
	if (hasInput) return stdinProgramTags(args, rt);
	return before === "|" ? [unknownTag("it runs the commands another command prints, which cannot be checked for remote actions", true)] : [];
}

// `just`: the recipes (and backtick expressions) of a justfile run like a Makefile's.
const JUST_VALUE_OPTIONS = new Set(["-f", "--justfile", "-d", "--working-directory", "--set", "--shell", "--shell-arg", "--color", "--dotenv-filename", "--dotenv-path", "--chooser", "--command-color", "--dump-format", "--list-heading", "--list-prefix", "--tempdir", "--ceiling", "--timestamp-format"]);
const JUST_NO_RUN = new Set(["-l", "--list", "--summary", "--dump", "--fmt", "--init", "--evaluate", "--variables", "--show", "-s", "--completions", "--man", "--help", "-h", "--version", "-V", "--groups", "--edit", "-e"]);

function parseJustfile(text: string): { recipes: Map<string, { dependencies: string[]; body: string[] }>; first: string | undefined; backticks: string[] } {
	const recipes = new Map<string, { dependencies: string[]; body: string[] }>();
	const backticks: string[] = [];
	let current: { dependencies: string[]; body: string[] } | undefined;
	let first: string | undefined;
	for (const line of text.split("\n")) {
		if (/^[ \t]/.test(line)) {
			if (current && line.trim() !== "") current.body.push(line.trim().replace(/^[@-]+/, ""));
			continue;
		}
		if (line.trim() === "") continue;
		current = undefined;
		for (const found of line.matchAll(/`([^`]*)`/g)) backticks.push(found[1]);
		const header = /^@?([A-Za-z_][\w-]*)([^:\n]*?):(?!=)(.*)$/.exec(line);
		if (!header) continue;
		current = { dependencies: header[3].split("#")[0].match(/[A-Za-z_][\w-]*/g) ?? [], body: [] };
		recipes.set(header[1], current);
		first ??= header[1];
	}
	return { recipes, first, backticks };
}

function justTags(args: string[], rt: Runtime): DspTag[] {
	if (args.some((arg) => JUST_NO_RUN.has(arg))) return [];
	if (rt.scope.dir === undefined && optionValue(args, "-f", "--justfile") === undefined) return [unknownTag("cannot tell which justfile just reads (the directory is not literal)", true)];
	const state: { text?: string; used: string; dir: string | undefined } = { used: "justfile", dir: rt.scope.dir };
	const explicit = optionValue(args, "-f", "--justfile");
	const tryRead = (path: string): DspTag[] | undefined => {
		const read = reader(rt)(path);
		if ("text" in read) {
			state.text = read.text;
			state.used = path;
			state.dir = dirname(path);
			return undefined;
		}
		if ("missing" in read || "notFile" in read) return undefined;
		return [unknownTag("tooLarge" in read ? `${path} is too large to scan` : `cannot read ${path} as a justfile`, true)];
	};
	if (explicit !== undefined) {
		const path = resolveFrom(explicit, rt);
		if (path === undefined) return [unknownTag(`cannot tell which justfile ${explicit} is`, true)];
		const failed = tryRead(path);
		if (failed) return failed;
	} else {
		let search = rt.scope.dir as string;
		for (let up = 0; up < 12 && state.text === undefined; up++) {
			for (const name of ["justfile", "Justfile", ".justfile"]) {
				const failed = tryRead(join(search, name));
				if (failed) return failed;
				if (state.text !== undefined) break;
			}
			const parent = dirname(search);
			if (parent === search) break;
			search = parent;
		}
	}
	if (state.text === undefined) return [];
	const { recipes, first, backticks } = parseJustfile(state.text);
	const targets = positionals(args, JUST_VALUE_OPTIONS)
		.filter((word) => !word.includes("="))
		.map((word) => (word.includes("::") ? word.slice(word.lastIndexOf("::") + 2) : word));
	const wanted = targets.length > 0 ? targets : first ? [first] : [];
	const seen = new Set<string>();
	const lines: string[] = [...backticks];
	const visit = (name: string, depth: number) => {
		if (seen.has(name) || depth > 20) return;
		seen.add(name);
		const recipe = recipes.get(name);
		if (!recipe) return;
		recipe.dependencies.forEach((dependency) => visit(dependency, depth + 1));
		lines.push(...recipe.body);
	};
	wanted.forEach((target) => visit(target, 0));
	return lines.length === 0 ? [] : describeHits(`${basename(state.used)} recipe ${wanted.join(" ")}`, scanText(lines.join("\n"), { ...rt, scope: { ...rt.scope, dir: state.dir } }));
}

/** curlie: curl's options (the method, the data flags) and httpie's items (`name=value`). */
function curlieTags(args: string[], piped: boolean): DspTag[] {
	const curl = curlTags(args);
	if (curl.length > 0) return curl;
	const words: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (CURL_VALUE_FLAGS.has(args[i]) || args[i] === "-X" || args[i] === "--request") i++;
		else words.push(args[i]);
	}
	return httpieTags(words, piped);
}

/** aria2c with custom headers or a request body sends more than a download. */
function aria2Tags(args: string[]): DspTag[] {
	const sends = args.some((arg) => /^--(header|post-file|post-data|body-data|body-file|method)(=|$)/.test(arg));
	return sends ? httpWriteTag(args.filter((arg) => /^[a-z][a-z0-9+.-]*:\/\//i.test(arg))) : [];
}

const LWP_VALUE_OPTIONS = new Set(["-m", "-c", "-t", "-p", "-H", "-b", "-C", "-E", "-o", "-x"]);

/** `lwp-request -m POST url` and the `POST` alias. */
function lwpTags(name: string, args: string[]): DspTag[] {
	const attached = args.find((arg) => /^-m./.test(arg))?.slice(2);
	const method = (name === "POST" ? "POST" : (optionValue(args, "-m") ?? attached))?.toUpperCase();
	const writes = method !== undefined && (WRITE_METHODS.has(method) || /[$`]/.test(method));
	return writes ? httpWriteTag(positionals(args, LWP_VALUE_OPTIONS)) : [];
}

function shellFileArgument(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		if (SHELL_VALUE_OPTIONS.has(args[i])) i++;
		else if (!args[i].startsWith("-") && !args[i].startsWith("+")) return args[i];
	}
	return undefined;
}

/** Inline code (`python -c`, `node -e`): what it names, and asking when it starts processes (the command may be assembled at run time). */
function inlineTags(interpreter: string, code: string, rt: Runtime): DspTag[] {
	const tags = describeHits("inline code", scanText(code, rt));
	if (spawnsProcesses(interpreter, code)) tags.push(unknownTag(`inline ${interpreter} code starts processes, so the command it runs cannot be checked for remote actions`, true));
	if (CREDENTIAL_CODE.test(code)) tags.push(remote("credential access (inline code names a credential file)"));
	return tags;
}

// ── environment, credentials and command strings around a segment ───────────────────────────────────────────

const ASSIGNMENT_WORD = /^([A-Za-z_][A-Za-z0-9_]*)\+?=([\s\S]*)$/;
const ASSIGNING_BUILTINS = new Set(["export", "declare", "typeset", "readonly", "local", "env", "setenv", "let"]);
// The names the credential lock (S10) removes or overrides come from lib/dsp-credlock.ts; `GIT_SSH` is not overridden by the lock but asks as well.
/** `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_0`, `GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL`, ... */
const isGitConfigName = (name: string) => /^GIT_CONFIG(_|$)/.test(name);
/** The prompt switches only stop questions (`GIT_TERMINAL_PROMPT=0` is common in scripts), so setting them does not ask. */
const PROMPT_SWITCHES = ["GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE"];
const isOverriddenName = (name: string) => {
	const upper = name.toUpperCase();
	return AGENT_VARIABLES.includes(upper) || (OVERRIDDEN_VARIABLES.includes(upper) && !PROMPT_SWITCHES.includes(upper)) || name === "GIT_SSH" || isGitConfigName(name);
};
const isLockedName = (name: string) => isOverriddenName(name) || isLockedVariable(name);
/** Variables whose value is a command string that git or ssh runs. */
const COMMAND_ENV = new Set(["GIT_SSH_COMMAND", "GIT_SSH", "GIT_EXTERNAL_DIFF", "GIT_PAGER", "GIT_EDITOR", "GIT_SEQUENCE_EDITOR", "GIT_PROXY_COMMAND", "GIT_ASKPASS", "SSH_ASKPASS", "EDITOR", "VISUAL", "PAGER"]);
const KEYCHAIN_COMMANDS = /^(find-.+|dump-keychain|export|import|unlock-keychain|show-keychain-info|add-(generic|internet)-password|set-key-partition-list)$/;
// Files that hold credentials; `.npmrc` counts only in the home directory (a project's own `.npmrc` is ordinary).
const CREDENTIAL_PATH = /(^|\/)(\.ssh|\.netrc|\.git-credentials|\.docker|\.aws\/credentials|\.config\/gh|\.pi\/agent\/auth\.json)(\/|$)/;
const CREDENTIAL_CODE = /\.(ssh|netrc|npmrc|git-credentials|docker)\b|\.aws\/credentials|\.config\/gh\b/;
/** Commands that only list, test or print a name: mentioning a credential path does not read it. */
const CREDENTIAL_READ_EXEMPT = new Set(["ls", "stat", "test", "[", "[[", "echo", "printf"]);

/** `NAME=value` words that assign: the leading ones, and those after `export`, `declare`, `env`, ... */
function assignments(rawArgv: string[]): Array<{ name: string; value: string }> {
	const found: Array<{ name: string; value: string }> = [];
	let leading = true;
	let assigning = false;
	for (const word of rawArgv) {
		const match = ASSIGNMENT_WORD.exec(word);
		if (match) {
			if (leading || assigning) found.push({ name: match[1], value: match[2] });
			continue;
		}
		if (leading && RESERVED_WORDS.has(word)) continue;
		leading = false;
		if (ASSIGNING_BUILTINS.has(basename(word))) assigning = true;
	}
	return found;
}

/** Modules node loads before the program: `-r x`, `--require x`, `--import x`, `--loader x` (also with `=`). */
function preloadSpecs(args: string[]): string[] {
	return optionValues(args, ["--require", "--import", "--loader", "--experimental-loader"], ["-r"]);
}

/** A preloaded file is a script that runs first: scan it. A bare name is a package from node_modules. */
function nodePreloadTags(specs: string[], rt: Runtime): DspTag[] {
	const tags: DspTag[] = [];
	for (const spec of specs) {
		if (/^data:/i.test(spec) || UNCERTAIN_CONTENT.test(spec)) tags.push(unknownTag("a node preload is inline code or built from a variable, so it cannot be checked for remote actions", true));
		else if (/^(\.{0,2}\/|~\/|file:)/.test(spec)) tags.push(...scriptFileTags(spec.replace(/^file:\/\//, ""), rt));
	}
	return tags;
}

// awk starts processes with `system(...)`, `"cmd" | getline` and `print | "cmd"`.
const AWK_SPAWN = /\bsystem\s*\(|(?<![|])\|&?\s*getline\b|\bprintf?\b[^;}\n]*?(?<![|])\|(?![|])/;
const AWK_VALUE_OPTIONS = new Set(["-F", "-v", "-i", "-l", "-E", "-W"]);

/** awk, gawk, mawk: a program that spawns a process asks (what it runs can be assembled at run time). */
function awkTags(args: string[], rt: Runtime): DspTag[] {
	const tags: DspTag[] = [];
	const spawn = () => tags.push(unknownTag("awk code starts processes (system, getline from a command, print to a command), so the command it runs cannot be checked for remote actions", true));
	let hasSource = false;
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-f" || arg === "--file" || arg.startsWith("--file=")) {
			hasSource = true;
			const file = arg.startsWith("--file=") ? arg.slice("--file=".length) : args[++i];
			const path = file === undefined ? undefined : resolveFrom(file, rt);
			const read = path === undefined ? undefined : reader(rt)(path);
			if (file !== undefined && (read === undefined || (!("text" in read) && !("missing" in read) && !("notFile" in read)) || ("text" in read && AWK_SPAWN.test(read.text)))) spawn();
		} else if (arg === "-e" || arg === "--source" || arg.startsWith("--source=")) {
			hasSource = true;
			const code = arg.startsWith("--source=") ? arg.slice("--source=".length) : args[++i];
			if (code !== undefined && AWK_SPAWN.test(code)) spawn();
		} else if (AWK_VALUE_OPTIONS.has(arg)) i++;
		else if (arg === "--") {
			if (!hasSource && args[i + 1] !== undefined && AWK_SPAWN.test(args[i + 1])) spawn();
			break;
		} else if (!arg.startsWith("-") || arg === "-") {
			if (!hasSource && AWK_SPAWN.test(arg)) spawn();
			break;
		}
	}
	return tags;
}

/** Classifies command strings that git, ssh or a variable hand to a shell: literal ones like a shell command, the others ask. */
function embeddedCommands(texts: string[], rt: Runtime): { tags: DspTag[]; nested: CommandMatch[] } {
	const tags: DspTag[] = [];
	const nested: CommandMatch[] = [];
	for (const text of texts) {
		if (text.trim() === "") continue;
		if (UNCERTAIN_CONTENT.test(text)) tags.push(unknownTag(`a command string (${text.slice(0, 40)}) is built from a variable or substitution: it cannot be checked for remote actions`, true));
		else if (rt.ctx.depth >= MAX_SCAN_DEPTH) tags.push(unknownTag("command strings are nested too deeply to scan", true));
		else nested.push(...nestedMatches(text, rt, rt.ctx.depth + 1));
	}
	return { tags, nested };
}

// ── builtins that assign, shells that load startup files, bulk and glob reads ──

const isRedirectWord = (word: string) => /^[0-9]*[<>]|^&>/.test(word);
/** The variable a word names: `NAME`, `NAME=value`, `NAME+=value`, `NAME[0]=value` -> `NAME` (`$v=0` stays `$v`: not a literal name). */
const namePart = (word: string) => word.replace(/^([^=]*)=[\s\S]*$/, "$1").replace(/\+$/, "").replace(/\[[\s\S]*$/, "");

/** The operands of a builtin up to the first redirection, without options (`values`: options that take a separate value). */
function operandWords(args: string[], values: ReadonlySet<string> = new Set()): string[] {
	const found: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (isRedirectWord(word) || word === "|") break;
		if (values.has(word)) i++;
		else if (word === "" || word === "--" || ((word.startsWith("-") || word.startsWith("+")) && word.length > 1)) continue;
		else found.push(word);
	}
	return found;
}

/** The variables `read` assigns: its operands, the array after `-a`, but not the values of `-d`, `-n`, `-p`, `-t`, `-u`, `-i`, `-N` (also at the end of a cluster such as `-rd ''`). */
function readTargets(args: string[]): string[] {
	const names: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const word = args[i];
		if (isRedirectWord(word) || word === "|") break;
		if (/^-[A-Za-z]+$/.test(word)) {
			const last = word[word.length - 1];
			if (last === "a" || last === "A") {
				if (args[i + 1] !== undefined) names.push(args[++i]);
			} else if ("dinNptu".includes(last)) i++;
			continue;
		}
		if (word === "" || word.startsWith("-") || word.startsWith("+")) continue;
		names.push(word.replace(/\?.*$/, "")); // zsh: `read 'name?prompt'`
	}
	return names;
}

const MAPFILE_VALUES = new Set(["-d", "-n", "-O", "-s", "-u", "-C", "-c"]);

/**
 * The variables a shell builtin changes without a `NAME=value` word: `read NAME`, `printf -v NAME`, `for NAME in`,
 * `select NAME`, `getopts opts NAME`, `mapfile NAME`, `wait -p NAME`, `export -n`, `unset`, and `declare|typeset|local|readonly`
 * with any flags (`typeset +x NAME` unexports it, `declare -n ref=NAME` points a name at it). `export NAME[=value]` only
 * lists a name that is not a literal (`export "$v=0"`).
 */
function builtinTargets(name: string, args: string[]): string[] {
	switch (name) {
		case "unset":
			return operandWords(args).map(namePart);
		case "export": {
			const names = operandWords(args).map(namePart);
			return args.some((arg) => /^-[A-Za-z]*n[A-Za-z]*$/.test(arg)) ? names : names.filter((word) => /[$`]/.test(word));
		}
		case "declare":
		case "typeset":
		case "local":
		case "readonly": {
			const words = operandWords(args);
			const targets = words.map(namePart);
			if (args.some((arg) => /^[-+][A-Za-z]*n[A-Za-z]*$/.test(arg))) targets.push(...words.filter((word) => word.includes("=")).map((word) => word.slice(word.indexOf("=") + 1)));
			return targets;
		}
		case "read":
			return readTargets(args).map(namePart);
		case "mapfile":
		case "readarray":
			return operandWords(args, MAPFILE_VALUES).map(namePart);
		case "printf": {
			const at = args.findIndex((arg) => arg === "-v" || /^-v./.test(arg));
			if (at < 0) return [];
			return [namePart(args[at] === "-v" ? (args[at + 1] ?? "") : args[at].slice(2))];
		}
		case "getopts":
			return args[1] === undefined ? [] : [namePart(args[1])];
		case "for":
		case "select": {
			const end = args.indexOf("in");
			return (end === -1 ? args : args.slice(0, end)).filter((word) => !isRedirectWord(word)).map(namePart);
		}
		case "wait": {
			const at = args.indexOf("-p");
			return at >= 0 && args[at + 1] !== undefined ? [namePart(args[at + 1])] : [];
		}
		default:
			return [];
	}
}

/** Shells (and look-alikes) that read startup files when they are interactive or login shells. */
const STARTUP_SHELLS = new Set([...SHELLS, "ash", "csh", "tcsh", "mksh", "rbash", "pdksh", "yash"]);

/** Why a shell's options make it read startup files (`-i`, `-l`, `--login`, `-ic`, `--rcfile`), or undefined. Only options before the script or command text count. */
function shellStartupReason(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") return undefined;
		if (arg === "--login" || arg === "--interactive") return `${arg} makes it a login or interactive shell`;
		if (arg === "--rcfile" || arg === "--init-file" || arg.startsWith("--rcfile=") || arg.startsWith("--init-file=")) return `${arg.split("=")[0]} loads an rc file`;
		if (SHELL_VALUE_OPTIONS.has(arg)) {
			i++;
			continue;
		}
		if (/^-[A-Za-z]+$/.test(arg)) {
			if (/[il]/.test(arg)) return `${arg} makes it a login or interactive shell`;
			continue;
		}
		if (arg.startsWith("-") || arg.startsWith("+")) continue;
		return undefined;
	}
	return undefined;
}

/** `exec -l cmd` starts the command as a login shell would be started. */
function execLogin(rawArgv: string[]): boolean {
	const at = rawArgv.findIndex((word) => basename(word) === "exec");
	if (at < 0 || !rawArgv.slice(0, at).every((word) => ASSIGNMENT.test(word) || RESERVED_WORDS.has(word))) return false;
	for (let i = at + 1; i < rawArgv.length; i++) {
		const word = rawArgv[i];
		if (word === "-a") i++;
		else if (/^-[a-z]+$/.test(word)) {
			if (word.includes("l")) return true;
		} else break;
	}
	return false;
}

/** The absolute path a word names under `~`, `$HOME`, `${HOME}`, an absolute path or (when the directory is known) a relative one; undefined for other variables. */
function homePath(word: string, rt: Runtime): string | undefined {
	const home = rt.env.home ?? homedir();
	const expanded = word === "~" ? home : word.startsWith("~/") ? join(home, word.slice(2)) : word.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
	if (/[$`]/.test(expanded)) return undefined;
	if (isAbsolute(expanded)) return resolve(expanded);
	return rt.scope.dir === undefined ? undefined : resolve(rt.scope.dir, expanded);
}

/**
 * A glob in a hidden path under the home directory (`~/.git-cred` plus a star, `~/.[g]it-credentials`, a star in `~/.config/gh/`):
 * its directory part could match a credential or startup file, so it asks. A glob whose first segment is not hidden
 * (a glob in `~/projects`), or a relative one outside the home directory, does not.
 */
function globsHiddenHomePath(word: string, rt: Runtime): boolean {
	const home = resolve(rt.env.home ?? homedir());
	const spellings = [word.replace(/^[0-9]*[<>]+&?/, ""), ...word.split(/[=:,]/)];
	return spellings.some((spelling) => {
		// Brace expansion (`~/.{git-credentials,npmrc}`) names several paths at once: each one is judged like a glob.
		const alternatives = expandBraces(spelling);
		if (alternatives.length > 1) return alternatives.some((one) => hiddenHomeTarget(one, rt, home));
		if (!/[*?[]/.test(spelling)) return false;
		return hiddenHomeTarget(spelling, rt, home);
	});
}

const BRACE_LIMIT = 64;

/** Bash brace expansion of comma lists (`a{b,c}d` -> `abd`, `acd`), nested and repeated, capped at 64 results. A word without a comma list is returned as is. */
export function expandBraces(word: string): string[] {
	for (let open = word.indexOf("{"); open !== -1; open = word.indexOf("{", open + 1)) {
		let depth = 0;
		const commas: number[] = [];
		let close = -1;
		for (let i = open; i < word.length; i++) {
			const char = word[i];
			if (char === "{") depth++;
			else if (char === "}" && --depth === 0) {
				close = i;
				break;
			} else if (char === "," && depth === 1) commas.push(i);
		}
		if (close === -1 || commas.length === 0) continue;
		const cuts = [open, ...commas, close];
		const parts = cuts.slice(0, -1).map((cut, i) => word.slice(cut + 1, cuts[i + 1]));
		const prefix = word.slice(0, open);
		const suffix = word.slice(close + 1);
		const out: string[] = [];
		for (const part of parts) {
			for (const one of expandBraces(`${prefix}${part}${suffix}`)) {
				out.push(one);
				if (out.length >= BRACE_LIMIT) return out;
			}
		}
		return out;
	}
	return [word];
}

/** The path a home glob or brace alternative names is under the home directory and its first segment is hidden (or itself a pattern). */
function hiddenHomeTarget(spelling: string, rt: Runtime, home: string): boolean {
	{
		const explicit = isAbsolute(spelling) || spelling.startsWith("~") || /^\$\{?HOME/.test(spelling);
		if (!explicit && rt.scope.dir !== home) return false;
		const absolute = homePath(spelling, rt);
		if (absolute === undefined) return false;
		// A project that sits in a hidden folder may glob its own files.
		const cwd = resolve(rt.env.cwd);
		if (cwd !== home && !relative(cwd, absolute).startsWith("..")) return false;
		const rel = relative(home, absolute);
		if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return false;
		const first = rel.split("/")[0];
		return first.startsWith(".") || /[[{]/.test(first);
	}
}

/** The home directory itself or a hidden folder right under it (`~`, `~/`, `$HOME`, `~/.config`): reading it recursively reads every credential below. */
function isBulkHomeOperand(word: string, rt: Runtime): boolean {
	const home = resolve(rt.env.home ?? homedir());
	const absolute = homePath(word, rt);
	if (absolute === undefined) return false;
	return absolute === home || (dirname(absolute) === home && basename(absolute).startsWith("."));
}

const GREP_VALUES = new Set(["-e", "-f", "-m", "-A", "-B", "-C", "-d", "-D", "--regexp", "--file", "--max-count", "--include", "--exclude", "--exclude-dir", "--exclude-from", "--label", "--after-context", "--before-context", "--context", "--directories", "--devices"]);
const RG_VALUES = new Set(["-e", "-f", "-g", "-t", "-T", "-A", "-B", "-C", "-m", "-j", "-M", "-E", "-r", "--regexp", "--file", "--glob", "--iglob", "--type", "--type-not", "--type-add", "--max-count", "--threads", "--max-depth", "--max-filesize", "--replace", "--context", "--after-context", "--before-context", "--encoding", "--ignore-file", "--pre", "--pre-glob", "--sort", "--sortr"]);
const TAR_VALUES = new Set(["-f", "-C", "-T", "-X", "-I", "-L", "--file", "--directory", "--files-from", "--exclude-from", "--exclude", "--use-compress-program", "--transform", "--strip-components"]);
const CP_VALUES = new Set(["-t", "--target-directory", "-S", "--suffix"]);
const ZIP_VALUES = new Set(["-x", "-i", "-b", "-t", "-tt", "-P", "-n", "-O", "-Z", "--exclude", "--include", "--password"]);

/** The operands a command reads recursively (everything below them), for the commands that archive, copy or search a tree. */
function bulkReadOperands(name: string, args: string[], rt: Runtime): string[] {
	const cluster = (letters: string) => args.some((arg) => new RegExp(`^-[A-Za-z]*[${letters}][A-Za-z]*$`).test(arg));
	switch (name) {
		case "grep":
		case "egrep":
		case "fgrep":
		case "zgrep": {
			if (!(cluster("rR") || hasFlag(args, "--recursive", "--dereference-recursive"))) return [];
			const words = positionals(args, GREP_VALUES);
			return hasFlag(args, "-e", "-f", "--regexp", "--file") ? words : words.slice(1);
		}
		case "rg":
		case "ag":
		case "ack": {
			if (name === "rg" && hasFlag(args, "--files")) return [];
			const words = positionals(args, RG_VALUES);
			return hasFlag(args, "-e", "-f", "--regexp", "--file") ? words : words.slice(1);
		}
		case "tar":
		case "bsdtar":
		case "gtar": {
			// Old style: `tar czf out.tgz ~` (no dash on the first word).
			if (args[0] !== undefined && !args[0].startsWith("-") && /^[A-Za-z]+$/.test(args[0])) return /c/.test(args[0]) ? args.slice(/f/.test(args[0]) ? 2 : 1) : [];
			return cluster("c") || hasFlag(args, "--create") ? positionals(args, TAR_VALUES) : [];
		}
		case "cp":
		case "ditto":
		case "rsync": {
			if (name === "cp" && !(cluster("rRa") || hasFlag(args, "--recursive", "--archive"))) return [];
			const words = positionals(args, name === "rsync" ? RSYNC_VALUES : CP_VALUES);
			// The last operand is where it copies to (all of them are sources with `-t dir`).
			return hasFlag(args, "-t", "--target-directory") ? words : words.slice(0, -1);
		}
		case "zip":
			return cluster("r") || hasFlag(args, "--recurse-paths") ? positionals(args, ZIP_VALUES).slice(1) : [];
		case "7z":
		case "7za":
		case "7zr":
		case "7zz": {
			const words = positionals(args);
			return words[0] === "a" ? words.slice(2) : [];
		}
		case "find": {
			// Names alone are not secrets: it reads when it runs a command on what it finds or hands the names on to one.
			const runs = args.some((arg) => ["-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(arg)) || /\bfind\b[^|;&\n]*\|\s*(?:\S*\/)?(?:xargs|parallel)\b/.test(rt.ctx.commandText);
			if (!runs) return [];
			let from = 0;
			while (["-H", "-L", "-P"].includes(args[from])) from++;
			const stop = args.findIndex((arg, i) => i >= from && (arg.startsWith("-") || arg === "(" || arg === "!" || arg === ","));
			return args.slice(from, stop === -1 ? undefined : stop);
		}
		default:
			return [];
	}
}

/** `/proc/<pid|self|$$|$PPID>/environ` holds the whole environment of a process, the tokens the lock removed included. */
const PROC_ENVIRON = /\/proc\/[^\s/]*\/(?:task\/[^\s/]*\/)?environ\b/;
const PS_VALUE_OPTIONS = new Set(["-p", "-u", "-U", "-g", "-G", "-t", "-C", "-o", "-O", "-s", "-N", "-j", "--pid", "--user", "--sort", "--format"]);

/** BSD-style `ps e`, `ps eww`, `ps auxe` print each process's environment. */
const psShowsEnvironment = (args: string[]) => positionals(args, PS_VALUE_OPTIONS).some((word) => /^[A-Za-z]*e[A-Za-z]*$/.test(word));

function credentialProgramTags(name: string, args: string[]): DspTag[] {
	const access = (what: string) => [remote(`credential access (${what})`)];
	switch (name) {
		case "ssh-add":
			return access("ssh-add");
		case "launchctl": {
			const [sub] = positionals(args);
			return sub !== undefined && ["getenv", "setenv", "unsetenv", "asuser", "export"].includes(sub) ? access(`launchctl ${sub}`) : [];
		}
		case "security": {
			const [sub] = positionals(args);
			return sub !== undefined && KEYCHAIN_COMMANDS.test(sub) ? access(`security ${sub}`) : [];
		}
		case "ssh":
		case "scp":
		case "sftp":
		case "mosh":
		case "autossh": {
			const identity = args.some((arg, i) => arg === "-i" || /^-i./.test(arg) || /^-[A-Za-z]+i$/.test(arg) || (args[i - 1] === "-o" && /^Identity(File|Agent)/i.test(arg)) || /^-oIdentity(File|Agent)/i.test(arg));
			return identity ? access(`${name} with an identity file`) : [];
		}
		default:
			return [];
	}
}

/** A word naming a credential file: `~/.ssh/id_rsa`, `$HOME/.netrc`, `<~/.git-credentials`, `--file=~/.docker/config.json`. */
function touchesCredentialPath(word: string, rt: Runtime): boolean {
	const home = rt.env.home ?? homedir();
	// Also the parts of `--file=path`, `NAME=path`, `-v ~/.ssh:/root/.ssh` and `--mount source=path,target=x`.
	const spellings = [word.replace(/^[0-9]*[<>]+&?/, ""), ...word.split(/[=:,]/)];
	return spellings.some((spelling) => {
		const expanded = spelling === "~" ? home : spelling.startsWith("~/") ? join(home, spelling.slice(2)) : spelling.replace(/^\$\{?HOME\}?(?=\/|$)/, home);
		if (CREDENTIAL_PATH.test(expanded)) return true;
		const absolute = isAbsolute(expanded) ? expanded : rt.scope.dir === undefined ? undefined : resolve(rt.scope.dir, expanded);
		return absolute !== undefined && isCredentialPath(absolute, home);
	});
}

/** What surrounds a segment's command: assigned variables (the credential lock, command strings, preloads), `unset`, `env -u|-i`, credential programs and credential files. */
function surroundingMatches(seg: SegmentInfo, unwrapped: UnwrapResult, rt: Runtime): CommandMatch[] {
	const { rawArgv, argv } = seg;
	const tags: DspTag[] = [];
	const nested: CommandMatch[] = [];
	const name = argv.length > 0 ? basename(argv[0]) : "";
	const change = (ref: string) => tags.push(remote("credential environment change", { ref }));

	for (const { name: variable, value } of assignments(rawArgv)) {
		if (isLockedName(variable)) change(variable);
		if (COMMAND_ENV.has(variable)) {
			const embedded = embeddedCommands([value], rt);
			tags.push(...embedded.tags);
			nested.push(...embedded.nested);
		} else if (variable === "NODE_OPTIONS") tags.push(...nodePreloadTags(preloadSpecs(tokenize(value).flatMap((segment) => segment.argv)), rt));
		// A shell that loads a startup file can export the tokens again: `ENV` only matters to a shell, the others to any command.
		else if (variable === "BASH_ENV" || variable === "ZDOTDIR" || (variable === "ENV" && (STARTUP_SHELLS.has(name) || argv.length === 0))) tags.push(remote("shell startup file (it can export the tokens the credential lock removed)", { ref: variable }));
		else if (variable === "WGETRC") {
			if (rcWrites(value, rt, WGET_WRITE_KEY)) tags.push(remote("HTTP write (wgetrc)", { ref: value }));
		} else if (variable === "CURL_HOME") {
			if ([".curlrc", "_curlrc"].some((rc) => rcWrites(`${value}/${rc}`, rt, CURL_WRITE_KEY))) tags.push(remote("HTTP write (curlrc)", { ref: value }));
		} else if (variable === "GIT_EXEC_PATH") tags.push(unknownTag("GIT_EXEC_PATH makes git run subcommands from another directory", true));
	}
	// `${NAME:=value}` assigns when NAME is unset.
	for (const word of rawArgv) for (const found of word.matchAll(/\$\{([A-Za-z_]\w*):?=/g)) if (isLockedName(found[1])) change(found[1]);
	// Builtins that assign, unexport or unset a variable without `NAME=value`; a name the guard cannot read asks.
	for (const target of builtinTargets(name, argv.slice(1))) {
		if (/[$`]/.test(target)) change(`${name} with a variable name the guard cannot read (${target})`);
		else if (name === "unset" ? isOverriddenName(target) : isLockedName(target)) change(name === "unset" ? `unset ${target}` : `${name} ${target}`);
	}
	if (STARTUP_SHELLS.has(name)) {
		const reason = shellStartupReason(argv.slice(1));
		if (reason !== undefined) tags.push(remote("shell startup files (an interactive or login shell loads the rc files that can export the tokens again)", { ref: reason }));
	}
	if (execLogin(rawArgv)) tags.push(remote("shell startup files (exec -l starts a login shell)"));
	for (const word of unwrapped.env?.unset ?? []) if (isOverriddenName(word)) change(`env -u ${word}`);
	if (unwrapped.env?.clear) change("environment cleared (the credential lock goes with it)");

	tags.push(...credentialProgramTags(name, argv.slice(1)));
	if (!CREDENTIAL_READ_EXEMPT.has(name)) {
		const word = rawArgv.find((candidate) => touchesCredentialPath(candidate, rt) || globsHiddenHomePath(candidate, rt));
		if (word !== undefined) tags.push(remote("credential access (reads a credential file)", { ref: word }));
		const bulk = bulkReadOperands(name, argv.slice(1), rt).find((operand) => isBulkHomeOperand(operand, rt));
		if (bulk !== undefined) tags.push(remote("credential access (reads the home directory recursively)", { ref: bulk }));
		const environ = rawArgv.find((candidate) => PROC_ENVIRON.test(candidate));
		if (environ !== undefined) tags.push(remote("credential access (reads a process environment)", { ref: environ }));
		if (name === "ps" && psShowsEnvironment(argv.slice(1))) tags.push(remote("credential access (ps prints process environments)"));
	}
	return tags.length > 0 ? [carrier(tags), ...nested] : nested;
}

const REPO_LOCATION_ASSIGNMENT = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE)=/;

/** The automatic backup is taken in the session's repository: a discard that acts on another one asks instead. */
const OTHER_REPOSITORY = "the automatic backup can only protect the session's repository";

/** `git -C dir`, `--git-dir`, `--work-tree`, `-c core.worktree=`: the invocation names its own repository. */
function gitNamesOtherRepository(argv: string[]): boolean {
	const name = basename(argv[0] ?? "");
	if (name !== "git" && name !== "hub") return false;
	const args = argv.slice(1);
	const index = gitSubcommand(args);
	const prefix = index === -1 ? args : args.slice(0, index);
	return prefix.some((arg, i) => arg === "-C" || arg.startsWith("--git-dir") || arg.startsWith("--work-tree") || (arg === "-c" && /^core\.(worktree|bare)\b/i.test(prefix[i + 1] ?? "")));
}

function refineSegment(seg: SegmentInfo, found: CommandMatch[], base: Runtime): CommandMatch[] {
	const unwrapped = dspUnwrap(seg.rawArgv);
	// `env -C dir cmd` runs cmd in dir: relative scripts and targets mean what they mean there.
	const rt: Runtime = unwrapped.chdir === undefined ? base : { ...base, scope: { ...base.scope, dir: resolveFrom(unwrapped.chdir, base) } };
	const matches = [...refineCore(seg, found, rt, unwrapped), ...surroundingMatches(seg, unwrapped, rt)];
	// A discard after a directory move, or naming another repository, is not backed up (the backup is of the session's repository): it asks.
	const sets = seg.rawArgv.some((word) => REPO_LOCATION_ASSIGNMENT.test(word));
	const otherRepository = base.scope.repoMoved === true || unwrapped.chdir !== undefined || sets || gitNamesOtherRepository(seg.argv);
	if (otherRepository) {
		for (const match of matches) {
			if (!match.dsp?.some((tag) => tag.type === "discard")) continue;
			match.dsp = [...match.dsp.filter((tag) => tag.type !== "discard"), unknownTag(OTHER_REPOSITORY)];
		}
	}
	if (sets || ["cd", "pushd", "popd"].includes(basename(seg.argv[0] ?? ""))) base.scope.repoMoved = true;
	return matches;
}

function refineCore(seg: SegmentInfo, found: CommandMatch[], rt: Runtime, unwrapped: UnwrapResult): CommandMatch[] {
	const { argv, rawArgv, before } = seg;
	const { scope, env } = rt;
	// A wrapper whose command the guard cannot read (a script file, standard input, a remote host).
	for (const reason of unwrapped.opaque ?? []) found = [...found, unknownMatch(reason, true)];
	// bash opens network connections itself through /dev/tcp and /dev/udp.
	const devNet = rawArgv.find((word) => /\/dev\/(tcp|udp)\//.test(word));
	if (devNet) found = [...found, carrier([remote(REMOTE_SHELL, { ref: devNet.slice(devNet.indexOf("/dev/")) })])];
	else if (rawArgv.some((word) => /\/dev\/[^\s/]*[$`]/.test(word))) found = [...found, unknownMatch("a /dev/ path built from a variable may be /dev/tcp", true)];
	if (argv.length === 0) return found;
	const head = argv[0];
	const name = basename(head);
	const args = argv.slice(1);
	const home = env.home ?? homedir();

	// The command itself comes from a variable or a substitution.
	if (UNCERTAIN_CONTENT.test(head)) return [...found, unknownMatch(`the command name (${head}) comes from a variable or substitution`)];
	// `/usr/bin/gi?` and `{git,x}` name a command the shell expands.
	if (head !== "[[" && head.length > 1 && /[*?[{]/.test(head)) return [...found, unknownMatch(`the command name (${head}) is a pattern the shell expands`)];
	if (unwrapped.xargs) {
		const reason = xargsReason(unwrapped.xargs, argv);
		if (reason) found = [...found, unknownMatch(`${reason}: it cannot be checked for remote actions`, true)];
	}
	// The subcommand decides what a package manager, container tool or forge client does.
	if (name !== "git" && name !== "hub" && name !== "gh" && SUBCOMMAND_TOOLS.has(name) && positionals(args, VALUE_OPTIONS[name] ?? new Set()).slice(0, 1).some((word) => UNCERTAIN_CONTENT.test(word))) {
		found = [...found, unknownMatch(`the ${name} subcommand comes from a variable or substitution: it cannot be checked for remote actions`, true)];
	}
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
		if (file !== undefined && file !== "<" && !file.startsWith("<") && !STDIN_PATH.test(file)) return attach(found, scriptFileTags(file, rt));
		// `bash /dev/stdin <<< 'text'`, `. /dev/stdin < file`: the program is on standard input.
		const piped = file !== undefined && STDIN_PATH.test(file) && before === "|" ? [unknownTag("it runs a program piped in from another command, which cannot be checked for remote actions", true)] : [];
		return attach(found, [...stdinProgramTags(args, rt), ...piped]);
	}

	const own = ownMatch(found);
	const tags: DspTag[] = [];
	const nested: CommandMatch[] = [];
	let handled = true;
	const gitStrings = (gitArgs: string[]) => {
		const embedded = embeddedCommands(gitCommandStrings(gitArgs), rt);
		tags.push(...embedded.tags);
		nested.push(...embedded.nested);
	};

	const embed = (texts: string[]) => {
		const embedded = embeddedCommands(texts, rt);
		tags.push(...embedded.tags);
		nested.push(...embedded.nested);
	};
	const embedTexts = (texts: CommandTexts) => {
		embed(texts.commands);
		for (const reason of texts.opaque) tags.push(unknownTag(reason, true));
	};

	// `git-push`, `git-send-pack`: the dashed form of a git subcommand.
	if (/^git-.+/.test(name)) {
		const dashed = [name.slice(4), ...args];
		gitStrings(dashed);
		return [...attach(found, [...gitTags(dashed, own), ...tags]), ...nested];
	}

	switch (name) {
		case "ssh":
		case "mosh":
		case "autossh":
		case "scp":
		case "rsync":
		case "sftp":
		case "openssl":
			tags.push(...rawRemoteTags(name, args));
			break;
		case "git":
			tags.push(...gitTags(args, own));
			gitStrings(args);
			break;
		case "hub":
			tags.push(...hubTags(args));
			if (tags.length === 0) {
				tags.push(...gitTags(args, own));
				gitStrings(args);
			}
			break;
		case "gh":
			tags.push(...ghTags(args));
			break;
		case "curl":
			tags.push(...curlTags(args));
			break;
		case "wget":
			tags.push(...wgetTags(args, rt));
			break;
		case "awk":
		case "gawk":
		case "mawk":
		case "nawk":
			tags.push(...awkTags(args, rt));
			break;
		case "http":
		case "https":
		case "xh":
		case "xhs":
			tags.push(...httpieTags(args, before === "|"));
			break;
		case "curlie":
			tags.push(...curlieTags(args, before === "|"));
			break;
		case "aria2c":
			tags.push(...aria2Tags(args));
			break;
		case "lwp-request":
		case "POST":
			tags.push(...lwpTags(name, args));
			break;
		case "at":
		case "batch":
			tags.push(...atTags(args, rt, before));
			break;
		case "just":
			tags.push(...justTags(args, rt));
			break;
		case "vim":
		case "vi":
		case "nvim":
		case "ex":
		case "view":
		case "vimdiff":
		case "nvimdiff":
		case "gvim":
		case "mvim":
		case "rvim":
		case "rview":
		case "evim":
		case "ed":
			embedTexts(editorTexts(name, args, rt, before));
			break;
		case "emacs":
		case "emacsclient":
			embedTexts(emacsTexts(args, rt, name === "emacsclient"));
			break;
		case "sed":
		case "gsed":
			embedTexts(sedTexts(args, rt));
			break;
		case "npm":
		case "pnpm":
		case "yarn":
		case "bun": {
			tags.push(...publishTags(name, args), ...packageScriptTags(name, args, rt));
			const inline = name === "bun" ? inlineProgram("bun", args) : undefined;
			if (inline !== undefined) tags.push(...inlineTags("bun", inline, rt));
			if (name === "bun") {
				// `bun --preload ./x.js`, `-r`: a file that runs first; `bun x.ts` and `bun run x.ts` run a file.
				tags.push(...nodePreloadTags(optionValues(args, ["--preload", "--require", "--import"], ["-r"]), rt));
				const [first, second] = positionals(args, VALUE_OPTIONS.bun ?? new Set<string>());
				const file = first === "run" ? second : first;
				if (file !== undefined && /\.[cm]?[jt]sx?$/.test(file)) tags.push(...scriptFileTags(file, rt));
			}
			break;
		}
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
			if (NETWORK_PROGRAMS.has(name)) tags.push(...rawRemoteTags(name, args));
			else handled = false;
	}

	if (!handled) {
		// An interpreter running a file or inline code, or a file run directly.
		const interpreter = interpreterOf(name);
		if (FILE_INTERPRETERS.has(interpreter)) {
			// `node -r ./x.js`, `--require`, `--import`, `--loader` run a file before the program.
			const preloads = interpreter === "node" || interpreter === "nodejs" ? preloadSpecs(args) : [];
			tags.push(...nodePreloadTags(preloads, rt));
			const inline = inlineProgram(interpreter, args);
			if (inline !== undefined) {
				tags.push(...inlineTags(interpreter, inline, rt));
			} else {
				const candidates = args.filter((arg) => !arg.startsWith("-") && !preloads.includes(arg)).slice(0, 4);
				let scanned = false;
				let fromStdin = false;
				for (const candidate of candidates) {
					if (STDIN_PATH.test(candidate)) {
						fromStdin = true;
						scanned = true;
						break;
					}
					const path = resolveFrom(candidate, rt);
					if (path !== undefined && "missing" in reader(rt)(path)) continue;
					tags.push(...scriptFileTags(candidate, rt));
					scanned = true;
					break;
				}
				if (!scanned && candidates[0] !== undefined && writtenHere(candidates[0], rt)) tags.push(unknownTag(`${candidates[0]} is written and run in the same command, so its text cannot be checked`, true));
				if (fromStdin || !scanned || args.includes("-")) tags.push(...stdinProgramTags(args, rt, interpreter));
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
