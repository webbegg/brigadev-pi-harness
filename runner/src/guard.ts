// S5: the worker obeys the brigadev guard rules. One `beforeTool` hook on pi-durable's ToolTask decides every call of a worker
// conversation (also a nested call: `call.parent`) with the Pi-free rules in ../../lib, the same ones extensions/guard.ts applies
// to a subagent. The extension is Pi-bound and is not imported; its decisions are reused through lib/guard-rules.ts,
// lib/command-classifier.ts, lib/commit-branch.ts, lib/evidence.ts, and lib/check.ts.
//
// How the runner's worker differs from the extension's child (all deliberate; see runner/README.md):
// - It must commit, so bash is decided like the *parent* (`isChild: false`: commits on a feature branch pass, mode from brigadev.json),
//   while file tools are decided like a *child* (`isChild: true`: nothing outside the worktree, secrets blocked, never asked).
// - A commit passes the evidence commit gate (extension: parent only); the worker cannot force it.
// - The branch rule holds in every mode (extension: normal mode only).
// - There is no human to answer a "confirm" during a run (Q6): it is denied as `needs you: <reason>`. The route to approval is a decision: the
//   worker calls `ask_user_choice` with `command` set, the ticket parks, and an approving answer lifts the denial of that exact command string
//   once in the ticket's rerun (src/decision.ts `commandApproved`). Nothing else is lifted: never-allowed commands, delivery, the commit gate,
//   the branch rule, and file rules stay as they are.
// - Push, merge, publish, and gh pr/release/api writes are always blocked: the runner owns PR delivery.
// - B1/B3: the credentials are contained by the environment (src/contain.ts) and checked after the fact (src/integrity.ts); this file's string rules and
//   src/containment-rules.ts are the first layer, best effort: they read commands, not the scripts a command runs.
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import type { ToolHookCall } from "@earendil-works/pi-durable";
import { extractWriteTargets } from "../../lib/bash-writes.ts";
import { basename, blankHeredocs, classifyCommand, COMMAND_KIND, SHELLS, tokenize, unwrap } from "../../lib/command-classifier.ts";
import { checkRefusal, resolveCommand } from "../../lib/check.ts";
import { onFeatureBranch, readBranchFacts, type BranchFacts } from "../../lib/commit-branch.ts";
import { evaluateCommitGate } from "../../lib/evidence.ts";
import { bashWritesEvidence, CHECK_TOOL, decideBashCommand, decideFileAccess, EVIDENCE_BLOCK, isProtectedPath, sensitiveWords, shellCallOf } from "../../lib/guard-rules.ts";
import { canonicalPath, expandHome, isInside } from "../../lib/paths.ts";
import { isPermissionMode, isSensitivePath, PERMISSION_MODE, type PermissionMode } from "../../lib/permission-policy.ts";
import { brigadevHome, isRepoDocsPath, repoDocsDir as docsDirOf } from "../../lib/repo-docs.ts";
import { agentDir, PACKAGE_ROOT, readSettings, type BrigadevSettings } from "../../lib/runtime.ts";
import type { ExecFn } from "../../lib/worktree-snapshot.ts";
import { containmentReason, readOnlyExtraReason } from "./containment-rules.ts";
import { ASK_TOOL, commandApproved } from "./decision.ts";
import { nodeExec } from "./exec.ts";
import { RoleDoc, VERIFY_ROLE, VERIFY_TOOLS } from "./verify.ts";

/** The agent name on evidence records the worker's `check` calls write. */
export const RUNNER_AGENT = "runner-worker";
/** Tools the worker may call; anything else is blocked. */
export const WORKER_TOOLS: readonly string[] = ["read", "write", "edit", "bash", CHECK_TOOL, ASK_TOOL];

