/**
 * brigadev background terminals (adapted from davi7's background-terminals): the model starts long-running shell
 * commands that do not block its turn, then looks at them and stops them.
 *
 * Tools: `bg_start` (command, optional cwd inside the project, optional name), `bg_status` (id), `bg_list`, `bg_kill` (id).
 * At most 8 run at once; stdin is ignored; each keeps a capped in-memory output tail. When one exits and the model has not
 * seen the exit (via `bg_status` / `bg_kill`), one message tells it, once, when the session is idle (lib/bg-delivery.ts).
 * `/brigadev:ps` opens an overlay with the processes and their output (x kills the selected one); the footer shows
 * `bg: N running` while any run.
 *
 * `bg_start` is decided by the guard exactly like `bash` (extensions/guard.ts, lib/guard-rules.ts `shellCallOf`): this file
 * never decides what may run. Parent session only: a subagent child registers nothing.
 */

import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, getShellConfig, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { BG_EXIT_MESSAGE_TYPE, createBgDelivery, type BgExitDetails } from "../lib/bg-delivery.ts";
import { BgError, createBgProcesses, shellEnvironment } from "../lib/bg-processes.ts";
import { detailWidth, killText, listText, psDetail, psFooter, psRows, psTitle, sanitizeOutput, startedText, statusLine, statusText } from "../lib/bg-view.ts";
import { installParentExitGuard } from "../lib/child-run.ts";
import { canonicalPath, expandHome } from "../lib/paths.ts";
import { isChildSession } from "../lib/runtime.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { maxScroll, renderTwoPane } from "../lib/two-pane.ts";

