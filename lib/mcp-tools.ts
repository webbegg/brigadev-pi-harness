// MCP tools that deliver or publish, classified like the git/gh commands they stand for, so the guard decides them with the
// same policy: opening a PR always asks and carries the PR gate, a merge is a publish, pushing files always asks, and PR or
// issue writes are ordinary deliveries. Tools are known by name (`mcp__<server>__<tool>`, Pi's MCP naming); servers seen:
// T3 Code (`t3-code`, and its `t3_code` alias) and GitHub's MCP server. Any other tool is allowed, never guessed, except a
// name Pi cut to 64 characters (`…_<8 hex>`): it is read as the strictest known tool it could be.

import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";

export interface McpToolMatch extends CommandMatch {
	/** The call opens a pull request: the PR gate runs on it, like on `gh pr create`. */
	opensPr?: true;
}

/** Pi's longest tool name; a longer MCP name is cut and ends with `_` and 8 hex digits of a hash. */
const MAX_TOOL_NAME_LENGTH = 64;
const HASH_SUFFIX = /_[0-9a-f]{8}$/;

/** `createPullRequest`, `create-pull-request`, and `create_pull_request` are one name. */
const normalize = (name: string): string => name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().replace(/[^a-z0-9_]/g, "_");

/** The server and tool of an MCP tool name (the tool follows the last `__`), or undefined for a tool that is not one. */
export function mcpToolParts(toolName: string): { server: string; tool: string } | undefined {
	if (!toolName.startsWith("mcp__")) return undefined;
	const rest = toolName.slice("mcp__".length);
	const at = rest.lastIndexOf("__");
	if (at <= 0 || at + 2 >= rest.length) return undefined;
	return { server: rest.slice(0, at), tool: rest.slice(at + 2) };
}

type Rule = { tools: readonly string[]; match: (reason: (what: string) => string) => McpToolMatch };

/** Strictest first: a cut name takes the first rule one of its candidates falls under. */
const RULES: readonly Rule[] = [
	{ tools: ["pull_request_create", "create_pull_request"], match: (reason) => ({ kind: COMMAND_KIND.DELIVERY, reason: reason("pushes and opens a PR"), alwaysConfirm: true, opensPr: true }) },
	{ tools: ["pull_request_merge", "merge_pull_request"], match: (reason) => ({ kind: COMMAND_KIND.PUBLISH, reason: reason("merges a PR") }) },
	// Writes commits to a remote branch directly, like `git push`.
	{ tools: ["push_files", "create_or_update_file", "delete_file"], match: (reason) => ({ kind: COMMAND_KIND.DELIVERY, reason: reason("pushes to a remote branch"), alwaysConfirm: true }) },
	// Writes to a PR or an issue that others see, like `gh pr comment` or `gh issue create`.
	{
		tools: [
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
		],
		match: (reason) => ({ kind: COMMAND_KIND.DELIVERY, reason: reason("writes to a PR or issue") }),
	},
];

/** The match for an MCP tool that delivers or publishes; undefined for any other tool. */
export function classifyMcpTool(toolName: string): McpToolMatch | undefined {
	const name = normalize(toolName);
	const parts = mcpToolParts(name);
	if (!name.startsWith("mcp__")) return undefined;
	if (parts) {
		const rule = RULES.find((r) => r.tools.includes(parts.tool));
		// The reason names the server as written (`t3-code`), the tool as matched.
		if (rule) return rule.match((what) => `${parts.tool} (MCP ${mcpToolParts(toolName)?.server ?? parts.server}) ${what}`);
	}
	// Pi cut the name: the visible tail of the tool (or nothing, when the cut fell in the server name) may begin any known tool.
	if (toolName.length !== MAX_TOOL_NAME_LENGTH || !HASH_SUFFIX.test(name)) return undefined;
	const visible = name.slice(0, -9);
	const at = visible.lastIndexOf("__");
	const tail = at > "mcp".length ? visible.slice(at + 2) : "";
	const rule = RULES.find((r) => r.tools.some((tool) => tool.startsWith(tail)));
	if (!rule) return undefined;
	const could = rule.tools.filter((tool) => tool.startsWith(tail)).join(" or ");
	return rule.match((what) => `${toolName} (MCP name cut by Pi; it may be ${could}) ${what}`);
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
