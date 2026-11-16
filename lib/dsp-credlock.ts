// DSP credential lock (S10, user decisions L5 and L6). In DSP every shell command the parent session runs (`bash`, `bg_start`)
// starts without the user's push credentials, unless that exact call was approved in the S5 remote dialog.
//
// The lock depends on NO file or directory the agent's processes can write (round 3 found a race on a lock script in a writable
// temp dir). It is made of two things that need no disk: a static prelude put in front of each `bash` command (a shell line that
// unsets and exports), and the same values handed to `bg_start` through its spawn environment. Everything it points at is a place
// nobody can write: `/dev/null`, the system `false`, and an empty system folder (or a path that cannot be created).
// No Pi imports; the only file-system reads are the two probes in `lockPlaces`.
//
// What the lock takes away (the README lists what it does not cover):
//   - the ssh agent (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`) and every variable whose name looks like a secret (LOCKED_NAME);
//   - gh (`GH_CONFIG_DIR` -> a path nobody can create, so gh is not logged in), git credential helpers (reset through
//     GIT_CONFIG_COUNT, which also covers the macOS keychain helper of the system config), git's ssh identities
//     (`core.sshCommand`, GIT_SSH_COMMAND), askpass programs (the system `false`);
//   - npm (`NPM_CONFIG_USERCONFIG` -> /dev/null), docker (`DOCKER_CONFIG` -> the same unreachable path: no auths, no credential
//     helpers, and also no plugins or contexts of the user's config), AWS (`AWS_SHARED_CREDENTIALS_FILE` -> /dev/null).
// HOME is unchanged: plain fetches of public remotes and installs from public registries keep working.

import { accessSync, constants, existsSync, statSync } from "node:fs";

/**
 * Names that look like secrets. A word has to stand between underscores or at an edge of the name, so `TOKENIZERS_PARALLELISM`
 * (TOKEN followed by IZERS), `AUTHOR_NAME` (AUTH followed by OR), `PASSWORDLESS`, `SECRETS_DIR` and `PATH` stay, while
 * `GH_TOKEN`, `NPM_TOKEN`, `TWINE_PASSWORD`, `AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN_FILE` and a bare `AUTH` go. Case-insensitive.
 */
export const LOCKED_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY(_ID)?|SECRET_ACCESS_KEY|SESSION_TOKEN|PRIVATE_KEY|CREDENTIALS?|AUTH)($|_)/i;

/** Removed whatever their spelling (the second is not matched by the pattern). */
export const AGENT_VARIABLES = ["SSH_AUTH_SOCK", "SSH_AGENT_PID"];

/** Variables the lock assigns; a copy of one in another letter case (`npm_config_userconfig`) is dropped too. */
export const OVERRIDDEN_VARIABLES = ["GH_CONFIG_DIR", "GIT_TERMINAL_PROMPT", "GCM_INTERACTIVE", "GIT_ASKPASS", "SSH_ASKPASS", "AWS_SHARED_CREDENTIALS_FILE", "NPM_CONFIG_USERCONFIG", "DOCKER_CONFIG", "GIT_SSH_COMMAND"];

/** ssh without the agent, identity files, or prompts. Set as `core.sshCommand` and as GIT_SSH_COMMAND (which would win over it). */
export const SSH_LOCKED_COMMAND = "ssh -F /dev/null -o IdentityAgent=none -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o BatchMode=yes";

export function isLockedVariable(name: string): boolean {
	return AGENT_VARIABLES.includes(name.toUpperCase()) || LOCKED_NAME.test(name);
}

// ── the places the lock points at ───────────────────────────────────────────────────────────────────────────

/** Where the lock points gh and docker (a config dir that does not exist and cannot be created) and git/ssh askpass (a program that fails). */
export interface LockPlaces {
	configDir: string;
	deny: string;
}

/** The two probes `lockPlaces` makes; tests replace them. */
export interface PlaceProbe {
	/** True when `path` is a directory this process cannot write to. */
	readOnlyDirectory(path: string): boolean;
	exists(path: string): boolean;
}

const fileProbe: PlaceProbe = {
	readOnlyDirectory(path) {
		try {
			if (!statSync(path).isDirectory()) return false;
			accessSync(path, constants.W_OK);
			return false;
		} catch {
			return existsSync(path);
		}
	},
	exists: existsSync,
};

/**
 * The config dir is `/var/empty/brigadev` when `/var/empty` is a read-only directory (macOS, BSD, many Linux): gh and docker find no
 * config file and no login, and nothing can create it. Otherwise it is `/dev/null/brigadev`, which cannot exist either (ENOTDIR);
 * gh refuses to start with it ("failed to read configuration"), docker warns, and both then have no credentials.
 * The askpass program is the system `false`, found once; an absolute path nobody can overwrite.
 */
export function lockPlaces(probe: PlaceProbe = fileProbe): LockPlaces {
	const configDir = probe.readOnlyDirectory("/var/empty") ? "/var/empty/brigadev" : "/dev/null/brigadev";
	const deny = ["/usr/bin/false", "/bin/false"].find((path) => probe.exists(path)) ?? "/usr/bin/false";
	return { configDir, deny };
}

// ── the environment ─────────────────────────────────────────────────────────────────────────────────────────

export interface LockedEnvironment {
	/** The environment to spawn with. */
	env: NodeJS.ProcessEnv;
	/** Names that were in the parent environment and are gone (not names that were replaced). */
	removed: string[];
	/** What the lock assigned. */
	set: Record<string, string>;
}

/** Startup files a non-interactive shell runs (bash: $BASH_ENV, sh/ksh: $ENV): removed so they cannot export tokens again. */
const STARTUP_VARIABLES = ["BASH_ENV", "ENV"];

