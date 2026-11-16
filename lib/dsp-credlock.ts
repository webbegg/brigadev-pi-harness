// DSP credential lock (S10, user decision L5). In DSP every shell command the parent session runs (`bash`, `bg_start`)
// starts without the user's push credentials, unless that exact call was approved in the S5 remote dialog.
// The builder here is pure: given the parent environment, the home dir and a private dir, it returns the environment to
// spawn with and the files to create; `writeCredLock` is the only function that touches the disk. No Pi imports.
//
// What the lock takes away (the README lists what it does not cover):
//   - the ssh agent (`SSH_AUTH_SOCK`, `SSH_AGENT_PID`) and every variable whose name looks like a secret (LOCKED_NAME);
//   - gh (`GH_CONFIG_DIR` -> an empty dir), git credential helpers (reset through GIT_CONFIG_COUNT, which also covers
//     the macOS keychain helper of the system config), git's ssh identities (`core.sshCommand`), askpass programs;
//   - npm (`NPM_CONFIG_USERCONFIG` -> a copy of the user's npmrc without auth lines), docker (`DOCKER_CONFIG` -> a copy
//     of config.json without auths and credential helpers), AWS (`AWS_SHARED_CREDENTIALS_FILE` -> an empty file).
// HOME is unchanged: plain fetches of public remotes and installs from public registries keep working.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

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

export interface LockPaths {
	dir: string;
	gh: string;
	askpass: string;
	awsCredentials: string;
	npmrc: string;
	docker: string;
}

export function lockPaths(dir: string): LockPaths {
	return { dir, gh: join(dir, "gh"), askpass: join(dir, "askpass"), awsCredentials: join(dir, "aws-credentials"), npmrc: join(dir, "npmrc"), docker: join(dir, "docker") };
}

export interface LockedEnvironment {
	/** The environment to spawn with. */
	env: NodeJS.ProcessEnv;
	/** Names that were in the parent environment and are gone (not names that were replaced). */
	removed: string[];
	/** What the lock assigned. */
	set: Record<string, string>;
}

/** `GIT_CONFIG_COUNT` as git reads it: a non-negative integer; anything else is dropped (git refuses to run with it). */
function configCount(value: string | undefined): number {
	return value !== undefined && /^\d+$/.test(value) ? Number(value) : 0;
}

/** The locked environment: the parent's without secrets, plus the overrides. Pure; the input is not changed. */
export function lockEnvironment(base: NodeJS.ProcessEnv, dir: string): LockedEnvironment {
	const paths = lockPaths(dir);
	const count = configCount(base.GIT_CONFIG_COUNT);
	const set: Record<string, string> = {
		GH_CONFIG_DIR: paths.gh,
		GIT_TERMINAL_PROMPT: "0",
		GCM_INTERACTIVE: "never",
		GIT_ASKPASS: paths.askpass,
		SSH_ASKPASS: paths.askpass,
		AWS_SHARED_CREDENTIALS_FILE: paths.awsCredentials,
		NPM_CONFIG_USERCONFIG: paths.npmrc,
		DOCKER_CONFIG: paths.docker,
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
		if (isLockedVariable(key) || OVERRIDDEN_VARIABLES.includes(key.toUpperCase())) removed.push(key);
		else env[key] = value;
	}
	return { env: { ...env, ...set }, removed, set };
}

// ── sanitized copies ────────────────────────────────────────────────────────────────────────────────────────

const NPMRC_AUTH_KEYS = new Set(["_auth", "_authtoken", "_password", "username", "email", "certfile", "keyfile"]);
const URL_CREDENTIALS = /:\/\/[^/\s:@]+:[^@\s/]*@/;

