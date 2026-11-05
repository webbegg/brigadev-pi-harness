/**
 * brigadev guard: destructive-command confirmation, permission modes,
 * project-root boundary, secret-file protection, and allowed-edit-surface
 * enforcement for subagents.
 *
 * Subagents load this file explicitly (`-e`), so it must work standalone.
 */

import { dirname, relative, resolve, sep } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writesOutsideSurfaces } from "../lib/bash-writes.ts";
import { classifyCommand } from "../lib/command-classifier.ts";
import { isWithinSurfaces } from "../lib/edit-surfaces.ts";
import { commandPreview, decideCommand, isPermissionMode, isSensitivePath, MODE_PROMPT, PERMISSION_MODE, type PermissionMode } from "../lib/permission-policy.ts";
import { canonicalPath, expandHome, isInside } from "../lib/paths.ts";
import { appendSystemPromptOnce, CHILD_ENV, childAllowedSurfaces, isChildSession, readSettings, writeSettings } from "../lib/runtime.ts";
import { diffSnapshots, outsideSurfaces, takeSnapshot, type ExecFn, type Snapshot } from "../lib/worktree-snapshot.ts";

const MODE_ENTRY = "brigadev-mode";
const STATUS_KEY = "brigadev-mode";


export default function (pi: ExtensionAPI) {
	const isChild = isChildSession();
	let mode: PermissionMode = PERMISSION_MODE.NORMAL;
	// Per-session grants for directories outside the project root.
	const outsideGrants = new Set<string>();

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

	pi.on("session_start", async (_event, ctx) => restoreMode(ctx));
	pi.on("session_tree", async (_event, ctx) => restoreMode(ctx));

	pi.on("before_agent_start", async (event) => {
		if (isChild) return;
		appendSystemPromptOnce(event.systemPromptOptions, MODE_PROMPT[mode]);
	});

	pi.on("tool_call", async (event, ctx) => {
		if (isToolCallEventType("bash", event)) {
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

			const decision = decideCommand(classifyCommand(event.input.command), mode, isChild);
			if (decision.action === "block") return { block: true, reason: decision.reason };
			if (decision.action === "confirm") {
				const ok = await confirm(ctx, `brigadev: ${decision.reason}`, `${commandPreview(event.input.command)}\n\nRun it?`);
				if (!ok) return { block: true, reason: `User declined: ${decision.reason}` };
			}

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

		if (isSensitivePath(absolute)) {
			if (isChild) return { block: true, reason: `Blocked by brigadev guard: ${rawPath} may hold secrets; subagents never read or write it.` };
			const ok = await confirm(ctx, "brigadev: sensitive file", `${event.toolName} ${rawPath}\n\nThis path commonly holds secrets or credentials. Allow?`);
			if (!ok) return { block: true, reason: `User declined access to sensitive file ${rawPath}` };
		}

		if (!isWrite) return undefined;

		if (!isInside(root, absolute)) {
			if (isChild) return { block: true, reason: `Blocked by brigadev guard: ${rawPath} is outside the project root ${root}.` };
			if ([...outsideGrants].some((granted) => isInside(granted, absolute))) return undefined;
			const target = dirname(absolute);
			const ok = await confirm(ctx, "brigadev: write outside project", `${event.toolName} ${absolute}\n\nOutside the project root ${root}. Allow writes under ${target} for this session?`);
			if (!ok) return { block: true, reason: `User declined write outside the project root: ${absolute}` };
			outsideGrants.add(target);
			return undefined;
		}

		if (isChild) {
			if (process.env[CHILD_ENV.READ_ONLY] === "1") {
				return { block: true, reason: `Blocked by brigadev guard: ${process.env[CHILD_ENV.AGENT] ?? "this agent"} is read-only.` };
			}
			const surfaces = childAllowedSurfaces();
			const rel = relative(root, absolute).split(sep).join("/");
			if (surfaces && !isWithinSurfaces(rel, surfaces)) {
				return {
					block: true,
					reason: `Blocked by brigadev guard: ${rel} is outside the allowed edit surfaces (${surfaces.join(", ")}). Stop and report status: interaction_required with the path you need.`,
				};
			}
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
