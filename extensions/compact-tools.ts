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
import { resolveTidy } from "./tidy-bundled.ts";

function row(get: () => RowLine[], theme: Theme): Component {
	return {
		render: (width) => get().map((line) => theme.fg(line.tone, truncateToWidth(line.text, Math.max(1, width), "…"))),
		invalidate: () => {},
	};
}

const empty = (): Component => ({ render: () => [], invalidate: () => {} });

export default function (pi: ExtensionAPI) {
	const resolve = compactToolResolver<Component, Theme, ToolRenderers>({ row, empty });
	// pi.getSettings() throws while the extension loads, so the mode is decided on the first
	// resolve (after Pi binds the runtime) and kept until /reload. When pi-tidy owns the rows the
	// resolver stays registered and returns next() for every tool: that keeps the decision in one
	// pure place (lib/tidy-detect.ts) and lets ui.compactTools take effect without a registration race.
	let ours: boolean | undefined;
	const isOurs = (): boolean => {
		if (ours !== undefined) return ours;
		let packages: unknown[] | undefined;
		let settingsRead = false;
		try {
			packages = pi.getSettings().packages;
			settingsRead = true;
		} catch {}
		const decision = resolveTidy(packages).ours;
		// Cache only once the package list was readable; otherwise decide again on the next resolve.
		if (settingsRead) ours = decision;
		return decision;
	};
	pi.registerToolRenderer((toolName, next) => (isOurs() ? (resolve(toolName, next) as ToolRenderers | undefined) : next()));
}