export interface GuardOptions {
	/** The worktree root: the project root of every file rule, and where commands run. */
	cwd: string;
	exec?: ExecFn;
	/** Tool names the conversation may call, besides which nothing runs (default: the worker's tools; the verifier's when `readOnly`). Others still get the rules of their own kind. */
	tools?: readonly string[];
	/** The verify conversation's rules: no write or edit, no commit or git change, no bash write inside the worktree (see `readOnlyBashReason`). */
	readOnly?: boolean;
	/** The brigadev settings (permission mode, `check.test`); the runner passes the copy it read when it opened (pinned: a worker that rewrites brigadev.json changes nothing); default: `~/.pi/agent/brigadev.json`, re-read on every call. */
	settings?: () => BrigadevSettings;
}

/** The part of a hook call the rules read. */
export type GuardCall = Pick<ToolHookCall, "name" | "arguments"> & { parent?: unknown };

/**
 * A confirmation the extension would ask the user for. The runner has no one to ask during a run, so it is denied (Q6).
 * `approvable` (a bash command, the one case an answer can lift) adds how to get it approved: a decision with `command` set.
 */
export const needsYou = (reason: string, approvable = false): string =>
	approvable
		? `needs you: ${reason}. The runner cannot ask during a run: do not retry this command; take another approach. If the ticket cannot be done without it, call \`ask_user_choice\` with \`command\` set to this exact command and an option whose label starts with "Approve": the ticket parks until the user answers, and an approved command runs once when the ticket reruns.`
		: `needs you: ${reason}. The runner cannot ask during a run: do not retry this command; take another approach, or stop and say what you need.`;

const DELIVERY_BLOCK = (what: string): string =>
	`Blocked by brigadev runner: the runner owns PR delivery (${what}). The worker never pushes, merges, publishes, or runs gh pr/release commands; commit on the branch and stop.`;

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

// ---------------------------------------------------------------------------------------------------------------------
// Delivery: what the runner owns

/** The git subcommand, skipping global options such as `-C <dir>` (the classifier's own helper is private). */
function gitSubcommand(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-C" || arg === "-c" || arg === "--git-dir" || arg === "--work-tree" || arg === "--namespace") {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

/** The gh command group (`pr`, `release`, ...), skipping `-R <repo>`. */
function ghGroup(args: string[]): string | undefined {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "-R" || arg === "--repo" || arg === "--hostname") {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return arg;
	}
	return undefined;
}

/** `git merge` and any `gh pr` / `gh release` command, also inside `bash -c '…'` and `eval`. The classifier has no rule for these. */
function textualDelivery(command: string, depth = 0): string | undefined {
	for (const segment of tokenize(blankHeredocs(command))) {
		const { argv } = unwrap(segment.argv);
		if (argv.length === 0) continue;
		const name = basename(argv[0]);
		const args = argv.slice(1);
		if (name === "git") {
			const sub = gitSubcommand(args);
			if (sub === "push" || sub === "merge" || sub === "pull") return `git ${sub}`;
		}
		if (name === "gh") {
			const group = ghGroup(args);
			if (group === "pr" || group === "release") return `gh ${group}`;
		}
		if ((SHELLS.has(name) || name === "eval") && depth < 4) {
			const flag = name === "eval" ? 0 : args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			const script = name === "eval" ? args.join(" ") : flag >= 0 ? args[flag + 1] : undefined;
			const nested = script === undefined ? undefined : textualDelivery(script, depth + 1);
			if (nested) return nested;
		}
	}
	return undefined;
}

/** Why the runner, not the worker, delivers this command (push, merge, publish, PR/release/issue writes), or undefined. */
export function deliveryReason(command: string): string | undefined {
	for (const match of classifyCommand(command)) {
		if (match.kind === COMMAND_KIND.PUBLISH) return match.reason;
		if (match.kind === COMMAND_KIND.DELIVERY && !match.commit) return match.reason;
		if (match.kind === COMMAND_KIND.DESTRUCTIVE && /^git push\b/.test(match.reason)) return match.reason;
	}
	return textualDelivery(command);
}

// ---------------------------------------------------------------------------------------------------------------------
// A commit stands alone

/** git subcommands that may share a bash call with a commit: none of them changes a file in the working tree. */
const COMMIT_COMPANIONS = new Set(["add", "commit", "status", "diff", "log", "show", "rev-parse"]);

