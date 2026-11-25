// B1 (contain by environment): the user's credentials belong to the runner, not to the code it runs for the agent. Every process that runs
// worker-authored code or worker commands (the worker and verifier conversations' bash, the ticket `done` command, the `check` tool's suite, the PR loop's
// final-check suite) gets `containedEnv`: no token, no key, no ssh agent, a logged-out `gh`, no credential helper, no prompts, no git hooks.
// Only the PR loop's own `git push` / `ls-remote` / `gh pr *` calls keep the real environment.
//
// This is a barrier against the credentials in the *environment and the usual helpers*. It does not stop a script that reads a key file on disk
// (`~/.ssh/id_ed25519` with no passphrase, a token in a dotfile): see runner/README.md "What containment cannot stop".
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Variables that are removed whatever their name looks like. */
export const CREDENTIAL_VARS: readonly string[] = [
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
	"SSH_AUTH_SOCK",
	"SSH_AGENT_PID",
	"ANTHROPIC_API_KEY",
	"GIT_SSH",
];

/** Any variable whose name says it holds a secret. */
export const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|APIKEY|CREDENTIAL|PRIVATE_KEY)/i;

const DISABLED_PROMPT = "/usr/bin/false";

/** git config entries forced through `GIT_CONFIG_COUNT`: an empty `credential.helper` resets the helper list, and no hook or fsmonitor program runs. */
export const CONTAINED_GIT_CONFIG: ReadonlyArray<readonly [string, string]> = [
	["credential.helper", ""],
	["core.hooksPath", "/dev/null"],
	["core.fsmonitor", "false"],
];

/** `GIT_CONFIG_COUNT`/`KEY_n`/`VALUE_n` of `base`, with `pairs` appended after the entries it already has. */
function withGitConfig(base: NodeJS.ProcessEnv, pairs: ReadonlyArray<readonly [string, string]>): NodeJS.ProcessEnv {
	const had = Number.parseInt(base.GIT_CONFIG_COUNT ?? "", 10);
	const start = Number.isInteger(had) && had > 0 ? had : 0;
	const out: NodeJS.ProcessEnv = { GIT_CONFIG_COUNT: String(start + pairs.length) };
	pairs.forEach(([key, value], index) => {
		out[`GIT_CONFIG_KEY_${start + index}`] = key;
		out[`GIT_CONFIG_VALUE_${start + index}`] = value;
	});
	return out;
}

/**
 * The environment of a process that runs the agent's code. A removed variable is present with the value `undefined`: the result is
 * spread over `process.env` by the Node execution environment, and Node's `spawn` skips undefined values, so the variable is gone in the child.
 * `scratch` is an existing directory of the runner's own; `<scratch>/gh` is the (empty) `gh` config directory, so `gh` is logged out.
 * `GIT_CONFIG_GLOBAL` is left alone: `user.name` and `user.email` keep working.
 */
export function containedEnv(base: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...base };
	for (const name of Object.keys(env)) if (SECRET_NAME.test(name)) env[name] = undefined;
	for (const name of CREDENTIAL_VARS) env[name] = undefined;
	return {
		...env,
		GH_CONFIG_DIR: join(scratch, "gh"),
		GH_PROMPT_DISABLED: "1",
		GIT_TERMINAL_PROMPT: "0",
		GIT_ASKPASS: DISABLED_PROMPT,
		SSH_ASKPASS: DISABLED_PROMPT,
		GCM_INTERACTIVE: "never",
		GIT_CONFIG_NOSYSTEM: "1",
		GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o IdentitiesOnly=yes -o IdentityFile=/dev/null -o IdentityAgent=none",
		...withGitConfig(base, CONTAINED_GIT_CONFIG),
	};
}

/** For code that runs without a runner's scratch directory (a tool used on its own): contained over the current environment, with a `gh` dir that does not exist. */
export const defaultContainedEnv = (): NodeJS.ProcessEnv => containedEnv(process.env, join(tmpdir(), "brigadev-contain-default"));

/**
 * For the runner process itself (called once, at the script's entry): its own git calls (the guard's branch facts, the check tool's tree hash) read
 * the repository's config, which the agent may have edited. No fsmonitor or hook program of that config may run, with the runner's credentials in reach.
 */
export function hardenGitEnv(env: NodeJS.ProcessEnv): void {
	Object.assign(
		env,
		withGitConfig(env, [
			["core.hooksPath", "/dev/null"],
			["core.fsmonitor", "false"],
		]),
	);
}

/** The runner's private scratch directory (one per runner process) and the contained environment over it. */
export interface Containment {
	scratch: string;
	env: NodeJS.ProcessEnv;
	/** Remove the scratch directory; idempotent. */
	dispose(): void;
}

/** Create `<tmp>/brigadev-contain-XXXX/gh` and the environment over it. With `create: false` (a read-only open) nothing is created. */
export function createContainment(base: NodeJS.ProcessEnv, options: { create?: boolean } = {}): Containment {
	const create = options.create ?? true;
	const scratch = create ? mkdtempSync(join(tmpdir(), "brigadev-contain-")) : join(tmpdir(), "brigadev-contain-unused");
	if (create) mkdirSync(join(scratch, "gh"), { recursive: true });
	return {
		scratch,
		env: containedEnv(base, scratch),
		dispose: () => {
			if (create) rmSync(scratch, { recursive: true, force: true });
		},
	};
}
