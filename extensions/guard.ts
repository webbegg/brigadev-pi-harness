/**
 * brigadev guard: destructive-command confirmation, permission modes,
 * project-root boundary, secret-file protection, and allowed-edit-surface
 * enforcement for subagents.
 *
 * Subagents load this file explicitly (`-e`), so it must work standalone.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { writesOutsideSurfaces } from "../lib/bash-writes.ts";
import { BUS, publish, type GuardDecision, type ModeState } from "../lib/bus.ts";
import { classifyCommand, COMMAND_KIND, type CommandMatch } from "../lib/command-classifier.ts";
import { onFeatureBranch, readBranchFacts } from "../lib/commit-branch.ts";
import { branchSlug, evidenceFile, readEvidence } from "../lib/evidence.ts";
import { checkRefusal, resolveCommand } from "../lib/check.ts";
import { askPermission } from "../lib/human-prompt.ts";
import { showPermissionCard, type CardHost } from "../lib/permission-card.ts";
import { actionsOf, commandDialog, grantable, outsideWriteDialog, sensitiveFileDialog, toolDialog, whyNote, type PermissionDialog } from "../lib/permission-dialog.ts";
import { classifyMcpTool, mcpInputPreview } from "../lib/mcp-tools.ts";
import { bashWritesEvidence, CHECK_TOOL, decideBashCommand, decideFileAccess, EVIDENCE_BLOCK, hideSensitiveResults, isProtectedPath, runYoloDirCommand, secureYoloDirs, sensitiveWords, shellCallOf, tempRoots, trustedTempRoots, type PathVerdict } from "../lib/guard-rules.ts";
import { decideCommand, isPermissionMode, isSensitivePath, MODE_PROMPT, PERMISSION_MODE, type PermissionMode } from "../lib/permission-policy.ts";
import { canonicalPath, expandHome, isInside } from "../lib/paths.ts";
import { decidePrGate, opensPrCreate, PR_FACTS_ERROR_REASON, prCreateDirectory, prGateBlockMessage, prGateDialogText, riskMapFor, UNRESOLVED_DIRECTORY_REASON, type PrGateDecision } from "../lib/pr-gate.ts";
import { brigadevHome, repoDocsDir } from "../lib/repo-docs.ts";
import { redact } from "../lib/redact.ts";
import { branchRisk, type RiskCategory } from "../lib/risk-map.ts";
import { agentDir, CHILD_ENV, childAllowedSurfaces, isChildSession, PACKAGE_ROOT, readSettings, writeSettings } from "../lib/runtime.ts";
import { diffSnapshots, outsideSurfaces, takeSnapshot, type ExecFn, type Snapshot } from "../lib/worktree-snapshot.ts";
import { isDocPath, worktreeTreeResult } from "../lib/worktree-tree.ts";

const MODE_ENTRY = "brigadev-mode";
const STATUS_KEY = "brigadev-mode";
/** Custom message that tells the model the permission mode (not in the system prompt, so a switch never changes it). */
const MODE_NOTICE = "brigadev-mode-notice";
/** Tools that search under a `path` argument; the guard decides that path like a read. */
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);

/**
 * Node opens an unauthenticated inspector on 127.0.0.1 when the process gets SIGUSR1 and has no listener for it. The agent's bash could then send it to Pi
 * (`kill -USR1 <pi pid>`) and run code inside Pi, past this guard. One listener per process (a reload loads this module again: the mark is on `process`).
 */
const NO_INSPECTOR = Symbol.for("brigadev.noInspectorOnSigusr1");
function keepInspectorClosed(): void {
	const host = process as NodeJS.Process & { [NO_INSPECTOR]?: boolean };
	if (process.platform === "win32" || host[NO_INSPECTOR]) return;
	host[NO_INSPECTOR] = true;
	process.on("SIGUSR1", () => {});
}

