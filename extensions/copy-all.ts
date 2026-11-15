/**
 * /brigadev:copy-all: copy the current branch's user and assistant message text to the system clipboard
 * (macOS pbcopy; Linux wl-copy, xclip, xsel; Windows clip), spawned without a shell. Parent session only.
 * Adapted from davi7 `copy-all`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { copyToClipboard, type ClipboardDeps } from "../lib/clipboard.ts";
import { collectConversation } from "../lib/copy-all.ts";
import { isChildSession } from "../lib/runtime.ts";

// `deps` is for tests (an injected clipboard runner); Pi calls the extension with `pi` only.
export default function (pi: ExtensionAPI, deps: ClipboardDeps = {}) {
	if (isChildSession()) return;

	pi.registerCommand("brigadev:copy-all", {
		description: "Copy this thread's user and assistant messages to the clipboard",
		handler: async (_args, ctx) => {
			const say = (message: string, type: "info" | "error") => {
				if (ctx.hasUI) ctx.ui.notify(message, type);
			};
			const { text, count } = collectConversation(ctx.sessionManager.getBranch());
			if (count === 0) return say("No user or assistant messages to copy", "info");
			const result = await copyToClipboard(text, deps);
			if (!result.ok) return say(`Could not copy to the clipboard: ${result.error}`, "error");
			say(`Copied ${count} message${count === 1 ? "" : "s"} to the clipboard`, "info");
		},
	});
}
