/**
 * brigadev context backstop: once measured context reaches the handoff
 * threshold, appends one notice to the next tool result. Re-armed after
 * compaction. Parent session only.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContextBackstop } from "../lib/context-backstop.ts";
import { isChildSession } from "../lib/runtime.ts";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	const backstop = createContextBackstop();

	pi.on("session_start", async () => backstop.rearm());
	pi.on("session_tree", async () => backstop.rearm());
	pi.on("session_compact", async () => backstop.rearm());

	pi.on("tool_result", async (event, ctx) => {
		const notice = backstop.check(ctx.getContextUsage());
		if (!notice) return undefined;
		return { content: [...event.content, { type: "text" as const, text: notice }] };
	});
}