export const COMMIT_ALONE_BLOCK =
	"Blocked by brigadev runner: a commit runs in its own bash call (only `git add`, `git status`, `git diff`, and `git commit` may share it, with no output redirection). The evidence gate reads the working tree before the command runs, so a write in the same call would be committed untested. Make the change, run `check`, then commit.";

/** Every segment of a command, with the scripts of `bash -c '…'` and `eval` expanded in place of their shell segment. */
function flatSegments(command: string, depth = 0): Array<{ argv: string[]; redirects: number } | { opaque: string }> {
	const out: Array<{ argv: string[]; redirects: number } | { opaque: string }> = [];
	for (const segment of tokenize(blankHeredocs(command), { redirections: true })) {
		const { argv } = unwrap(segment.argv);
		if (argv.length === 0) continue;
		const name = basename(argv[0]);
		if (SHELLS.has(name) || name === "eval") {
			const args = argv.slice(1);
			const flag = name === "eval" ? 0 : args.findIndex((arg) => /^-[a-z]*c[a-z]*$/.test(arg));
			const script = name === "eval" ? args.join(" ") : flag >= 0 ? args[flag + 1] : undefined;
			if (script === undefined || depth >= 4) out.push({ opaque: name });
			else out.push(...flatSegments(script, depth + 1));
			if (segment.redirects.length > 0) out.push({ opaque: `${name} redirect` });
			continue;
		}
		out.push({ argv, redirects: segment.redirects.length });
	}
	return out;
}

/** Why a bash call that commits must be split, or undefined (no commit, or only git companions without redirection). */
export function commitAloneReason(command: string): string | undefined {
	if (!classifyCommand(command).some((match) => match.commit)) return undefined;
	const companion = (segment: ReturnType<typeof flatSegments>[number]): boolean => {
		if ("opaque" in segment || segment.redirects > 0) return false;
		// `cd` writes nothing; where it leads is the branch and gate rules' business (a commit elsewhere is refused there).
		if (segment.argv[0] === "cd") return true;
		if (basename(segment.argv[0]) !== "git") return false;
		const sub = gitSubcommand(segment.argv.slice(1));
		return sub !== undefined && COMMIT_COMPANIONS.has(sub);
	};
	return flatSegments(command).every(companion) ? undefined : COMMIT_ALONE_BLOCK;
}

// ---------------------------------------------------------------------------------------------------------------------
// The verifier is read-only

/** git subcommands a read-only run may use: none changes the repository (no stash, worktree, checkout, branch, config, remote, fetch, push). */
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse", "rev-list", "ls-files", "ls-tree", "blame", "grep", "cat-file", "describe", "merge-base", "shortlog", "name-rev", "diff-tree", "show-ref", "for-each-ref"]);

const READ_ONLY_BLOCK = (what: string): string =>
	`Blocked by brigadev guard: the verifier is read-only (${what}). It never edits, commits, or changes git state; run probes in a scratch copy outside the worktree.`;

/** Why a read-only conversation may not run this bash command, or undefined: a commit, a git command outside the read-only set, or a literal write inside the worktree. Best effort for bash, as in the extension. */
export function readOnlyBashReason(command: string, root: string): string | undefined {
	if (classifyCommand(command).some((match) => match.commit)) return READ_ONLY_BLOCK("git commit");
	for (const segment of flatSegments(command)) {
		if ("opaque" in segment) return READ_ONLY_BLOCK(`${segment.opaque} cannot be inspected`);
		if (basename(segment.argv[0]) !== "git") continue;
		const sub = gitSubcommand(segment.argv.slice(1));
		if (sub === undefined || !READ_ONLY_GIT.has(sub)) return READ_ONLY_BLOCK(`git ${sub ?? "…"} may change the repository`);
	}
	for (const target of extractWriteTargets(command, root)) {
		const absolute = canonicalPath(target);
		if (isInside(root, absolute)) return READ_ONLY_BLOCK(`it writes ${relative(root, absolute) || "."} inside the worktree`);
	}
	// A git flag that writes or runs a program (`--output`, `--ext-diff`, `--textconv`), or an interpreter with inline code.
	return readOnlyExtraReason(command);
}