export default function (pi: ExtensionAPI) {
	keepInspectorClosed();
	const isChild = isChildSession();
	let mode: PermissionMode = PERMISSION_MODE.NORMAL;
	// Per-session grants for directories outside the project root.
	const outsideGrants = new Set<string>();
	// Actions ("open a pull request") the user said yes to for the rest of the session; only those `grantable` allows, memory only.
	const sessionGrants = new Set<string>();
	// The push URLs a "yes for this session" to a push covered, each with the fingerprint of the hooks and settings it ran with
	// (`pushCode`): a later push is covered only to one of them, running the same code.
	const pushGrants = new Set<string>();
	/**
	 * The grant that lets these matches run without asking, or undefined: each must be grantable, every action granted, and a push must go
	 * to a granted URL (`pushUrls`: where git says the command's pushes land; undefined when they may not be granted).
	 */
	const grantFor = (matches: readonly CommandMatch[], pushUrls: readonly string[] | undefined): string | undefined => {
		if (isChild || !grantable(matches)) return undefined;
		if (matches.some((match) => match.push) && (!pushUrls || !pushUrls.every((url) => pushGrants.has(url)))) return undefined;
		const actions = actionsOf(matches);
		if (!actions.every(({ action }) => sessionGrants.has(action))) return undefined;
		return `brigadev: allowed for this session (${actions.map(({ action }) => action).join(" + ")})`;
	};

	/**
	 * A fingerprint of the code a push from `cwd` to `remote` runs besides git: the `pre-push` and `reference-transaction` hooks (wherever
	 * `core.hooksPath` puts them; content and executable bit), hooks written in the config (`hook.*`), and the settings that name a program
	 * or change how git reaches the remote (`core.hooksPath`, `sshCommand`, `fsmonitor`, `askPass`, `gitProxy`, credential helpers, signing
	 * (`push.gpgSign`, `gpg.*`), `url.*`, `protocol.*`, the remote's `receivepack` and `vcs`). Undefined when it cannot be read.
	 * Only the hook files are read, not what they call (`npm test`, husky's own script).
	 */
	const pushCode = async (cwd: string, remote: string): Promise<string | undefined> => {
		const hash = createHash("sha256");
		for (const hook of ["pre-push", "reference-transaction"]) {
			const found = await exec("git", ["rev-parse", "--git-path", `hooks/${hook}`], { cwd, timeout: 10_000 }).catch(() => undefined);
			if (found?.code !== 0 || !found.stdout.trim()) return undefined;
			const file = resolve(cwd, found.stdout.trim());
			try {
				const executable = (statSync(file).mode & 0o111) !== 0;
				hash.update(`${hook}:${executable}:`).update(readFileSync(file)).update("\0");
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
				hash.update(`${hook}:none\0`);
			}
		}
		const keys = `^(core\\.(hookspath|sshcommand|fsmonitor|askpass|gitproxy)|credential\\..*helper|hook\\..*|push\\.gpgsign|gpg\\..*|url\\..*|protocol\\..*|remote\\.${remote.replace(/\./g, "\\.")}\\.(receivepack|vcs))$`;
		const settings = await exec("git", ["config", "--get-regexp", keys], { cwd, timeout: 10_000 }).catch(() => undefined);
		if (settings?.code !== 0 && settings?.code !== 1) return undefined;
		return hash.update(settings.code === 0 ? settings.stdout : "").digest("hex");
	};

	/**
	 * Where the command's plain pushes land, asked of git at `cwd`: for each one, the push URLs of its remote, each with the fingerprint of
	 * the code the push runs (`pushCode`), so a grant asks again when a hook or such a setting appears or changes. Undefined (no grant) unless
	 * HEAD is on a feature branch, each push sends that branch to the same name (no ref, `HEAD`, or its name), `push.default` is unset,
	 * `simple`, or `current`, and the remote has no `push` refspec or `mirror` setting. Any git failure is undefined. [] when nothing pushes.
	 */
	const pushDestinations = async (matches: readonly CommandMatch[], cwd: string): Promise<string[] | undefined> => {
		const pushes = matches.filter((match) => match.push);
		if (pushes.length === 0) return [];
		const facts = await readBranchFacts(exec, cwd).catch(() => undefined);
		if (!facts || !onFeatureBranch(facts) || !facts.currentBranch) return undefined;
		const branch = facts.currentBranch;
		/** A setting's value; "" when unset (exit 1); undefined when git fails. */
		const setting = async (...args: string[]): Promise<string | undefined> => {
			const result = await exec("git", ["config", ...args], { cwd, timeout: 10_000 }).catch(() => undefined);
			return result?.code === 0 ? result.stdout.trim() : result?.code === 1 ? "" : undefined;
		};
		const pushDefault = await setting("--get", "push.default");
		if (pushDefault === undefined || !["", "simple", "current"].includes(pushDefault)) return undefined;
		// A push that recurses into submodules also sends each one to the submodule's own remote, which nobody granted. git takes whichever
		// of the two settings it reads last, so each must keep the push out of submodules on its own.
		const recurse = await setting("--get", "push.recurseSubmodules");
		const recurseAll = await setting("--type=bool", "--get", "submodule.recurse");
		if (recurse === undefined || recurseAll === undefined || recurseAll === "true") return undefined;
		if (!["", "no", "false", "check"].includes(recurse.toLowerCase())) return undefined;
		const urls: string[] = [];
		for (const { push } of pushes) {
			if (!push || (push.ref !== undefined && push.ref !== "HEAD" && push.ref !== branch)) return undefined;
			let remote = push.remote;
			// git's default remote for a push: the branch's pushRemote, remote.pushDefault, the branch's remote, then origin.
			for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
				if (remote) break;
				const value = await setting("--get", key);
				if (value === undefined) return undefined;
				remote = value || undefined;
			}
			remote ??= "origin";
			if (!/^[A-Za-z0-9._-]+$/.test(remote)) return undefined;
			if ((await setting("--get-all", `remote.${remote}.push`)) !== "" || (await setting("--get", `remote.${remote}.mirror`)) !== "") return undefined;
			// git pushes to every push URL of the remote (several `pushurl`s, or several `url`s): each one must be granted.
			const found = await exec("git", ["remote", "get-url", "--push", "--all", remote], { cwd, timeout: 10_000 }).catch(() => undefined);
			const remoteUrls = found?.code === 0 ? found.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
			if (remoteUrls.length === 0) return undefined;
			// A remote on this machine (a path, `file://`) runs its own hooks and config during the push, which `pushCode` does not read; a
			// `<helper>::<address>` URL (`ext::`, `hg::`) runs a transport program.
			if (remoteUrls.some((url) => /^file:/i.test(url) || /^[A-Za-z0-9+.-]+::/.test(url) || !(/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[^/:]+:/.test(url)))) return undefined;
			const code = await pushCode(cwd, remote);
			if (code === undefined) return undefined;
			urls.push(...remoteUrls.map((url) => `${url}\0${code}`));
		}
		return urls;
	};

	const projectRoot = (ctx: ExtensionContext) => canonicalPath(process.env[CHILD_ENV.PROJECT_ROOT] ?? ctx.cwd);

	// Writers only: bash must not change files outside the allowed edit surfaces.
	const writerSurfaces = (): string[] | undefined => (isChild && process.env[CHILD_ENV.READ_ONLY] !== "1" ? childAllowedSurfaces() : undefined);
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	// Working-tree snapshot taken before each allowed bash call, by tool call id.
	const beforeBash = new Map<string, Snapshot>();

	// A secure-yolo folder must not reach the agent folder, every repo's docs (evidence logs), or the harness code.
	const secureGuard = () => ({ home: homedir(), agentDir: agentDir(), protectedDirs: [brigadevHome(), PACKAGE_ROOT] });
	/** The parent's secure-yolo folders from brigadev.json (re-read each call, so /brigadev:yolo-dir applies at once). */
	const secureDirs = (): string[] => secureYoloDirs(readSettings().secureYoloDirs, secureGuard());
	const tempDirs = (): string[] => trustedTempRoots(tempRoots(), homedir());

	// The mode the model was last told about: from the session's own messages on restore, then from each announcement.
	let announcedMode: PermissionMode | undefined;

	const publishStatus = (ctx: ExtensionContext) => {
		if (isChild || !ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, mode === PERMISSION_MODE.YOLO ? "🚀 brigadev: yolo" : "brigadev: normal");
	};

	/** A stored mode that is not normal or yolo (a mode this version no longer has) is ignored, so the session stays in normal mode. */
	const restoreMode = (ctx: ExtensionContext) => {
		const saved = readSettings().defaultMode;
		mode = isPermissionMode(saved) ? saved : PERMISSION_MODE.NORMAL;
		announcedMode = undefined;
		for (const entry of ctx.sessionManager.getBranch()) {
			// A compaction summarizes the notices before it away: only a notice after the latest compaction is still in the model's context.
			if (entry.type === "compaction") announcedMode = undefined;
			if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
				const value = (entry.data as { mode?: unknown } | undefined)?.mode;
				mode = isPermissionMode(value) ? value : PERMISSION_MODE.NORMAL;
			}
			if (entry.type === "custom_message" && entry.customType === MODE_NOTICE) {
				const value = (entry.details as { mode?: unknown } | undefined)?.mode;
				announcedMode = isPermissionMode(value) ? value : undefined;
			}
		}
		outsideGrants.clear();
		publishStatus(ctx);
		publishMode();
	};

	const setMode = (next: PermissionMode, ctx: ExtensionContext) => {
		mode = next;
		pi.appendEntry(MODE_ENTRY, { mode });
		publishStatus(ctx);
		publishMode();
	};

	/** The mode on the brigadev bus (a UI shows it); the parent only. */
	const publishMode = () => {
		if (!isChild) publish(pi.events, BUS.mode, { scope: "mode", mode } satisfies ModeState);
	};

	/** The tool call being judged, so a confirm and its outcome are published with the call's id. */
	interface Judging {
		event: { toolCallId: string; toolName: string; input: unknown };
		asked: boolean;
		/** Set when a session grant let the call run unasked: published, so the guard log shows what ran on it. */
		granted?: string;
	}
	const judging = new AsyncLocalStorage<Judging>();
	const announce = (current: Judging, action: GuardDecision["action"], reason?: string) => {
		const { toolCallId, toolName, input } = current.event;
		const fields = (input && typeof input === "object" ? input : {}) as { command?: unknown; path?: unknown };
		const subject = typeof fields.command === "string" ? fields.command : typeof fields.path === "string" ? fields.path : undefined;
		// What goes to the bus (and so the page) is redacted; the TUI dialog keeps the real command.
		publish(pi.events, BUS.guard, { id: randomUUID(), toolCallId, tool: toolName, ...(subject === undefined ? {} : { subject: redact(subject).slice(0, 500) }), action, ...(reason === undefined ? {} : { reason: redact(reason) }), at: Date.now() } satisfies GuardDecision);
	};

	/** Asks the user, in the TUI or from the web (first answer wins); without a UI (print mode, subagents) the answer is no. */
	/** `busReason`: what the guard bus records for the confirm (the classifier's terse reason); the dialog's plain title otherwise. */
	/** Marks the call being judged as allowed by a session grant. */
	const noteGrant = (reason: string) => {
		const current = judging.getStore();
		if (current) current.granted = reason;
	};

	/**
	 * The TUI shows the permission card (details behind `d`); an RPC client (T3 Code) gets Pi's dialogs with the short text.
	 * A "yes for this session" records the card's actions as granted. Returns whether the call may run.
	 */
	const confirm = async (ctx: ExtensionContext, dialog: PermissionDialog, busReason?: string, pushUrls: readonly string[] = []): Promise<boolean> => {
		if (isChild || !ctx.hasUI) return false;
		const current = judging.getStore();
		if (current) {
			current.asked = true;
			announce(current, "confirm", busReason ?? dialog.title);
		}
		const ui = ctx.ui as unknown as Partial<CardHost>;
		const show = ctx.mode === "tui" && typeof ui.custom === "function" ? (signal: AbortSignal) => showPermissionCard(ui as CardHost, dialog.title, dialog.card, signal) : undefined;
		const spec = { source: "guard", title: dialog.title, body: dialog.body, details: dialog.details, level: dialog.card.level, ...(dialog.sessionLabel ? { sessionLabel: dialog.sessionLabel } : {}) };
		// The run's abort signal (Esc, the web Abort) closes the dialog and the web prompt, so a late answer cannot resume an aborted call.
		const answer = await askPermission(pi.events, ctx, spec, ctx.signal, show);
		if (answer === "session" && dialog.card.sessionActions) {
			for (const action of dialog.card.sessionActions) sessionGrants.add(action);
			for (const url of pushUrls) pushGrants.add(url);
			ctx.ui.notify(`brigadev: won't ask again this session for: ${dialog.card.sessionActions.join(", ")}`, "info");
		}
		return answer !== "no";
	};

	/** Top of the repository that holds `dir` (canonical); `dir` itself when git cannot tell (not a repository, a failure). */
	const repoRoot = async (dir: string): Promise<string> => {
		const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 15_000 }).catch(() => undefined);
		return top?.code === 0 && top.stdout.trim() ? canonicalPath(top.stdout.trim()) : dir;
	};

	/**
	 * One file-access decision for a path a tool call touches (read, write, edit, the `path` of grep/find/ls, or the working directory a background
	 * process starts in): sensitive-path question, outside-project grant. Returns a block, or undefined to let it run.
	 * `isDirectory`: the path is a working directory, so a sensitive folder (`.ssh`) counts as sensitive and an outside
	 * directory is granted as itself, not as its parent (the folder of a file). `why`: the `# why:` note of a shell tool's command, for the dialog.
	 */
	const checkPath = async (toolName: string, rawPath: string, absolute: string, isWrite: boolean, ctx: ExtensionContext, isDirectory = false, why?: string): Promise<{ block: true; reason: string } | undefined> => {
		const root = projectRoot(ctx);
		// Protected paths (the agent folder, ~/.pi, the harness install, credential and shell startup files, git config and hooks) are never
		// trusted folder content, in any mode: a write there falls back to the outside-project question even under the temp dir or a secure folder.
		const protectedPath = isWrite && !isDirectory && isProtectedPath(absolute, { home: homedir(), agentDir: agentDir(), installRoot: PACKAGE_ROOT, projectRoot: root });
		const decision = decideFileAccess({
			isChild,
			isWrite,
			rawPath,
			absolutePath: absolute,
			projectRoot: root,
			docsDir: () => repoDocsDir(ctx.cwd),
			sensitive: isSensitivePath(absolute) || (isDirectory && isSensitivePath(`${absolute}/`)),
			readOnly: process.env[CHILD_ENV.READ_ONLY] === "1",
			surfaces: isChild ? childAllowedSurfaces() : undefined,
			agent: process.env[CHILD_ENV.AGENT],
			// The system temp dir and the secure-yolo folders: parent writes there run without asking (subagents stay blocked).
			trustedDirs: isChild || protectedPath ? undefined : [...tempDirs(), ...secureDirs()],
		});

		let verdict: PathVerdict;
		if (decision.action === "ask" && decision.kind === "sensitive") {
			const dialog = sensitiveFileDialog(toolName, rawPath, isWrite, why, isDirectory && toolName === "bg_start");
			const ok = await confirm(ctx, dialog, "brigadev: sensitive file");
			if (!ok) return { block: true, reason: `User declined access to sensitive file ${rawPath}` };
			verdict = decision.then;
		} else verdict = decision;

		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (verdict.action === "ask") {
			if ([...outsideGrants].some((granted) => isInside(granted, absolute))) return undefined;
			const target = isDirectory ? absolute : verdict.target;
			const dialog = outsideWriteDialog(toolName, absolute, root, target, why);
			const ok = await confirm(ctx, dialog, "brigadev: write outside project");
			if (!ok) return { block: true, reason: `User declined write outside the project root: ${absolute}` };
			outsideGrants.add(target);
		}
		return undefined;
	};

	/**
	 * PR gate for `gh pr create` (parent only, every permission mode, S9): a passing full-suite run on the committed HEAD, then
	 * the branch's tier against its evidence and review ledger. Undefined when the command opens no PR, outside git, or on a
	 * detached HEAD. It is the one gate in front of delivery, so a failure while reading the facts (an unreadable log, git
	 * failing) asks instead of passing, and so does a `gh pr create` whose directory cannot be resolved.
	 */
	const prGate = async (command: string, commandCwd: string): Promise<{ decision: PrGateDecision; categories: RiskCategory[] } | undefined> => {
		let dir: string | undefined;
		try {
			dir = prCreateDirectory(command, commandCwd);
		} catch (error) {
			return prFactsError(error);
		}
		if (!dir) return opensPrCreate(command) ? { decision: { action: "ask", reasons: [UNRESOLVED_DIRECTORY_REASON] }, categories: [] } : undefined;
		return prGateAt(dir);
	};
	const prFactsError = (error: unknown): { decision: PrGateDecision; categories: RiskCategory[] } => ({
		decision: { action: "ask", reasons: [`${PR_FACTS_ERROR_REASON} (${String((error as Error)?.message ?? error).split("\n")[0].slice(0, 200)})`] },
		categories: [],
	});
	/** The PR gate for a PR opened from `dir` (a `gh pr create`'s directory, or the session's for an MCP tool that opens one). */
	const prGateAt = async (dir: string): Promise<{ decision: PrGateDecision; categories: RiskCategory[] } | undefined> => {
		try {
			const settings = readSettings();
			const risk = await branchRisk(exec, dir, riskMapFor(settings));
			if (!risk?.branch) return undefined;
			const docs = repoDocsDir(dir);
			const head = await worktreeTreeResult(dir, { sourceTree: true, commit: "HEAD" });
			const suite = resolveCommand({ cwd: risk.root, settings });
			const decision = decidePrGate({
				sourceChanged: risk.baseUnknown === true || risk.committedUnknown === true || risk.committed.some((path) => !isDocPath(path)),
				head: head.kind === "tree" ? { tree: head.tree, sourceTree: head.sourceTree ?? head.tree, root: head.root } : { error: head.kind === "error" ? head.reason : "not a git work tree" },
				suiteCommand: "command" in suite ? suite.command : undefined,
				tier: risk.tier,
				categories: risk.categories,
				records: readEvidence(evidenceFile(docs, risk.branch)),
				branch: risk.branch,
				ledgerExists: existsSync(join(docs, "reviews", `${branchSlug(risk.branch)}.md`)),
				baseUnknown: risk.baseUnknown,
			});
			return { decision, categories: (Object.keys(risk.categories) as RiskCategory[]).filter((category) => category === "security" || category === "data" || category === "contract") };
		} catch (error) {
			return prFactsError(error);
		}
	};

	/** The command a `check` call will run (explicit, else the configured or detected one, plus the focus); undefined when none resolves, where check only errors. */
	const checkCallOf = (input: unknown, ctx: ExtensionContext): { command: string } | undefined => {
		const fields = (input && typeof input === "object" ? input : {}) as { command?: unknown; focus?: unknown };
		const choice = resolveCommand({ command: typeof fields.command === "string" ? fields.command : undefined, focus: typeof fields.focus === "string" ? fields.focus : undefined, cwd: ctx.cwd, settings: readSettings() });
		return "command" in choice ? { command: choice.command } : undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		// A new, resumed, or forked session starts with no "yes for this session".
		sessionGrants.clear();
		pushGrants.clear();
		return restoreMode(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => restoreMode(ctx));
	// A compaction drops the notice from the model's context: announce the mode again on the next turn.
	pi.on("session_compact", async () => {
		announcedMode = undefined;
	});

	// The mode reaches the model as a context message, not as system text: a switch never changes the system prompt
	// (which would rebuild the cached prefix). The message is added at the start of the first turn after a session start
	// or a mode change, once per mode; the session keeps it, so a resumed session does not repeat it.
	pi.on("before_agent_start", async () => {
		if (isChild || announcedMode === mode) return undefined;
		announcedMode = mode;
		return { message: { customType: MODE_NOTICE, content: MODE_PROMPT[mode], display: false, details: { mode } } };
	});

	const decideToolCall = async (event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> => {
		// A subagent's active tools are its agent's `tools:` list. A codemode script can also call tools that are callable without being active
		// (MCP tools, `codemode`/`deferred` exposure), so a subagent's call to any tool outside that list is blocked.
		if (isChild && typeof pi.getActiveTools === "function" && !pi.getActiveTools().includes(event.toolName)) {
			return { block: true, reason: `Blocked by brigadev guard: ${process.env[CHILD_ENV.AGENT] ?? "this agent"} may only call its own tools, and ${event.toolName} is not one of them.` };
		}
		// `bash` and `bg_start` (a background shell process) are one path: same classification, same permission rules,
		// same evidence-log and commit-gate rules. `bg_start` adds its working directory, decided like a write into it.
		// `check` runs a command through `bash -c`: it is decided as a bash call of the command that will run.
		const shell = event.toolName === CHECK_TOOL ? checkCallOf(event.input, ctx) : shellCallOf(event.toolName, event.input);
		if (shell) {
			const { command } = shell;
			// Where the command starts: a bg_start `cwd` is the same move as `cd <cwd> && <command>`, so relative paths in the
			// rules below resolve against it and a commit there is decided like bash decides the `cd` form.
			const commandCwd = shell.cwd === undefined ? ctx.cwd : canonicalPath(resolve(ctx.cwd, expandHome(shell.cwd)));
			// Nobody forges a recorded test result: the evidence log is written only by the recorder. (Textual rule; reading stays allowed.)
			if ((command.includes("evidence") || commandCwd.includes("evidence")) && bashWritesEvidence(command, [join(repoDocsDir(ctx.cwd), "evidence")], undefined, shell.cwd === undefined ? undefined : commandCwd)) return { block: true, reason: EVIDENCE_BLOCK };
			if (event.toolName === CHECK_TOOL) {
				// A test tool never delivers, deletes, or publishes (even in YOLO); and it reads no secret without the sensitive-path question.
				const refusal = checkRefusal(command);
				if (refusal) return { block: true, reason: `Blocked by brigadev guard: ${refusal}` };
				for (const { word, absolute } of sensitiveWords(command, commandCwd)) {
					const blocked = await checkPath(event.toolName, word, absolute, false, ctx, true, whyNote(command));
					if (blocked) return blocked;
				}
			}
			if (shell.cwd !== undefined) {
				const blocked = await checkPath(event.toolName, shell.cwd, commandCwd, true, ctx, true, whyNote(command));
				if (blocked) return blocked;
			}
			const surfaces = writerSurfaces();
			if (surfaces) {
				const outside = writesOutsideSurfaces(command, commandCwd, projectRoot(ctx), surfaces);
				if (outside.length > 0) {
					return {
						block: true,
						reason: `Blocked by brigadev guard: this command writes ${outside.join(", ")}, outside the allowed edit surfaces (${surfaces.join(", ")}). Use edit or write inside your surfaces, or stop and report status: interaction_required with the path you need.`,
					};
				}
			}

			// A commit whose directory is in another repository than the session's is "elsewhere" for the branch rule.
			const startsElsewhere = shell.cwd !== undefined && classifyCommand(command).some((match) => match.commit) && (await repoRoot(commandCwd)) !== (await repoRoot(projectRoot(ctx)));
			const decision = await decideBashCommand({ command, mode, isChild, cwd: commandCwd, elsewhere: startsElsewhere, readFacts: (cwd) => readBranchFacts(exec, cwd) });
			if (decision.action === "block") return { block: true, reason: decision.reason };
			// The PR gate shares the PR confirmation (every mode: a PR creation always asks; one dialog, the reasons and the note appended). It asks on its own only if the policy let a PR command run unasked.
			const pr = isChild ? undefined : await prGate(command, commandCwd);
			const prBlock = pr?.decision.action === "ask" ? { block: true as const, reason: prGateBlockMessage(pr.decision, pr.categories) } : undefined;
			// A session grant skips the policy question; the PR gate still asks on its own when it finds a problem.
			const pushUrls = decision.action === "confirm" && !isChild && grantable(decision.matches) ? await pushDestinations(decision.matches, commandCwd) : undefined;
			const granted = decision.action === "confirm" ? grantFor(decision.matches, pushUrls) : undefined;
			if (decision.action === "confirm" && !granted) {
				const prText = pr ? prGateDialogText(pr.decision) : "";
				const dialog = commandDialog(command, decision.matches, prText || undefined, undefined, { sessionGrant: pushUrls !== undefined });
				const ok = await confirm(ctx, dialog, `brigadev: ${decision.reason}`, pushUrls);
				if (!ok) return prBlock ?? { block: true, reason: `User declined: ${decision.reason}` };
			} else if (pr && prBlock) {
				const matches = classifyCommand(command);
				const dialog = commandDialog(command, matches.length > 0 ? matches : [{ kind: COMMAND_KIND.DELIVERY, reason: "gh pr create" }], prGateDialogText(pr.decision), "Open the PR anyway?", { sessionGrant: false });
				const ok = await confirm(ctx, dialog, "brigadev: PR risk gate");
				if (!ok) return prBlock;
			}
			if (granted) noteGrant(granted);
			// The command will run: remember the tree so tool_result can see what it changed.
			if (surfaces) {
				const snapshot = await takeSnapshot(exec, projectRoot(ctx));
				if (snapshot) beforeBash.set(event.toolCallId, snapshot);
			}
			return undefined;
		}

		// MCP tools that deliver or publish (T3 Code's or GitHub's pull_request_create, a merge, a push, a PR comment) follow the
		// same policy as the gh/git command they stand for; opening a PR also runs the PR gate, on the session's directory.
		const mcp = classifyMcpTool(event.toolName);
		if (mcp) {
			const decision = decideCommand([mcp], mode, isChild);
			if (decision.action === "block") return { block: true, reason: decision.reason };
			const pr = mcp.opensPr && !isChild ? await prGateAt(projectRoot(ctx)) : undefined;
			const prBlock = pr?.decision.action === "ask" ? { block: true as const, reason: prGateBlockMessage(pr.decision, pr.categories, event.toolName) } : undefined;
			const prText = pr ? prGateDialogText(pr.decision) : "";
			const preview = `${event.toolName}\n${mcpInputPreview(event.input)}`;
			// An MCP push is never plain (`CommandMatch.push`), so no grant covers it.
			const granted = decision.action === "confirm" ? grantFor(decision.matches, undefined) : undefined;
			if (decision.action === "confirm" && !granted) {
				const dialog = toolDialog(preview, decision.matches, prText || undefined);
				const ok = await confirm(ctx, dialog, `brigadev: ${decision.reason}`);
				if (!ok) return prBlock ?? { block: true, reason: `User declined: ${decision.reason}` };
			} else if (pr && prBlock) {
				const dialog = toolDialog(preview, [mcp], prText, "Open the PR anyway?", { sessionGrant: false });
				const ok = await confirm(ctx, dialog, "brigadev: PR risk gate");
				if (!ok) return prBlock;
			}
			if (granted) noteGrant(granted);
			return undefined;
		}

		const isWrite = isToolCallEventType("write", event) || isToolCallEventType("edit", event);
		// grep, find, and ls take a `path` that may be a folder or a file; it is decided like a read (without a path they search the working directory).
		const isSearch = SEARCH_TOOLS.has(event.toolName);
		const isRead = isToolCallEventType("read", event);
		if (!isWrite && !isRead && !isSearch) return undefined;

		const rawPath = String((event.input as { path?: unknown }).path ?? "");
		if (!rawPath) return undefined;
		const absolute = canonicalPath(resolve(ctx.cwd, expandHome(rawPath)));
		return checkPath(event.toolName, rawPath, absolute, isWrite, ctx, isSearch);
	};

	// A block, or a call the user was asked about, is published as a guard decision; a silently allowed call is not.
	pi.on("tool_call", async (event, ctx) => {
		if (isChild) return decideToolCall(event, ctx);
		const current: Judging = { event, asked: false };
		const result = await judging.run(current, () => decideToolCall(event, ctx));
		if (result?.block) announce(current, "block", result.reason);
		else if (current.asked) announce(current, "allow");
		else if (current.granted) announce(current, "allow", current.granted);
		return result;
	});

	// Pi's grep, find, and ls list whatever sits under their path (grep runs `rg --hidden`): a search rooted above a secret
	// folder would print secret contents. The call is decided on its path; the result is filtered file by file.
	pi.on("tool_result", async (event, ctx) => {
		if (!SEARCH_TOOLS.has(event.toolName) || event.isError) return undefined;
		const rawPath = String((event.input as { path?: unknown }).path ?? "") || ".";
		const searchPath = canonicalPath(resolve(ctx.cwd, expandHome(rawPath)));
		let changed = false;
		const content = event.content.map((part) => {
			if (part.type !== "text") return part;
			const filtered = hideSensitiveResults(event.toolName, part.text, searchPath);
			if (!filtered) return part;
			changed = true;
			return { ...part, text: filtered.text };
		});
		return changed ? { content } : undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		const before = beforeBash.get(event.toolCallId);
		if (!before) return undefined;
		beforeBash.delete(event.toolCallId);
		const surfaces = writerSurfaces();
		if (!surfaces) return undefined;
		const after = await takeSnapshot(exec, projectRoot(ctx));
		if (!after) return undefined;
		const outside = outsideSurfaces(diffSnapshots(before, after), surfaces);
		if (outside.length === 0) return undefined;
		const notice = `[brigadev guard] This command changed files outside your allowed edit surfaces: ${outside.join(", ")}. Do not change files through bash; report these paths to the parent.`;
		return { content: [...event.content, { type: "text" as const, text: notice }], isError: true };
	});

	if (isChild) return;

	pi.registerCommand("brigadev:yolo-dir", {
		description: "Secure-yolo folders, where write/edit outside the project run without asking: list | add <folder> | remove <folder>",
		getArgumentCompletions: (prefix) => {
			const items = ["list", "add ", "remove "].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value.trim() }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const message = runYoloDirCommand(args, { read: readSettings, write: writeSettings }, { ...secureGuard(), tempRoots: tempDirs() });
			ctx.ui.notify(message, message.startsWith("brigadev: refused") ? "error" : "info");
		},
	});

	pi.registerCommand("brigadev:mode", {
		description: "Permission mode: normal | yolo | default <normal|yolo> | status",
		getArgumentCompletions: (prefix) => {
			const items = ["normal", "yolo", "status", "default normal", "default yolo"].map((value) => ({ value, label: value }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [first, second] = args.trim().split(/\s+/).filter(Boolean);
			if (first === "default") {
				if (!isPermissionMode(second)) return ctx.ui.notify("Usage: /brigadev:mode default <normal|yolo>", "error");
				writeSettings({ defaultMode: second });
				return ctx.ui.notify(`brigadev: new sessions start in ${second} mode`, "info");
			}
			if (isPermissionMode(first)) {
				setMode(first, ctx);
				return ctx.ui.notify(first === PERMISSION_MODE.YOLO ? "🚀 YOLO on: commits and issue writes run without asking; pushes, PR creation, and destructive commands still ask." : "brigadev: normal mode", "info");
			}
			if (first && first !== "status") return ctx.ui.notify("Usage: /brigadev:mode normal | yolo | default <normal|yolo> | status", "error");
			if (!first && ctx.hasUI) {
				const choice = await ctx.ui.select(`brigadev permission mode (current: ${mode})`, [PERMISSION_MODE.NORMAL, PERMISSION_MODE.YOLO]);
				if (isPermissionMode(choice)) setMode(choice, ctx);
				return;
			}
			const saved = readSettings().defaultMode ?? PERMISSION_MODE.NORMAL;
			ctx.ui.notify(`brigadev mode: ${mode} (default for new sessions: ${saved})`, "info");
		},
	});
}