/** An npmrc without auth lines: `_auth`, `_authToken`, `_password`, `username`, `email`, `certfile`, `keyfile` (also scoped to a registry, `//host/:_authToken`) and any value with `user:password@` in a URL. */
export function sanitizeNpmrc(text: string): string {
	return text
		.split("\n")
		.filter((line) => {
			const trimmed = line.trim();
			if (trimmed === "" || trimmed.startsWith("#") || trimmed.startsWith(";")) return true;
			const equals = trimmed.indexOf("=");
			const key = (equals < 0 ? trimmed : trimmed.slice(0, equals)).trim();
			if (NPMRC_AUTH_KEYS.has(key.slice(key.lastIndexOf(":") + 1).toLowerCase())) return false;
			return !(equals >= 0 && URL_CREDENTIALS.test(trimmed.slice(equals + 1)));
		})
		.join("\n");
}

/** A docker config.json without `auths`, `credsStore` and `credHelpers`; one that cannot be read becomes `{}`. */
export function sanitizeDockerConfig(text: string): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		parsed = undefined;
	}
	const config = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { ...(parsed as Record<string, unknown>) } : {};
	delete config.auths;
	delete config.credsStore;
	delete config.credHelpers;
	return `${JSON.stringify(config, null, 2)}\n`;
}

// ── the plan ────────────────────────────────────────────────────────────────────────────────────────────────

export interface LockFile {
	path: string;
	content: string;
	mode: number;
}

export interface CredLockPlan extends LockedEnvironment {
	dir: string;
	/** Directories to create (the private dir itself is created with mode 0700 too). */
	dirs: Array<{ path: string; mode: number }>;
	files: LockFile[];
	/** Symlinks into the user's docker dir, so plugins (buildx, compose) and contexts keep working. */
	links: Array<{ path: string; target: string }>;
}

export interface BuildInput {
	env: NodeJS.ProcessEnv;
	home: string;
	/** The private temp dir (created by the caller or by `writeCredLock`, mode 0700). */
	dir: string;
	/** Returns a file's text, or undefined when it cannot be read. Default: the file system. */
	readFile?: (path: string) => string | undefined;
	exists?: (path: string) => boolean;
}

const PRIVATE_DIR = 0o700;
const PRIVATE_FILE = 0o600;
/** The askpass program must be executable: the one file that is not 0600. */
const PRIVATE_PROGRAM = 0o700;
const askpassProgram = "#!/bin/sh\n# brigadev DSP credential lock: no credential is ever given.\nexit 1\n";

