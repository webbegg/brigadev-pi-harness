/**
 * brigadev compact tools: one-line rows for Pi's built-in tools.
 *
 * Collapsed, read/grep/find/ls/bash/edit/write show one row (live timer while
 * running, a final line when done, header plus a few lines on error). Expanded
 * (Ctrl+O) delegates to the renderer next() returns, so full output stays one
 * keypress away. Presentation only: the tools and their results are untouched.
 */

import type { ExtensionAPI, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { compactToolResolver, type RowLine } from "../lib/compact-tools.ts";
import { readSettings } from "../lib/runtime.ts";

function row(get: () => RowLine[], theme: Theme): Component {
	return {
		render: (width) => get().map((line) => theme.fg(line.tone, truncateToWidth(line.text, Math.max(1, width), "…"))),
		invalidate: () => {},
	};
}

const empty = (): Component => ({ render: () => [], invalidate: () => {} });

export default function (pi: ExtensionAPI) {
	const resolve = compactToolResolver<Component, Theme, ToolRenderers>({ row, empty });
	// The only tool-row renderer. {"ui": {"compactTools": false}} in brigadev.json turns it off; read once, kept until /reload.
	let off: boolean | undefined;
	pi.registerToolRenderer((toolName, next) => {
		off ??= readSettings().ui?.compactTools === false;
		return off ? next() : (resolve(toolName, next) as ToolRenderers | undefined);
	});
}
