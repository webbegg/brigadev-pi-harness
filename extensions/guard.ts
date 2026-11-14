/**
 * brigadev guard: destructive-command confirmation, permission modes,
 * project-root boundary, secret-file protection, and allowed-edit-surface
 * enforcement for subagents.
 *
 * Subagents load this file explicitly (`-e`), so it must work standalone.
 */

import { join, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writesOutsideSurfaces } from "../lib/bash-writes.ts";
import { classifyCommand } from "../lib/command-classifier.ts";
import { readBranchFacts } from "../lib/commit-branch.ts";
import { appendEvidence, commitGateWithForce, evidenceFile, forceRecord, gateDialog, readEvidence, type ForceRecord } from "../lib/evidence.ts";
import { bashWritesEvidence, decideBashCommand, decideFileAccess, EVIDENCE_BLOCK, type PathVerdict } from "../lib/guard-rules.ts";
import { commandPreview, isPermissionMode, isSensitivePath, MODE_PROMPT, PERMISSION_MODE, type PermissionMode } from "../lib/permission-policy.ts";
import { canonicalPath, expandHome, isInside } from "../lib/paths.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { appendSystemPromptOnce, CHILD_ENV, childAllowedSurfaces, isChildSession, readSettings, writeSettings } from "../lib/runtime.ts";
import { diffSnapshots, outsideSurfaces, takeSnapshot, type ExecFn, type Snapshot } from "../lib/worktree-snapshot.ts";
import { worktreeTreeResult } from "../lib/worktree-tree.ts";