function readText(path: string): string | undefined {
	try {
		return readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
}

/** Value of an environment variable whatever the letter case of its name. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const key = Object.keys(env).find((candidate) => candidate.toUpperCase() === name);
	return key === undefined ? undefined : env[key];
}

/** The lock for one session: the environment to spawn with and the files to create. Pure (reads go through `readFile`). */
export function buildCredLock(input: BuildInput): CredLockPlan {
	const { env, home, dir } = input;
	const readFile = input.readFile ?? readText;
	const exists = input.exists ?? existsSync;
	const paths = lockPaths(dir);
	const locked = lockEnvironment(env, dir);

	const npmrcSource = envValue(env, "NPM_CONFIG_USERCONFIG") || join(home, ".npmrc");
	const dockerSource = envValue(env, "DOCKER_CONFIG") || join(home, ".docker");
	const links = ["cli-plugins", "contexts"].filter((name) => exists(join(dockerSource, name))).map((name) => ({ path: join(paths.docker, name), target: join(dockerSource, name) }));
	return {
		...locked,
		dir,
		dirs: [
			{ path: paths.gh, mode: PRIVATE_DIR },
			{ path: paths.docker, mode: PRIVATE_DIR },
		],
		files: [
			{ path: paths.awsCredentials, content: "", mode: PRIVATE_FILE },
			{ path: paths.askpass, content: askpassProgram, mode: PRIVATE_PROGRAM },
			{ path: paths.npmrc, content: sanitizeNpmrc(readFile(npmrcSource) ?? ""), mode: PRIVATE_FILE },
			{ path: join(paths.docker, "config.json"), content: sanitizeDockerConfig(readFile(join(dockerSource, "config.json")) ?? ""), mode: PRIVATE_FILE },
		],
		links,
	};
}

/** Creates the private dir (0700), its subdirectories (0700), files (0600, the askpass 0700) and links. Safe to run again. */
export function writeCredLock(plan: CredLockPlan): void {
	mkdirSync(plan.dir, { recursive: true, mode: PRIVATE_DIR });
	chmodSync(plan.dir, PRIVATE_DIR);
	for (const { path, mode } of plan.dirs) {
		mkdirSync(path, { recursive: true, mode });
		chmodSync(path, mode);
	}
	for (const { path, content, mode } of plan.files) {
		writeFileSync(path, content, { mode });
		chmodSync(path, mode);
	}
	for (const { path, target } of plan.links) {
		try {
			symlinkSync(target, path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
	}
}

// ── shell prelude (the `bash` tool) ─────────────────────────────────────────────────────────────────────────

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * One line that puts a running POSIX shell into the locked environment: unset what was removed, export what was set; if either
 * fails the shell exits, so a command never runs half-locked. It changes nothing a command can observe but the environment: the
 * exit status is that of the command that follows on the next line, `$?` starts at 0, and stdin and the working directory are untouched.
 * Names a shell cannot unset (not identifiers) are left out; they only reach children through the bash tool's own spawn.
 */
export function lockPrelude(locked: LockedEnvironment): string {
	const names = locked.removed.filter((name) => SHELL_NAME.test(name));
	const assignments = Object.entries(locked.set).map(([key, value]) => `${key}=${shellQuote(value)}`);
	return `${names.length > 0 ? `unset -v ${names.join(" ")}` : ":"} && export ${assignments.join(" ")} || exit 1`;
}

// The `bash` tool does not carry the prelude in the command text: the guard writes it to `lock.sh` in the private dir and the
// command only gets a short line that sources it. The guard rewrites the file before EVERY locked call, so an edit between two
// calls cannot weaken the next one.

export const lockScriptPath = (dir: string): string => join(dir, "lock.sh");

/**
 * The line put before the command: `. '<dir>/lock.sh' || exit 1`. If the file cannot be read or any line of it fails, the shell
 * exits and the command does not run. Sourcing keeps `$?` at 0, the working directory and stdin, and the exit status of the command.
 */
export function lockSourceLine(dir: string): string {
	return `. ${shellQuote(lockScriptPath(dir))} || exit 1`;
}

/**
 * Writes `lock.sh` (mode 0600) with the prelude for `env`. The old file is removed first, so a symlink or directory put in its
 * place is replaced and never written through. Throws when it cannot (the guard then blocks the call). Synchronous on purpose.
 */
export function writeLockScript(dir: string, env: NodeJS.ProcessEnv): void {
	const path = lockScriptPath(dir);
	rmSync(path, { recursive: true, force: true });
	writeFileSync(path, `${lockPrelude(lockEnvironment(env, dir))}\n`, { mode: PRIVATE_FILE, flag: "wx" });
	chmodSync(path, PRIVATE_FILE);
}

// ── per-call state shared by the guard, bg_start and the doctor ─────────────────────────────────────────────
// The guard decides in `tool_call`; `bg_start` (another extension) spawns later. State sits on globalThis under a
// registered symbol, so it is shared even when the two extensions load their own copy of this module.

export type LockApply = (env: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;

interface Registry {
	calls: Map<string, LockApply>;
	dir?: string;
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

/** The session's private lock dir (set by the guard when it creates it, cleared at shutdown). */
export function setCredLockDir(dir: string | undefined): void {
	registry().dir = dir;
}

export function credLockDir(): string | undefined {
	return registry().dir;
}

/** The line `/brigadev:doctor` shows in DSP. */
export function credLockLine(dir: string | undefined = credLockDir()): string {
	return `DSP credential lock: on — shell commands and background processes start without the SSH agent, gh/GitHub and registry tokens, git credential helpers and the npm/docker/AWS credentials; only a remote call you approve in the dialog gets them (${dir ? `private dir ${dir}` : "private dir is created at the first command"})`;
}
