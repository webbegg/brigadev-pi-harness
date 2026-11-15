// What `/brigadev:copy-all` copies: the user and assistant text of the current branch, in order, each message under a
// role header. Pure: no Pi imports; entries are read structurally (`{ type: "message", message: { role, content } }`),
// so session entries of any other kind (custom entries, compaction, tool results) are ignored.
// Adapted from davi7 `copy-all`, minus the `[image]` placeholder: only text parts are copied.

/** Between two messages. */
export const MESSAGE_SEPARATOR = "\n\n---\n\n";

const ROLES = new Set(["user", "assistant"]);

/** The text of a message's content: a string as is, else its `text` parts joined by newlines (thinking, tool calls and images are left out). */
function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (part && typeof part === "object" && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string" ? [(part as { text: string }).text] : []))
		.join("\n");
}

/** The copyable text of `branch` (`ctx.sessionManager.getBranch()`) and how many messages it holds. */
export function collectConversation(branch: readonly unknown[]): { text: string; count: number } {
	const sections: string[] = [];
	for (const entry of branch) {
		if (!entry || typeof entry !== "object" || (entry as { type?: unknown }).type !== "message") continue;
		const message = (entry as { message?: { role?: unknown; content?: unknown } }).message;
		if (!message || typeof message.role !== "string" || !ROLES.has(message.role)) continue;
		const text = textOf(message.content).trim();
		if (text) sections.push(`${message.role.toUpperCase()}:\n${text}`);
	}
	return { text: sections.join(MESSAGE_SEPARATOR), count: sections.length };
}
