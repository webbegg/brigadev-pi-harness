/**
 * brigadev side panel (alt+o, /brigadev:panel): Todos, Agents, Changes, and
 * Session in a right-anchored overlay that stays out of the way of typing.
 *
 * It is a non-capturing overlay, so it paints over the right 44 columns of
 * the transcript while open; a docked rail would need private Pi internals.
 * It shows only on terminals at least 140 columns wide. The open/closed
 * choice lasts for the session.
 *
 * Repaints come from three places only: store notifications from the todo,
 * subagent, and cost extensions, a throttled git refresh, and a one-second
 * tick while a subagent runs.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { countLines, parseNumstat, parseStatus, withCounts, type ChangeEntry } from "../lib/git-changes.ts";
import { fallbackState } from "../lib/fallback-state.ts";
import { MIN_TERMINAL_WIDTH, PANEL_WIDTH, renderPanel, type PanelPainter, type SessionInfo } from "../lib/panel-layout.ts";
import { panelState } from "../lib/panel-state.ts";
import { isPermissionMode, PERMISSION_MODE } from "../lib/permission-policy.ts";
import { effectiveProfile, readProfiles } from "../lib/profiles-store.ts";
import { isChildSession, readSettings } from "../lib/runtime.ts";
import { themePainter } from "../lib/tui-adapters.ts";
import { formatUsage, usageTone } from "../lib/usage-windows.ts";

const SHORTCUT = "alt+o";
const MODE_ENTRY = "brigadev-mode";
const GIT_REFRESH_MS = 2000;
const FILE_TOOLS = new Set(["edit", "write", "bash"]);
/** Rows under the panel left for the editor and the footer. */
const RESERVED_ROWS = 6;
/** New files are counted line by line only up to these bounds. */
const UNTRACKED_COUNT_LIMIT = 40;
const UNTRACKED_MAX_BYTES = 256 * 1024;

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	// Set while the overlay exists; calling it closes the panel.
	let closeOverlay: (() => void) | undefined;
	// Asks the open panel to repaint.
	let repaint: (() => void) | undefined;

	let changes: ChangeEntry[] | undefined;
	let lastGitRefresh = 0;
	let gitBusy = false;
	let gitAgain = false;
	let gitRoot: { cwd: string; root: string | undefined } | undefined;

	// Session facts change on events, not on every render, so they are read here and cached.
	let session: Omit<SessionInfo, "cost"> = {};

	const git = async (cwd: string, args: string[]) => {
		const result = await pi.exec("git", args, { cwd, timeout: 5000 }).catch(() => undefined);
		return result && result.code === 0 ? result.stdout : undefined;
	};

	const loadChanges = async (cwd: string): Promise<ChangeEntry[] | undefined> => {
		if (gitRoot?.cwd !== cwd) gitRoot = { cwd, root: (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim() || undefined };
		const root = gitRoot.root;
		if (!root) return undefined;
		const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		if (status === undefined) return undefined;
		const numstat = (await git(root, ["diff", "--numstat", "-z", "-M", "HEAD"])) ?? (await git(root, ["diff", "--numstat", "-z", "--cached"])) ?? "";
		let counted = 0;
		return withCounts(parseStatus(status), parseNumstat(numstat)).map((entry) => {
			if (entry.status !== "U" || counted >= UNTRACKED_COUNT_LIMIT) return entry;
			counted++;
			try {
				const path = join(root, entry.path);
				if (statSync(path).size > UNTRACKED_MAX_BYTES) return entry;
				return { ...entry, added: countLines(readFileSync(path, "utf8")), deleted: 0 };
			} catch {
				return entry;
			}
		});
	};

	const refreshGit = async (ctx: ExtensionContext, force = false) => {
		if (!closeOverlay) return;
		const now = Date.now();
		if (!force && now - lastGitRefresh < GIT_REFRESH_MS) return;
		if (gitBusy) {
			gitAgain = true;
			return;
		}
		gitBusy = true;
		lastGitRefresh = now;
		try {
			const next = await loadChanges(ctx.cwd);
			if (JSON.stringify(next) !== JSON.stringify(changes)) {
				changes = next;
				repaint?.();
			}
		} finally {
			gitBusy = false;
			if (gitAgain) {
				gitAgain = false;
				void refreshGit(ctx, true);
			}
		}
	};

	const refreshSession = (ctx: ExtensionContext) => {
		if (!closeOverlay) return;
		// Same source as the guard: the latest mode entry on the branch, else the saved default.
		let mode: unknown = readSettings().defaultMode;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MODE_ENTRY) mode = (entry.data as { mode?: unknown } | undefined)?.mode;
		}
		const provider = ctx.model?.provider;
		const snapshot = provider ? fallbackState().usage.get(provider) : undefined;
		const hasUsage = !!snapshot && snapshot.windows.length + (snapshot.status === "rejected" ? 1 : 0) > 0;
		session = {
			model: ctx.model?.id,
			thinking: ctx.model ? pi.getThinkingLevel() : undefined,
			contextPercent: ctx.getContextUsage()?.percent,
			usage: snapshot && hasUsage ? { text: formatUsage(snapshot), tone: usageTone(snapshot) } : undefined,
			profile: effectiveProfile(readProfiles().file, ctx.sessionManager.getBranch()).name,
			yolo: isPermissionMode(mode) && mode === PERMISSION_MODE.YOLO,
		};
		repaint?.();
	};

	const open = (ctx: ExtensionContext) => {
		if (closeOverlay) return;
		let terminalRows = () => 40;
		// The overlay lives until done() is called, so the promise is deliberately not awaited.
		ctx.ui
			.custom<void>(
				(tui, theme, _kb, done) => {
					const store = panelState();
					const painter: PanelPainter = { ...themePainter(theme), fill: (line) => theme.bg("customMessageBg", line) };
					terminalRows = () => tui.terminal.rows;
					let ticker: ReturnType<typeof setInterval> | undefined;

					// Tick the elapsed column only while a subagent is running.
					const syncTicker = () => {
						const running = (store.read("agents") ?? []).some((r) => r.state === "running");
						if (running && !ticker) {
							ticker = setInterval(() => tui.requestRender(), 1000);
							ticker.unref?.();
						} else if (!running && ticker) {
							clearInterval(ticker);
							ticker = undefined;
						}
					};
					const unsubscribe = store.subscribe((section) => {
						if (section === "agents") syncTicker();
						tui.requestRender();
					});
					repaint = () => tui.requestRender();
					closeOverlay = () => done();
					syncTicker();

					return {
						dispose() {
							unsubscribe();
							if (ticker) clearInterval(ticker);
							ticker = undefined;
							repaint = undefined;
							closeOverlay = undefined;
						},
						invalidate() {},
						render(width: number): string[] {
							return renderPanel(
								{
									width,
									height: Math.max(4, tui.terminal.rows - RESERVED_ROWS),
									now: Date.now(),
									todos: store.read("todos") ?? [],
									runs: store.read("agents") ?? [],
									changes,
									session: { ...session, cost: store.read("cost") },
								},
								painter,
							);
						},
					};
				},
				{
					overlay: true,
					overlayOptions: () => ({
						width: PANEL_WIDTH,
						maxHeight: Math.max(4, terminalRows() - RESERVED_ROWS),
						anchor: "top-right",
						offsetY: 1,
						nonCapturing: true,
						visible: (termWidth: number) => termWidth >= MIN_TERMINAL_WIDTH,
					}),
				},
			)
			.catch((error: unknown) => {
				closeOverlay = undefined;
				repaint = undefined;
				ctx.ui.notify(`Could not open the panel: ${error instanceof Error ? error.message : String(error)}`, "error");
			});
		refreshSession(ctx);
		void refreshGit(ctx, true);
	};

	const toggle = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("/brigadev:panel needs the interactive UI", "error");
		if (closeOverlay) return closeOverlay();
		// Stay open on a narrow terminal: the overlay shows itself once the terminal widens.
		const columns = process.stdout.columns;
		if (columns !== undefined && columns < MIN_TERMINAL_WIDTH) ctx.ui.notify(`The panel needs a terminal at least ${MIN_TERMINAL_WIDTH} columns wide`, "warning");
		open(ctx);
	};

	pi.registerCommand("brigadev:panel", { description: "Toggle the side panel: todos, agents, changes, session", handler: async (_args, ctx) => toggle(ctx) });
	pi.registerShortcut(SHORTCUT, { description: "Toggle the brigadev side panel", handler: async (ctx) => toggle(ctx) });

	pi.on("session_start", async (_event, ctx) => refreshSession(ctx));
	pi.on("session_tree", async (_event, ctx) => refreshSession(ctx));
	pi.on("session_compact", async (_event, ctx) => refreshSession(ctx));
	pi.on("model_select", async (_event, ctx) => refreshSession(ctx));
	pi.on("thinking_level_select", async (_event, ctx) => refreshSession(ctx));
	pi.on("turn_end", async (_event, ctx) => refreshSession(ctx));
	pi.on("agent_end", async (_event, ctx) => {
		refreshSession(ctx);
		await refreshGit(ctx, true);
	});
	pi.on("tool_execution_end", async (event, ctx) => {
		if (FILE_TOOLS.has(event.toolName)) await refreshGit(ctx);
	});
	pi.on("session_shutdown", async () => closeOverlay?.());
}