// ---------------------------------------------------------------------------------------------------------------------

/** The rules, as one function of a tool call. `decide` returns the reason to block the call, or undefined to let it run. */
export function createGuard(options: GuardOptions) {
	const root = canonicalPath(options.cwd);
	const exec = options.exec ?? nodeExec;
	const settings = options.settings ?? readSettings;
	const readOnly = options.readOnly ?? false;
	const tools = options.tools ?? (readOnly ? VERIFY_TOOLS : WORKER_TOOLS);

	// The docs folder of the worktree's repo costs a git call: ask once per brigadev home (the repo name does not change during a run).
	let docs: { home: string; dir: string } | undefined;
	const repoDocsDir = (_cwd: string): string => {
		const home = brigadevHome();
		if (docs?.home !== home) docs = { home, dir: docsDirOf(root) };
		return docs.dir;
	};

	/** The permission mode from brigadev.json; an unknown stored mode is normal, as in the extension. */
	const mode = (): PermissionMode => {
		const saved = settings().defaultMode;
		return isPermissionMode(saved) ? saved : PERMISSION_MODE.NORMAL;
	};

	const decideFile = (toolName: string, rawPath: string): string | undefined => {
		const isWrite = toolName !== "read";
		const absolute = canonicalPath(resolve(root, expandHome(rawPath)));
		const decision = decideFileAccess({
			isChild: true,
			isWrite,
			rawPath,
			absolutePath: absolute,
			projectRoot: root,
			docsDir: () => repoDocsDir(root),
			sensitive: isSensitivePath(absolute),
			surfaces: undefined,
			readOnly,
			agent: RUNNER_AGENT,
		});
		if (decision.action === "block") return decision.reason;
		if (decision.action === "ask") return needsYou(`${toolName} ${rawPath} needs a confirmation`);
		if (!isWrite) return undefined;
		// Beyond the extension's child rules: a path inside the worktree can still be code that runs later (git hooks and config) or
		// credentials; and the feature document and the evidence belong to the runner, wherever the docs folder is.
		if (isProtectedPath(absolute, { home: homedir(), agentDir: agentDir(), installRoot: PACKAGE_ROOT, projectRoot: root })) {
			return `Blocked by brigadev guard: ${rawPath} is a protected path (git config and hooks, agent settings, credentials); the worker never writes it.`;
		}
		if (isRepoDocsPath(repoDocsDir(root), absolute)) return `Blocked by brigadev guard: ${rawPath} is in the repo's harness documents (feature document, reviews, evidence), which the runner owns.`;
		return undefined;
	};

	/** The branch facts of the worktree, read once per decision (several rules need them). */
	const branchFactsOnce = (): (() => Promise<BranchFacts>) => {
		let read: Promise<BranchFacts> | undefined;
		return () => (read ??= readBranchFacts(exec, root).catch((): BranchFacts => ({ currentBranch: null, defaultBranch: null, protectedBranches: [] })));
	};

	/**
	 * Every rule that applies to a shell command string: evidence log, delivery, the branch rule, the permission policy, the commit gate.
	 * `approved` says whether the user approved exactly this command for this call: it lifts only the permission policy's confirmation.
	 */
	const decideShell = async (command: string, approved?: (command: string) => Promise<boolean>): Promise<string | undefined> => {
		const branchFacts = branchFactsOnce();
		if (readOnly) {
			const reason = readOnlyBashReason(command, root);
			if (reason) return reason;
		}
		// Nobody forges a recorded test result: the evidence log is written only by the recorder.
		if (command.includes("evidence") && bashWritesEvidence(command, [join(repoDocsDir(root), "evidence")])) return EVIDENCE_BLOCK;

		const delivery = deliveryReason(command);
		if (delivery) return DELIVERY_BLOCK(delivery);

		// B1/B3, the first layer (best effort; the barrier is the contained environment and the integrity check): git config and plumbing, gh api writes in any
		// spelling, credential variables and stores, a shell fed a heredoc. The worker and the verifier alike. (The verifier's own rules ran first.)
		const contained = containmentReason(command);
		if (contained) return contained;

		const alone = commitAloneReason(command);
		if (alone) return alone;

		if (classifyCommand(command).some((match) => match.commit)) {
			// The branch rule in every mode: the extension waives its question on a feature branch in normal mode only; yolo would skip it.
			const facts = await branchFacts();
			if (!onFeatureBranch(facts)) return needsYou(`git commit is only allowed on a feature branch (HEAD is ${facts.currentBranch ? `on ${facts.currentBranch}, a default or protected branch` : "detached or unknown"})`);
		}

		// `isChild: false`: the worker must be able to commit; the file rules above are the child's.
		const decision = await decideBashCommand({ command, mode: mode(), isChild: false, cwd: root, readFacts: (dir) => (dir === root ? branchFacts() : readBranchFacts(exec, dir)) });
		if (decision.action === "block") return decision.reason;
		if (decision.action === "confirm" && !(approved && (await approved(command)))) return needsYou(decision.reason, true);

		const gate = await evaluateCommitGate({ exec, command, cwd: root, forcedTree: undefined });
		if (gate?.decision.action === "block") return gate.decision.reason;
		return undefined;
	};

	/** `check` runs a command through `bash -c`: it is decided as a bash call of the command that will run. */
	const decideCheck = async (args: Record<string, unknown>): Promise<string | undefined> => {
		const choice = resolveCommand({
			command: typeof args.command === "string" ? args.command : undefined,
			focus: typeof args.focus === "string" ? args.focus : undefined,
			cwd: root,
			settings: settings(),
		});
		if (!("command" in choice)) return undefined; // no command resolves: the tool itself answers with an error
		const refusal = checkRefusal(choice.command);
		if (refusal) return `Blocked by brigadev guard: ${refusal}`;
		for (const { word } of sensitiveWords(choice.command, root)) return `Blocked by brigadev guard: ${word} may hold secrets; subagents never read or write it.`;
		return decideShell(choice.command);
	};

	return {
		/** `approved`: whether the user approved exactly this bash command for this call (default: never); see `commandApproved`. */
		async decide(call: GuardCall, approved?: (command: string) => Promise<boolean>): Promise<string | undefined> {
			const args = asRecord(call.arguments);
			if (!tools.includes(call.name)) return `Blocked by brigadev guard: unknown tool ${call.name}; the runner's worker has ${tools.join(", ")}.`;
			if (call.name === CHECK_TOOL) return decideCheck(args);
			if (call.name === "bash") return decideShell(shellCallOf("bash", args)?.command ?? "", approved);
			// read, write, edit: a call without a path decides nothing, as in the extension. (A test tool outside these has no rule here.)
			if (call.name !== "read" && call.name !== "write" && call.name !== "edit") return undefined;
			const rawPath = String(args.path ?? "");
			return rawPath ? decideFile(call.name, rawPath) : undefined;
		},
	};
}

/** The pi-durable extension: the guard as a `beforeTool` hook on every tool call of the conversations that select it. A throw would block too; a failure here blocks with its reason. */
export function guardExtension(options: GuardOptions) {
	const guard = createGuard(options);
	// A conversation whose `RoleDoc` says verify is decided by the read-only rules instead.
	const verifier = createGuard({ ...options, tools: undefined, readOnly: true });
	return defineExtension({
		name: "brigadev-guard",
		hooks: [
			hook(ToolTask, {
				beforeTool: async (call, api, context) => {
					try {
						// A role that cannot be read fails closed: the call must pass both rule sets.
						const role = await (async () => (await api.snapshot(RoleDoc, api.conversationId, context))?.role ?? "")().catch(() => undefined);
						const workerReason = role === VERIFY_ROLE ? undefined : await guard.decide(call, (command) => commandApproved(api, call, command, context));
						const reason = workerReason ?? (role === VERIFY_ROLE || role === undefined ? await verifier.decide(call) : undefined);
						return reason === undefined ? undefined : { block: reason };
					} catch (error) {
						return { block: `Blocked by brigadev guard: could not decide (${error instanceof Error ? error.message : String(error)})` };
					}
				},
			}),
		],
	});
}
