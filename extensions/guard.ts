/**
 * brigadev guard: destructive-command confirmation, permission modes,
 * project-root boundary, secret-file protection, and allowed-edit-surface
 * enforcement for subagents.
 *
 * Subagents load this file explicitly (`-e`), so it must work standalone.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext, type ToolCallEvent, type ToolCallEventResult } from "@earendil-works/pi-coding-agent";
import { writesOutsideSurfaces } from "../lib/bash-writes.ts";
import { BUS, publish, type GuardDecision, type ModeState } from "../lib/bus.ts";
import { classifyCommand } from "../lib/command-classifier.ts";
import { readBranchFacts } from "../lib/commit-branch.ts";
import { appendEvidence, branchSlug, evaluateCommitGate, evidenceFile, forceRecord, gateDialog, readEvidence, type ForceRecord } from "../lib/evidence.ts";
import { checkRefusal, resolveCommand } from "../lib/check.ts";
import { askConfirm } from "../lib/human-prompt.ts";
import { bashWritesEvidence, CHECK_TOOL, decideBashCommand, decideFileAccess, EVIDENCE_BLOCK, hideSensitiveResults, isProtectedPath, runYoloDirCommand, secureYoloDirs, sensitiveWords, shellCallOf, tempRoots, trustedTempRoots, type PathVerdict } from "../lib/guard-rules.ts";
import { commandPreview, isPermissionMode, isSensitivePath, MODE_PROMPT, PERMISSION_MODE, type PermissionMode } from "../lib/permission-policy.ts";
import { canonicalPath, expandHome, isInside } from "../lib/paths.ts";
import { decidePrGate, opensPrCreate, prCreateDirectory, prGateBlockMessage, prGateDialogText, riskMapFor, UNRESOLVED_DIRECTORY_REASON, type PrGateDecision } from "../lib/pr-gate.ts";
import { brigadevHome, repoDocsDir } from "../lib/repo-docs.ts";
import { branchRisk, type RiskCategory } from "../lib/risk-map.ts";
import { agentDir, CHILD_ENV, childAllowedSurfaces, isChildSession, PACKAGE_ROOT, readSettings, writeSettings } from "../lib/runtime.ts";
import { diffSnapshots, outsideSurfaces, takeSnapshot, type ExecFn, type Snapshot } from "../lib/worktree-snapshot.ts";
import { worktreeTreeResult } from "../lib/worktree-tree.ts";

const MODE_ENTRY = "brigadev-mode";
const STATUS_KEY = "brigadev-mode";
/** Custom message that tells the model the permission mode (not in the system prompt, so a switch never changes it). */
const MODE_NOTICE = "brigadev-mode-notice";
/** Tools that search under a `path` argument; the guard decides that path like a read. */
const SEARCH_TOOLS = new Set(["grep", "find", "ls"]);

