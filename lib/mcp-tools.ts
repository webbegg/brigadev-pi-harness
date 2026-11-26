// MCP tools that deliver or publish, classified like the git/gh commands they stand for, so the guard decides them with the
// same policy: opening a PR always asks and carries the PR gate, a merge is a publish, pushing files always asks, and PR or
// issue writes are ordinary deliveries. Tools are known by name (`mcp__<server>__<tool>`, Pi's MCP naming); servers seen:
// T3 Code (`t3-code`, and its `t3_code` alias) and GitHub's MCP server. An unknown tool is allowed, never guessed.

import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";

export interface McpToolMatch extends CommandMatch {
	/** The call opens a pull request: the PR gate runs on it, like on `gh pr create`. */
	opensPr?: true;
}

/** The server and tool of an MCP tool name, or undefined for a tool that is not one. */
export function mcpToolParts(toolName: string): { server: string; tool: string } | undefined {
	const match = /^mcp__([^_].*?)__([^_].*)$/.exec(toolName);
	return match ? { server: match[1], tool: match[2] } : undefined;
}

const OPENS_PR = new Set(["pull_request_create", "create_pull_request"]);
const MERGES = new Set(["pull_request_merge", "merge_pull_request"]);
/** Writes commits to a remote branch directly, like `git push`. */
const PUSHES = new Set(["push_files", "create_or_update_file", "delete_file"]);
/** Writes to a PR or an issue that others see, like `gh pr comment` or `gh issue create`. */
const WRITES = new Set([
	"pull_request_update",
	"pull_request_review",
	"pull_request_respond",
	"update_pull_request",
	"update_pull_request_branch",
	"create_pull_request_review",
	"create_and_submit_pull_request_review",
	"submit_pending_pull_request_review",
	"add_comment_to_pending_review",
	"add_issue_comment",
	"create_issue",
	"update_issue",
]);

/** The match for an MCP tool that delivers or publishes; undefined for any other tool. */
export function classifyMcpTool(toolName: string): McpToolMatch | undefined {
	const parts = mcpToolParts(toolName);
	if (!parts) return undefined;
	const reason = (what: string) => `${parts.tool} (MCP ${parts.server}) ${what}`;
	if (OPENS_PR.has(parts.tool)) return { kind: COMMAND_KIND.DELIVERY, reason: reason("pushes and opens a PR"), alwaysConfirm: true, opensPr: true };
	if (MERGES.has(parts.tool)) return { kind: COMMAND_KIND.PUBLISH, reason: reason("merges a PR") };
	if (PUSHES.has(parts.tool)) return { kind: COMMAND_KIND.DELIVERY, reason: reason("pushes to a remote branch"), alwaysConfirm: true };
	if (WRITES.has(parts.tool)) return { kind: COMMAND_KIND.DELIVERY, reason: reason("writes to a PR or issue") };
	return undefined;
}

/** The call's input as dialog text: indented JSON, clipped (the dialog shows it; the bus gets the guard's redacted subject). */
export function mcpInputPreview(input: unknown, max = 1500): string {
	let text: string;
	try {
		text = JSON.stringify(input ?? {}, null, 2) ?? String(input);
	} catch {
		text = String(input);
	}
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