const STATUS_KEY = "brigadev-bg";
const PAGE = 10;
/** Lines of an exit notice the transcript card shows before it is expanded. */
const CARD_LINES = 8;

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	const manager = createBgProcesses({ shell: () => getShellConfig() });
	// A parent that exits without a session_shutdown (a crash handler, process.exit) still ends every process group.
	installParentExitGuard(manager.tracker);

	let parentCtx: ExtensionContext | undefined;
	let statusCtx: ExtensionContext | undefined;
	let lastStatus: string | undefined;

	// Footer status under its own key (not shell-bar's): `bg: N running`, cleared when none runs.
	const syncStatus = () => {
		if (!statusCtx) return;
		const text = statusLine(manager.runningCount());
		if (text === lastStatus) return;
		try {
			statusCtx.ui.setStatus(STATUS_KEY, text);
			lastStatus = text;
		} catch {
			// A stale context (session replaced): the new session sets its own status.
		}
	};

	// Idle delivery of exits the model has not seen. Pi API (docs/extensions.md): `pi.sendMessage(..., { triggerTurn: true,
	// deliverAs: "steer" })` starts a turn when idle; `ctx.isIdle()`; `agent_settled` is the final-idle signal. The same
	// choices as the async subagent delivery in extensions/subagents.ts.
	const delivery = createBgDelivery({
		isIdle: () => {
			try {
				return parentCtx?.isIdle() ?? false;
			} catch {
				return false; // a stale context (session replaced): treat as busy; session_start resets the buffer
			}
		},
		isConsumed: (id) => manager.isConsumed(id),
		markConsumed: (id) => manager.markConsumed(id),
		send: (message) => pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" }),
		onDeliveryFailed: (id) => {
			try {
				if (parentCtx?.hasUI) parentCtx.ui.notify(`brigadev: could not deliver the exit of background process ${id}; read it with bg_status ${id}`, "warning");
			} catch {
				// A stale context: nobody to tell.
			}
		},
	});
	manager.onSettled((snapshot, consumed) => {
		if (!consumed) delivery.settled(snapshot);
	});
	manager.subscribe((event) => {
		if (event === "state") syncStatus();
	});

	pi.on("session_start", async (_event, ctx) => {
		parentCtx = ctx;
		statusCtx = ctx.hasUI ? ctx : undefined;
		lastStatus = undefined;
		delivery.reset();
		manager.reset();
		syncStatus();
	});

	// Processes never outlive their session: SIGTERM, SIGKILL after 5 s, and the wait is bounded (about 7 s at most).
	pi.on("session_shutdown", async () => {
		// The processes settle after this; their exits must not be sent to a session that is going away.
		delivery.stop();
		await manager.shutdown();
	});

	// The parent is idle for good (not between retries or queued continuations): deliver what exited meanwhile.
	pi.on("agent_settled", async (_event, ctx) => {
		parentCtx = ctx;
		delivery.flush();
	});

	/** The variables Pi's bash tool sets from the session, so a background command sees what a foreground one does. */
	const sessionEnvironment = (ctx: ExtensionContext): Record<string, string | undefined> => {
		const env: Record<string, string | undefined> = {};
		try {
			const sessions = ctx.sessionManager as unknown as { getSessionId?: () => string; getSessionFile?: () => string | undefined };
			env.PI_SESSION_ID = sessions.getSessionId?.();
			env.PI_SESSION_FILE = sessions.getSessionFile?.();
			env.PI_PROVIDER = ctx.model?.provider;
			env.PI_MODEL = ctx.model?.id;
			env.PI_REASONING_LEVEL = ctx.thinkingLevel;
		} catch {
			// A stale context: the process starts without them.
		}
		return env;
	};

	const unknownId = (id: string) => new Error(`Unknown background process "${id}". Known: ${manager.list().map((s) => s.id).join(", ") || "none"}.`);
	const textResult = (text: string, details: Record<string, unknown>) => ({ content: [{ type: "text" as const, text }], details });

	pi.registerTool({
		name: "bg_start",
		label: "Start background process",
		description:
			"Start a long-running shell command (dev server, watcher, long build or test run) in the background and return at once. At most 8 run at once. Run servers in the foreground, not with `&`: work left running after the shell exits is stopped.",
		promptSnippet: "Start a long-running shell command in the background (bg_start), then bg_status / bg_list / bg_kill",
		promptGuidelines: [
			"Use bg_start for commands that keep running; use bash for quick ones. There is no stdin, so never start an interactive program.",
			"After bg_start, keep working instead of polling: one message arrives when it exits. Use bg_status only for its current output, and bg_kill what you no longer need.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "Shell command to run" }),
			cwd: Type.Optional(Type.String({ description: "Directory to run in, inside the project (relative to the session directory). Default: the session directory." })),
			name: Type.Optional(Type.String({ description: "Short label for listings (default: the start of the command)" })),
		}),
		async execute(_id, params, _signal, _onUpdate, ctx) {
			parentCtx = ctx;
			if (ctx.hasUI) statusCtx = ctx;
			// The same resolution the guard decided on (extensions/guard.ts), so the directory it approved is the one used.
			const cwd = params.cwd?.trim() ? canonicalPath(resolve(ctx.cwd, expandHome(params.cwd))) : ctx.cwd;
			let isDirectory = false;
			try {
				isDirectory = statSync(cwd).isDirectory();
			} catch {
				// Missing: reported below.
			}
			if (!isDirectory) throw new BgError(`cwd is not a directory: ${cwd}`);
			const snapshot = manager.start({
				command: params.command,
				cwd,
				name: params.name,
				env: shellEnvironment(process.env, { binDir: join(getAgentDir(), "bin"), session: sessionEnvironment(ctx) }),
			});
			return textResult(startedText(snapshot), { id: snapshot.id, name: snapshot.name, cwd: snapshot.cwd, pid: snapshot.pid });
		},
	});

	pi.registerTool({
		name: "bg_status",
		label: "Background process status",
		description: "State, exit code, and output tail of one background process. Asking about one that already exited tells you its outcome, so its exit message is not sent.",
		parameters: Type.Object({ id: Type.String({ description: "Process id, e.g. bg-1" }) }),
		async execute(_id, params) {
			const snapshot = manager.status(params.id);
			if (!snapshot) throw unknownId(params.id);
			return textResult(statusText(snapshot, Date.now()), { id: snapshot.id, state: snapshot.state, exitCode: snapshot.exitCode, signal: snapshot.signal, pid: snapshot.pid });
		},
	});

	pi.registerTool({
		name: "bg_list",
		label: "List background processes",
		description: "List this session's background processes and their state.",
		parameters: Type.Object({}),
		async execute() {
			const snapshots = manager.list();
			return textResult(listText(snapshots, Date.now()), { processes: snapshots.map((s) => ({ id: s.id, name: s.name, state: s.state, pid: s.pid })) });
		},
	});

	pi.registerTool({
		name: "bg_kill",
		label: "Kill background process",
		description: "Stop a background process and what it started (SIGTERM, then SIGKILL after 5 s); returns its final state and output tail.",
		parameters: Type.Object({ id: Type.String({ description: "Process id, e.g. bg-1" }) }),
		async execute(_id, params) {
			if (!manager.get(params.id)) throw unknownId(params.id);
			const snapshot = await manager.kill(params.id);
			if (!snapshot) throw unknownId(params.id);
			return textResult(killText(snapshot, Date.now()), { id: snapshot.id, state: snapshot.state, exitCode: snapshot.exitCode, signal: snapshot.signal });
		},
	});

	pi.registerMessageRenderer<BgExitDetails>(BG_EXIT_MESSAGE_TYPE, (message, { expanded }, theme) => {
		const content = typeof message.content === "string" ? message.content : message.content.map((c) => (c.type === "text" ? c.text : "")).join("\n");
		const lines = sanitizeOutput(content).split("\n");
		const [header, ...rest] = lines;
		const body = expanded ? rest : rest.slice(0, CARD_LINES);
		const hidden = rest.length - body.length;
		const failed = message.details?.failed === true;
		const text = [theme.fg(failed ? "error" : "success", theme.bold(header)), ...body.map((line) => theme.fg("dim", line)), ...(hidden > 0 ? [theme.fg("muted", `… ${hidden} more line${hidden === 1 ? "" : "s"} (expand to see them)`)] : [])].join("\n");
		return new Text(text, 0, 0);
	});

	// The overlay: processes on the left, the selected one's output on the right (lib/two-pane.ts, like the other viewers).
	const openOverlay = async (ctx: ExtensionContext) => {
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const painter = themePainter(theme);
			let selected = 0;
			let scroll = 0;
			let follow = true;
			let detailLength = 0;
			const bodyHeight = () => Math.max(1, tui.terminal.rows - 3);
			const unsubscribe = manager.subscribe(() => tui.requestRender());
			// The elapsed times tick.
			const ticker = setInterval(() => tui.requestRender(), 1000);
			ticker.unref?.();
			const close = () => {
				clearInterval(ticker);
				unsubscribe();
				done();
			};
			const select = (index: number) => {
				const next = Math.max(0, Math.min(manager.list().length - 1, index));
				if (next === selected) return;
				[selected, scroll, follow] = [next, 0, true];
			};

			return {
				invalidate() {},
				dispose() {
					clearInterval(ticker);
					unsubscribe();
				},
				handleInput(data: string) {
					const end = maxScroll(detailLength, bodyHeight());
					if (matchesKey(data, Key.escape) || data === "q") return close();
					if (matchesKey(data, Key.down) || data === "j") select(selected + 1);
					else if (matchesKey(data, Key.up) || data === "k") select(selected - 1);
					else if (matchesKey(data, Key.pageDown) || data === " " || data === "J") {
						scroll = Math.min(end, scroll + PAGE);
						follow = scroll >= end;
					} else if (matchesKey(data, Key.pageUp) || data === "K") {
						scroll = Math.max(0, scroll - PAGE);
						follow = false;
					} else if (data === "g") [scroll, follow] = [0, false];
					else if (data === "G") follow = true;
					else if (data === "x") {
						const target = manager.list()[selected];
						// The user's own kill: the model has not seen the exit, so it still hears of it once.
						if (target?.state === "running") void manager.kill(target.id, { seen: false });
					}
					tui.requestRender();
				},
				render(width: number): string[] {
					const list = manager.list();
					selected = Math.max(0, Math.min(selected, list.length - 1));
					const now = Date.now();
					const detail = list[selected] ? psDetail(list[selected], detailWidth(width), now) : [];
					detailLength = detail.length;
					const end = maxScroll(detail.length, bodyHeight());
					if (follow) scroll = end;
					scroll = Math.min(scroll, end);
					return renderTwoPane({ width, height: tui.terminal.rows, title: psTitle(list), list: psRows(list, now), selected, detail, detailScroll: scroll, footer: psFooter(), empty: "No background processes" }, painter);
				},
			};
		}, FULLSCREEN_OVERLAY);
	};

	pi.registerCommand("brigadev:ps", {
		description: "List background processes and their output; x kills the selected one",
		handler: async (_args, ctx) => {
			if (ctx.hasUI) statusCtx = ctx;
			const snapshots = manager.list();
			if (ctx.mode !== "tui") {
				if (ctx.hasUI) ctx.ui.notify(listText(snapshots, Date.now()), "info");
				return;
			}
			if (snapshots.length === 0) return ctx.ui.notify("No background processes yet. The agent starts them with bg_start.", "info");
			await openOverlay(ctx);
		},
	});
}
