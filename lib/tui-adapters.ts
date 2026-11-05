// Theme-backed Painter for the pure two-pane layout, plus the overlay options
// both full-screen viewers use.

import type { Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Painter } from "./two-pane.ts";

export function themePainter(theme: Theme): Painter {
	return {
		paint: (tone, text) => theme.fg(tone, text),
		bold: (text) => theme.bold(text),
		measure: visibleWidth,
		truncate: (text, width) => truncateToWidth(text, Math.max(0, width), ""),
	};
}

export const FULLSCREEN_OVERLAY = { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "top-left", margin: 0 } } as const;