export default function (pi: ExtensionAPI) {
	const isChild = isChildSession();
	let mode: PermissionMode = PERMISSION_MODE.NORMAL;
	// Per-session grants for directories outside the project root.
	const outsideGrants = new Set<string>();
	// Worktree tree the user granted a one-shot commit force for (/brigadev:force-commit). Only that command sets it.
	let forcedTree: string | undefined;

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
	}
	const judging = new AsyncLocalStorage<Judging>();
	const announce = (current: Judging, action: GuardDecision["action"], reason?: string) => {
		const { toolCallId, toolName, input } = current.event;
		const fields = (input && typeof input === "object" ? input : {}) as { command?: unknown; path?: unknown };
		const subject = typeof fields.command === "string" ? fields.command : typeof fields.path === "string" ? fields.path : undefined;
		publish(pi.events, BUS.guard, { id: randomUUID(), toolCallId, tool: toolName, ...(subject === undefined ? {} : { subject: subject.slice(0, 500) }), action, ...(reason === undefined ? {} : { reason }), at: Date.now() } satisfies GuardDecision);
	};

	/** Asks the user, in the TUI or from the web (first answer wins); without a UI (print mode, subagents) the answer is no. */
	const confirm = async (ctx: ExtensionContext, title: string, body: string): Promise<boolean> => {
		if (isChild || !ctx.hasUI) return false;
		const current = judging.getStore();
		if (current) {
			current.asked = true;
			announce(current, "confirm", title);
		}
		return askConfirm(pi.events, ctx, { source: "guard", title, body });
	};

	/** Top of the repository that holds `dir` (canonical); `dir` itself when git cannot tell (not a repository, a failure). */
	const repoRoot = async (dir: string): Promise<string> => {
		const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 15_000 }).catch(() => undefined);
		return top?.code === 0 && top.stdout.trim() ? canonicalPath(top.stdout.trim()) : dir;
	};

	/**
	 * Evidence gate for `git commit` (parent only, every permission mode): blocks a commit with source
	 * changes unless a passing test is recorded for the current tree. Only the user can force it.
	 * Returns a block reason, or a `settle` to call once the remaining rules let the commit run: the
	 * user's force (one-shot or dialog) is spent and logged then, not when a later rule declines.
	 */
	const evidenceGate = async (command: string, ctx: ExtensionContext, commandCwd: string): Promise<{ reason?: string; settle: () => void }> => {
		const nothing = { settle: () => {} };
		// Judged against the repository the commit runs in (`git -C`, a leading `cd`, a nested repo); none when it commits nothing.
		const evaluation = await evaluateCommitGate({ exec, command, cwd: commandCwd, forcedTree });
		if (!evaluation) return nothing;
		const { decision, consumedForce, file, branch, tree } = evaluation;
		const log = (via: ForceRecord["via"]) => {
			try {
				appendEvidence(file, forceRecord({ ts: new Date().toISOString(), branch, tree, via, command }));
			} catch {
				// The force is the user's decision; a failed log write does not undo it.
			}
		};

		if (decision.action === "allow") {
			return consumedForce
				? {
						settle: () => {
							forcedTree = undefined;
							log("command");
						},
					}
				: nothing;
		}

		if (!isChild && ctx.hasUI) {
			const dialog = gateDialog(decision.reason, command);
			if (await confirm(ctx, dialog.title, dialog.body)) return { settle: () => log("dialog") };
		}
		return { reason: decision.reason, settle: () => {} };
	};

	/**
	 * One file-access decision for a path a tool call touches (read, write, edit, the `path` of grep/find/ls, or the working directory a background
	 * process starts in): sensitive-path question, outside-project grant. Returns a block, or undefined to let it run.
	 * `isDirectory`: the path is a working directory, so a sensitive folder (`.ssh`) counts as sensitive and an outside
	 * directory is granted as itself, not as its parent (the folder of a file).
	 */
	const checkPath = async (toolName: string, rawPath: string, absolute: string, isWrite: boolean, ctx: ExtensionContext, isDirectory = false): Promise<{ block: true; reason: string } | undefined> => {
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
			const ok = await confirm(ctx, "brigadev: sensitive file", `${toolName} ${rawPath}\n\nThis path commonly holds secrets or credentials. Allow?`);
			if (!ok) return { block: true, reason: `User declined access to sensitive file ${rawPath}` };
			verdict = decision.then;
		} else verdict = decision;

		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (verdict.action === "ask") {
			if ([...outsideGrants].some((granted) => isInside(granted, absolute))) return undefined;
			const target = isDirectory ? absolute : verdict.target;
			const ok = await confirm(ctx, "brigadev: write outside project", `${toolName} ${absolute}\n\nOutside the project root ${root}. Allow writes under ${target} for this session?`);
			if (!ok) return { block: true, reason: `User declined write outside the project root: ${absolute}` };
			outsideGrants.add(target);
		}
		return undefined;
	};

	/**
	 * PR risk gate for `gh pr create` (parent only, every permission mode, S9): the branch's tier against its evidence and review ledger.
	 * Undefined when the command opens no PR. It is advice on top of the human PR decision, so anything that fails while
	 * reading the facts (no git, a detached HEAD, an unreadable log) fails open instead of blocking the PR. A `gh pr create`
	 * whose directory cannot be resolved is not a read error: the gate cannot look, so it asks.
	 */
	const prGate = async (command: string, commandCwd: string): Promise<{ decision: PrGateDecision; categories: RiskCategory[] } | undefined> => {
		try {
			const dir = prCreateDirectory(command, commandCwd);
			if (!dir) return opensPrCreate(command) ? { decision: { action: "ask", reasons: [UNRESOLVED_DIRECTORY_REASON] }, categories: [] } : undefined;
			const risk = await branchRisk(exec, dir, riskMapFor(readSettings()));
			if (!risk?.branch) return undefined;
			const docs = repoDocsDir(dir);
			const decision = decidePrGate({
				tier: risk.tier,
				categories: risk.categories,
				records: readEvidence(evidenceFile(docs, risk.branch)),
				branch: risk.branch,
				ledgerExists: existsSync(join(docs, "reviews", `${branchSlug(risk.branch)}.md`)),
				baseUnknown: risk.baseUnknown,
			});
			return { decision, categories: (Object.keys(risk.categories) as RiskCategory[]).filter((category) => category === "security" || category === "data" || category === "contract") };
		} catch {
			return undefined;
		}
	};

	/** The command a `check` call will run (explicit, else the configured or detected one, plus the focus); undefined when none resolves, where check only errors. */
	const checkCallOf = (input: unknown, ctx: ExtensionContext): { command: string } | undefined => {
		const fields = (input && typeof input === "object" ? input : {}) as { command?: unknown; focus?: unknown };
		const choice = resolveCommand({ command: typeof fields.command === "string" ? fields.command : undefined, focus: typeof fields.focus === "string" ? fields.focus : undefined, cwd: ctx.cwd, settings: readSettings() });
		return "command" in choice ? { command: choice.command } : undefined;
	};

	pi.on("session_start", async (_event, ctx) => restoreMode(ctx));
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
					const blocked = await checkPath(event.toolName, word, absolute, false, ctx, true);
					if (blocked) return blocked;
				}
			}
			if (shell.cwd !== undefined) {
				const blocked = await checkPath(event.toolName, shell.cwd, commandCwd, true, ctx, true);
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

			// A commit whose directory is in another repository than the session's is "elsewhere" for the branch rule and the gate alike.
			const startsElsewhere = shell.cwd !== undefined && classifyCommand(command).some((match) => match.commit) && (await repoRoot(commandCwd)) !== (await repoRoot(projectRoot(ctx)));
			const decision = await decideBashCommand({ command, mode, isChild, cwd: commandCwd, elsewhere: startsElsewhere, readFacts: (cwd) => readBranchFacts(exec, cwd) });
			if (decision.action === "block") return { block: true, reason: decision.reason };
			const gated = isChild ? undefined : await evidenceGate(command, ctx, commandCwd);
			if (gated?.reason) return { block: true, reason: gated.reason };
			// The PR gate shares the PR confirmation in normal mode (one dialog, the reasons and the note appended); in yolo it asks on its own, only for reasons.
			const pr = isChild ? undefined : await prGate(command, commandCwd);
			const prBlock = pr?.decision.action === "ask" ? { block: true as const, reason: prGateBlockMessage(pr.decision, pr.categories) } : undefined;
			if (decision.action === "confirm") {
				const prText = pr ? prGateDialogText(pr.decision) : "";
				const ok = await confirm(ctx, `brigadev: ${decision.reason}`, `${commandPreview(command)}${prText ? `\n\n${prText}` : ""}\n\nRun it?`);
				if (!ok) return prBlock ?? { block: true, reason: `User declined: ${decision.reason}` };
			} else if (pr && prBlock) {
				const ok = await confirm(ctx, "brigadev: PR risk gate", `${commandPreview(command)}\n\n${prGateDialogText(pr.decision)}\n\nOpen the PR anyway?`);
				if (!ok) return prBlock;
			}
			// Every rule allowed the commit: only now is the user's force spent and logged.
			gated?.settle();

			// The command will run: remember the tree so tool_result can see what it changed.
			if (surfaces) {
				const snapshot = await takeSnapshot(exec, projectRoot(ctx));
				if (snapshot) beforeBash.set(event.toolCallId, snapshot);
			}
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

	pi.registerCommand("brigadev:force-commit", {
		description: "Let the next git commit on the current working tree pass the evidence gate (one-shot; edits cancel it)",
		handler: async (_args, ctx) => {
			const result = await worktreeTreeResult(projectRoot(ctx));
			if (result.kind === "no-git") return ctx.ui.notify("brigadev: not a git working tree, so the evidence gate does not apply", "error");
			if (result.kind === "error") {
				return ctx.ui.notify(`brigadev: the working tree could not be computed (${result.reason}), so a force cannot be bound to it. Use the dialog the guard shows when the commit is blocked, or fix git and try again.`, "error");
			}
			forcedTree = result.tree;
			ctx.ui.notify("brigadev: the next commit of the current working tree skips the evidence gate. Editing any file first cancels this.", "info");
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
				return ctx.ui.notify(first === PERMISSION_MODE.YOLO ? "🚀 YOLO on: commits, pushes, and PRs run without asking; destructive commands still ask." : "brigadev: normal mode", "info");
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