const MODE_ENTRY = "brigadev-mode";
const STATUS_KEY = "brigadev-mode";


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

	const publishStatus = (ctx: ExtensionContext) => {
		if (isChild || !ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, mode === PERMISSION_MODE.YOLO ? "🚀 brigadev: yolo" : "brigadev: normal");
	};

	const restoreMode = (ctx: ExtensionContext) => {
		const saved = readSettings().defaultMode;
		mode = isPermissionMode(saved) ? saved : PERMISSION_MODE.NORMAL;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
				const value = (entry.data as { mode?: unknown } | undefined)?.mode;
				if (isPermissionMode(value)) mode = value;
			}
		}
		outsideGrants.clear();
		publishStatus(ctx);
	};

	const setMode = (next: PermissionMode, ctx: ExtensionContext) => {
		mode = next;
		pi.appendEntry(MODE_ENTRY, { mode });
		publishStatus(ctx);
	};

	/** Asks the user; without a UI (print mode, subagents) the answer is no. */
	const confirm = async (ctx: ExtensionContext, title: string, body: string): Promise<boolean> => {
		if (isChild || !ctx.hasUI) return false;
		return ctx.ui.confirm(title, body);
	};

	/**
	 * Evidence gate for `git commit` (parent only, every permission mode): blocks a commit with source
	 * changes unless a passing test is recorded for the current tree. Only the user can force it.
	 * Returns a block reason, or a `settle` to call once the remaining rules let the commit run: the
	 * user's force (one-shot or dialog) is spent and logged then, not when a later rule declines.
	 */
	const evidenceGate = async (command: string, ctx: ExtensionContext): Promise<{ reason?: string; settle: () => void }> => {
		const nothing = { settle: () => {} };
		const commits = classifyCommand(command).filter((match) => match.commit);
		if (commits.length === 0) return nothing;
		// The whole repository, not the session folder: a session in a subdirectory commits files elsewhere too.
		const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: projectRoot(ctx), timeout: 15_000 }).catch(() => undefined);
		const root = top?.code === 0 && top.stdout.trim() ? canonicalPath(top.stdout.trim()) : projectRoot(ctx);
		const treeResult = await worktreeTreeResult(root);
		const tree = treeResult.kind === "tree" ? treeResult.tree : undefined;
		const treeError = treeResult.kind === "error" ? treeResult.reason : undefined;
		const snapshot = tree === undefined ? undefined : await takeSnapshot(exec, root);
		const branch = (await readBranchFacts(exec, ctx.cwd)).currentBranch;
		const file = evidenceFile(repoDocsDir(ctx.cwd), branch);
		const log = (via: ForceRecord["via"]) => {
			try {
				appendEvidence(file, forceRecord({ ts: new Date().toISOString(), branch, tree, via, command }));
			} catch {
				// The force is the user's decision; a failed log write does not undo it.
			}
		};

		const { decision, consumedForce } = commitGateWithForce({
			// Unknown dirty paths count as source: a gate that cannot see the change must not pass it.
			dirtyPaths: snapshot ? [...snapshot.keys()] : ["(unknown)"],
			tree,
			treeError,
			elsewhere: commits.some((match) => match.elsewhere),
			records: readEvidence(file),
			forcedTree,
		});
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
			if (await ctx.ui.confirm(dialog.title, dialog.body)) return { settle: () => log("dialog") };
		}
		return { reason: decision.reason, settle: () => {} };
	};

	pi.on("session_start", async (_event, ctx) => restoreMode(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreMode(ctx));

	pi.on("before_agent_start", async (event) => {
		if (isChild) return;
		appendSystemPromptOnce(event.systemPromptOptions, MODE_PROMPT[mode]);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
			// Nobody forges a recorded test result: the evidence log is written only by the recorder. (Textual rule; reading stays allowed.)
			if (event.input.command.includes("evidence") && bashWritesEvidence(event.input.command, [join(repoDocsDir(ctx.cwd), "evidence")])) return { block: true, reason: EVIDENCE_BLOCK };
			const surfaces = writerSurfaces();
			if (surfaces) {
				const outside = writesOutsideSurfaces(event.input.command, ctx.cwd, projectRoot(ctx), surfaces);
				if (outside.length > 0) {
					return {
						block: true,
						reason: `Blocked by brigadev guard: this command writes ${outside.join(", ")}, outside the allowed edit surfaces (${surfaces.join(", ")}). Use edit or write inside your surfaces, or stop and report status: interaction_required with the path you need.`,
					};
				}
			}

			const decision = await decideBashCommand({ command: event.input.command, mode, isChild, cwd: ctx.cwd, readFacts: (cwd) => readBranchFacts(exec, cwd) });
			if (decision.action === "block") return { block: true, reason: decision.reason };
			const gated = isChild ? undefined : await evidenceGate(event.input.command, ctx);
			if (gated?.reason) return { block: true, reason: gated.reason };
			if (decision.action === "confirm") {
				const ok = await confirm(ctx, `brigadev: ${decision.reason}`, `${commandPreview(event.input.command)}\n\nRun it?`);
				if (!ok) return { block: true, reason: `User declined: ${decision.reason}` };
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
		const isRead = isToolCallEventType("read", event);
		if (!isWrite && !isRead) return undefined;

		const rawPath = String((event.input as { path?: unknown }).path ?? "");
		if (!rawPath) return undefined;
		const absolute = canonicalPath(resolve(ctx.cwd, expandHome(rawPath)));
		const root = projectRoot(ctx);

		const decision = decideFileAccess({
			isChild,
			isWrite,
			rawPath,
			absolutePath: absolute,
			projectRoot: root,
			docsDir: () => repoDocsDir(ctx.cwd),
			sensitive: isSensitivePath(absolute),
			readOnly: process.env[CHILD_ENV.READ_ONLY] === "1",
			surfaces: isChild ? childAllowedSurfaces() : undefined,
			agent: process.env[CHILD_ENV.AGENT],
		});

		let verdict: PathVerdict;
		if (decision.action === "ask" && decision.kind === "sensitive") {
			const ok = await confirm(ctx, "brigadev: sensitive file", `${event.toolName} ${rawPath}\n\nThis path commonly holds secrets or credentials. Allow?`);
			if (!ok) return { block: true, reason: `User declined access to sensitive file ${rawPath}` };
			verdict = decision.then;
		} else verdict = decision;

		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (verdict.action === "ask") {
			if ([...outsideGrants].some((granted) => isInside(granted, absolute))) return undefined;
			const ok = await confirm(ctx, "brigadev: write outside project", `${event.toolName} ${absolute}\n\nOutside the project root ${root}. Allow writes under ${verdict.target} for this session?`);
			if (!ok) return { block: true, reason: `User declined write outside the project root: ${absolute}` };
			outsideGrants.add(verdict.target);
		}
		return undefined;
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
