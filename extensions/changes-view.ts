/**
 * brigadev Changes viewer (alt+g, /brigadev:changes): the working tree
 * against HEAD, untracked files included, in a full-screen two-pane view.
 * Left: changed files with status and line counts. Right: the diff.
 * Reflects git, not attribution: edits by agents, your editor, or the shell
 * all show up. Committed work disappears.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { boundDiff, countLines, DIFF_MAX_BYTES, diffLineTone, parseNumstat, parseStatus, statusTone, totals, untrackedAsDiff, withCounts, type ChangeEntry } from "../lib/git-changes.ts";
import { isChildSession } from "../lib/runtime.ts";
import { FULLSCREEN_OVERLAY, themePainter } from "../lib/tui-adapters.ts";
import { maxScroll, renderTwoPane, type Row } from "../lib/two-pane.ts";

const SHORTCUT = "alt+g";
const PAGE = 10;

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	const git = async (cwd: string, args: string[]) => {
		const result = await pi.exec("git", args, { cwd, timeout: 10_000 });
		return result.code === 0 ? result.stdout : undefined;
	};

	const loadEntries = async (cwd: string): Promise<{ root?: string; entries: ChangeEntry[]; error?: string }> => {
		const root = (await git(cwd, ["rev-parse", "--show-toplevel"]))?.trim();
		if (!root) return { entries: [], error: "Not a git repository." };
		const status = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		if (status === undefined) return { root, entries: [], error: "git status failed." };
		const hasHead = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"])) !== undefined;
		const numstat = (await git(root, hasHead ? ["diff", "--numstat", "-z", "-M", "HEAD"] : ["diff", "--numstat", "-z", "--cached"])) ?? "";
		const entries = withCounts(parseStatus(status), parseNumstat(numstat)).map((e) => {
			if (e.status !== "U") return e;
			try {
				const path = join(root, e.path);
				if (statSync(path).size > DIFF_MAX_BYTES) return e;
				return { ...e, added: countLines(readFileSync(path, "utf8")), deleted: 0 };
			} catch {
				return e;
			}
		});
		return { root, entries };
	};

	const loadDiff = async (root: string, entry: ChangeEntry): Promise<Row[]> => {
		if (entry.binary) return [{ text: "Binary file changed.", tone: "dim" }];
		let lines: string[];
		if (entry.status === "U") {
			try {
				const path = join(root, entry.path);
				if (statSync(path).size > DIFF_MAX_BYTES) return [{ text: "File too large to show (over 1 MiB).", tone: "dim" }];
				lines = untrackedAsDiff(entry.path, readFileSync(path, "utf8"));
			} catch (error) {
				return [{ text: `Cannot read ${entry.path}: ${(error as Error).message}`, tone: "error" }];
			}
		} else {
			const paths = entry.origPath ? [entry.origPath, entry.path] : [entry.path];
			const diff = await git(root, ["diff", "-M", "HEAD", "--", ...paths]);
			lines = diff ? boundDiff(diff) : ["No textual diff."];
		}
		return lines.map((text) => ({ text: text.replace(/\t/g, "    "), tone: diffLineTone(text) }));
	};

	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("/brigadev:changes needs the interactive UI", "error");
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const painter = themePainter(theme);
			let root: string | undefined;
			let entries: ChangeEntry[] = [];
			let error: string | undefined;
			let loading = true;
			let selected = 0;
			let scroll = 0;
			let detailOnly = false;
			const diffs = new Map<string, Row[]>();

			const showSelected = async () => {
				const entry = entries[selected];
				if (!entry || !root || diffs.has(entry.path)) return tui.requestRender();
				diffs.set(entry.path, [{ text: "loading…", tone: "dim" }]);
				tui.requestRender();
				diffs.set(entry.path, await loadDiff(root, entry));
				tui.requestRender();
			};

			const refresh = async () => {
				loading = true;
				tui.requestRender();
				const loaded = await loadEntries(ctx.cwd);
				[root, entries, error, loading] = [loaded.root, loaded.entries, loaded.error, false];
				diffs.clear();
				selected = Math.min(selected, Math.max(0, entries.length - 1));
				scroll = 0;
				await showSelected();
			};
			void refresh();

			const select = (index: number) => {
				const next = Math.max(0, Math.min(entries.length - 1, index));
				if (next === selected) return;
				[selected, scroll] = [next, 0];
				void showSelected();
			};

			return {
				invalidate() {},
				handleInput(data: string) {
					const bodyHeight = Math.max(1, tui.terminal.rows - 3);
					const detail = diffs.get(entries[selected]?.path ?? "") ?? [];
					if (matchesKey(data, Key.escape) || data === "q") return done();
					if (matchesKey(data, Key.down) || data === "j") select(selected + 1);
					else if (matchesKey(data, Key.up) || data === "k") select(selected - 1);
					else if (matchesKey(data, Key.pageDown) || data === " " || data === "J") scroll = Math.min(maxScroll(detail.length, bodyHeight), scroll + PAGE);
					else if (matchesKey(data, Key.pageUp) || data === "K") scroll = Math.max(0, scroll - PAGE);
					else if (data === "g") scroll = 0;
					else if (data === "G") scroll = maxScroll(detail.length, bodyHeight);
					else if (data === "F") detailOnly = !detailOnly;
					else if (data === "r") return void refresh();
					tui.requestRender();
				},
				render(width: number): string[] {
					const sum = totals(entries);
					const title = loading ? "Changes · loading…" : error ? `Changes · ${error}` : `Changes · ${sum.files} file${sum.files === 1 ? "" : "s"} · +${sum.added} −${sum.deleted}${root ? ` · ${root}` : ""}`;
					const list: Row[] = entries.map((e) => ({
						text: `${e.status} ${e.path}${e.binary ? " (binary)" : e.added !== undefined ? ` +${e.added} −${e.deleted ?? 0}` : ""}`,
						tone: statusTone(e.status),
					}));
					const entry = entries[selected];
					const detail: Row[] = entry ? [{ text: entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path, tone: "accent" }, ...(diffs.get(entry.path) ?? [])] : [];
					return renderTwoPane(
						{
							width,
							height: tui.terminal.rows,
							title,
							list,
							selected,
							detail,
							detailScroll: scroll,
							detailOnly,
							empty: loading ? "loading…" : "No uncommitted changes",
							footer: "j/k file · space/J/K scroll · g/G top/end · F diff only · r refresh · q close",
						},
						painter,
					);
				},
			};
		}, FULLSCREEN_OVERLAY);
	};

	pi.registerCommand("brigadev:changes", { description: "Browse uncommitted changes (working tree vs HEAD)", handler: async (_args, ctx) => open(ctx) });
	pi.registerShortcut(SHORTCUT, { description: "Open the brigadev Changes viewer", handler: async (ctx) => open(ctx) });
}