/** `GIT_CONFIG_COUNT` as git reads it: a non-negative integer; anything else is dropped (git refuses to run with it). */
function configCount(value: string | undefined): number {
	return value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
}

/** The locked environment: the parent's without secrets, plus the overrides. Pure; the input is not changed. */
export function lockEnvironment(base: NodeJS.ProcessEnv, places: LockPlaces = lockPlaces()): LockedEnvironment {
	const count = configCount(base.GIT_CONFIG_COUNT);
	const set: Record<string, string> = {
		GH_CONFIG_DIR: places.configDir,
		DOCKER_CONFIG: places.configDir,
		NPM_CONFIG_USERCONFIG: "/dev/null",
		AWS_SHARED_CREDENTIALS_FILE: "/dev/null",
		GIT_ASKPASS: places.deny,
		SSH_ASKPASS: places.deny,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
		// zsh reads $ZDOTDIR/.zshenv even for `zsh -c`; pointing it at a place nobody can create keeps ~/.zshenv tokens out.
		ZDOTDIR: places.configDir,
		GIT_SSH_COMMAND: SSH_LOCKED_COMMAND,
		// Appended after the entries the parent has, so they win: an empty credential.helper resets every helper before it.
		GIT_CONFIG_COUNT: String(count + 2),
		[`GIT_CONFIG_KEY_${count}`]: "credential.helper",
		[`GIT_CONFIG_VALUE_${count}`]: "",
		[`GIT_CONFIG_KEY_${count + 1}`]: "core.sshCommand",
		[`GIT_CONFIG_VALUE_${count + 1}`]: SSH_LOCKED_COMMAND,
	};
	const env: NodeJS.ProcessEnv = {};
	const removed: string[] = [];
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || key in set) continue; // an assigned name is replaced, not removed
		if (isLockedVariable(key) || OVERRIDDEN_VARIABLES.includes(key.toUpperCase()) || STARTUP_VARIABLES.includes(key)) removed.push(key);
		else env[key] = value;
	}
	return { env: { ...env, ...set }, removed, set };
}

// ── shell prelude (the `bash` tool) ─────────────────────────────────────────────────────────────────────────

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Characters a shell leaves alone in a word (no quoting needed). */
const PLAIN_WORD = /^[A-Za-z0-9_@%+:,./-]*$/;

/** Quotes only when the shell would change the value. The empty string stays empty (`NAME=`). */
const shellWord = (value: string): string => (PLAIN_WORD.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`);

/**
 * One line that puts a running POSIX shell (sh, bash, zsh) into the locked environment: unset what was removed, export what was set.
 * Every step is chained with `&&` and the line ends with `|| exit 1`, so a command never runs half-locked. The guard puts it, then a
 * newline, before the command; it changes nothing a command can observe but the environment: the exit status is that of the command,
 * `$?` starts at 0, and stdin and the working directory are untouched. It is static text (computed once per session from the
 * parent environment) and no file is read or written. The long ssh command is written once; its two other uses refer to it.
 * Names a shell cannot unset (not identifiers) are left out; they only reach children through the bash tool's own spawn.
 */
export function lockPrelude(locked: LockedEnvironment): string {
	const names = locked.removed.filter((name) => SHELL_NAME.test(name));
	const { GIT_SSH_COMMAND: ssh, ...others } = locked.set;
	const assignments = Object.entries(others).map(([key, value]) => `${key}=${value === ssh ? `"$GIT_SSH_COMMAND"` : shellWord(value)}`);
	const steps = [...(names.length > 0 ? [`unset -v ${names.join(" ")}`] : []), `export GIT_SSH_COMMAND=${shellWord(ssh)}`, `export ${assignments.join(" ")}`];
	return `${steps.join("&&")} || exit 1`;
}

// ── per-call state shared by the guard and bg_start ─────────────────────────────────────────────────────────
// The guard decides in `tool_call`; `bg_start` (another extension) spawns later. State sits on globalThis under a
// registered symbol, so it is shared even when the two extensions load their own copy of this module.

export type LockApply = (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

interface Registry {
	calls: Map<string, LockApply>;
}

const REGISTRY = Symbol.for("brigadev.dsp-credlock");
const MAX_PENDING = 256;

function registry(): Registry {
	const holder = globalThis as unknown as Record<symbol, Registry | undefined>;
	return (holder[REGISTRY] ??= { calls: new Map() });
}

/** Marks a tool call as locked (`apply` turns the environment it would spawn with into the locked one), or clears the mark (`undefined`). */
export function markCredLock(toolCallId: string, apply: LockApply | undefined): void {
	const { calls } = registry();
	calls.delete(toolCallId);
	if (!apply) return;
	if (calls.size >= MAX_PENDING) calls.delete(calls.keys().next().value as string);
	calls.set(toolCallId, apply);
}

/** The lock the guard marked for this call, taken (a mark is used once). */
export function takeCredLock(toolCallId: string): LockApply | undefined {
	const { calls } = registry();
	const apply = calls.get(toolCallId);
	calls.delete(toolCallId);
	return apply;
}

export function clearCredLocks(): void {
	registry().calls.clear();
}

/** The lock keeps no private directory any more (nothing on disk for the agent to rewrite); kept so callers that ask get `undefined`. */
export function credLockDir(): undefined {
	return undefined;
}

/** The line `/brigadev:doctor` shows in DSP. */
export function credLockLine(): string {
	return "DSP credential lock: on — shell commands and background processes start without the SSH agent, gh/GitHub and registry tokens, git credential helpers and the npm/docker/AWS credentials (no file on disk: an inline prelude, read-only targets); only a remote call you approve in the dialog gets them. npm private-registry auth and docker plugins/contexts from your user config are not available in locked commands";
}
