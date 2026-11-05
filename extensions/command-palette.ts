/**
 * brigadev command palette (alt+k, /brigadev:commands): a searchable list of
 * every registered brigadev command and prompt template with its description. Type to filter,
 * up/down to move, Enter to close the palette and run the selected command.
 */

import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { clampSelection, commandLine, filterEntries, moveSelection, normalizeEntries, PALETTE_COMMAND, type PaletteEntry } from "../lib/command-palette.ts";
import { canonicalPath, isInside } from "../lib/paths.ts";
import { isChildSession } from "../lib/runtime.ts";
import { FULLSCREEN_OVERLAY } from "../lib/tui-adapters.ts";
import { windowStart } from "../lib/two-pane.ts";

const SHORTCUT = "alt+k";
const PROMPTS_DIR = canonicalPath(fileURLToPath(new URL("../prompts", import.meta.url)));
const isOwnPrompt = (sourcePath: string) => isInside(PROMPTS_DIR, canonicalPath(sourcePath));

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	const open = async (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return ctx.ui.notify("/brigadev:commands needs the interactive UI", "error");
		const all = normalizeEntries(pi.getCommands(), isOwnPrompt);

		const chosen = await ctx.ui.custom<PaletteEntry | undefined>((tui, theme, _kb, done) => {
			let query = "";
			let selected = 0;
			let shown = filterEntries(all, query);

			const setQuery = (next: string) => {
				query = next;
				shown = filterEntries(all, query);
				selected = 0;
			};

			return {
				invalidate() {},
				handleInput(data: string) {
					if (matchesKey(data, Key.escape)) return done(undefined);
					if (matchesKey(data, Key.enter)) return done(shown[selected]);
					if (matchesKey(data, Key.down) || matchesKey(data, "ctrl+n")) selected = moveSelection(selected, 1, shown.length);
					else if (matchesKey(data, Key.up) || matchesKey(data, "ctrl+p")) selected = moveSelection(selected, -1, shown.length);
					else if (matchesKey(data, Key.backspace)) setQuery(query.slice(0, -1));
					else if (data.length > 0 && !/[\u0000-\u001f\u007f]/.test(data)) setQuery(query + data);
					selected = clampSelection(selected, shown.length);
					tui.requestRender();
				},
				render(width: number): string[] {
					const height = tui.terminal.rows;
					const bodyHeight = Math.max(1, height - 3);
					const start = windowStart(selected, shown.length, bodyHeight);
					const fit = (text: string) => truncateToWidth(text, Math.max(0, width), "");
					const lines = [fit(theme.bold(theme.fg("accent", ` Commands · ${shown.length}/${all.length}`))), fit(` > ${query}`)];
					for (let i = 0; i < bodyHeight; i++) {
						const entry = shown[start + i];
						if (!entry) {
							lines.push("");
							continue;
						}
						const text = ` ${entry.name}${entry.description ? ` — ${entry.description}` : ""}`;
						lines.push(fit(start + i === selected ? theme.bold(theme.fg("accent", `›${text.slice(1)}`)) : theme.fg("text", text)));
					}
					if (!shown.length) lines[2] = fit(theme.fg("dim", " No matching commands"));
					lines.push(fit(theme.fg("dim", " type to search · ↑/↓ move · enter run · esc close")));
					return lines;
				},
			};
		}, FULLSCREEN_OVERLAY);

		// The palette is closed by now. sendUserMessage returns void; only expandPromptTemplates makes pi run the text as a command.
		if (!chosen) return;
		try {
			pi.sendUserMessage(commandLine(chosen), { expandPromptTemplates: true });
		} catch (error) {
			ctx.ui.notify(`Could not run ${chosen.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
		}
	};

	pi.registerCommand(PALETTE_COMMAND, { description: "Search and run brigadev commands", handler: async (_args, ctx) => open(ctx) });
	pi.registerShortcut(SHORTCUT, { description: "Open the brigadev command palette", handler: async (ctx) => open(ctx) });
}
