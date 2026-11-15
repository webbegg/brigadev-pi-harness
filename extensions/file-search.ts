/**
 * `fd` (find files by name) and `rg` (search file contents) tools.
 *
 * Registered only when the binaries are already on the system PATH when the
 * extension loads: nothing is downloaded and nothing touches the network.
 * Arguments go as argv (no shell); the process runs in the project directory
 * with a time and output cap. Sensitive files never appear in results, and an
 * explicit sensitive path or a path outside the project is decided by the
 * same rule as `read` (lib/guard-rules.ts), inside the tool itself, so the
 * guard's tool_call handler does not need to know these tools.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { executeSearch, FD_DEFAULT_LIMIT, FD_MAX_DEPTH, FD_MAX_LIMIT, resolveOnPath, RG_DEFAULT_COUNT, RG_MAX_CONTEXT, RG_MAX_COUNT, type FdParams, type PathEnv, type RgParams, type SearchContext } from "../lib/file-search.ts";
import { canonicalPath } from "../lib/paths.ts";
import { CHILD_ENV, isChildSession } from "../lib/runtime.ts";

export interface FileSearchDeps {
	/** Where the binaries are looked up (default: the process environment). */
	env?: PathEnv;
}

const FD_PARAMETERS = Type.Object({
	pattern: Type.Optional(Type.String({ description: "Regex matched against file names (a glob when glob is true). Omit to list everything under path." })),
	path: Type.Optional(Type.String({ description: "Directory to search. Defaults to the current working directory." })),
	type: Type.Optional(Type.String({ description: "Only return entries of this type: file, directory, or symlink." })),
	extension: Type.Optional(Type.String({ description: "Only return files with this extension, e.g. 'ts'." })),
	glob: Type.Optional(Type.Boolean({ description: "Treat pattern as a glob (e.g. '*.test.ts') instead of a regex." })),
	hidden: Type.Optional(Type.Boolean({ description: "Include hidden files and directories. Defaults to false." })),
	max_depth: Type.Optional(Type.Number({ description: `Maximum directory depth to descend (1-${FD_MAX_DEPTH}).`, minimum: 1, maximum: FD_MAX_DEPTH })),
	limit: Type.Optional(Type.Number({ description: `Maximum number of results (1-${FD_MAX_LIMIT}). Defaults to ${FD_DEFAULT_LIMIT}.`, minimum: 1, maximum: FD_MAX_LIMIT })),
});

const RG_PARAMETERS = Type.Object({
	pattern: Type.String({ description: "Regex to search for (literal text when fixed_strings is true)." }),
	path: Type.Optional(Type.String({ description: "File or directory to search. Defaults to the current working directory." })),
	glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. '*.ts' or 'src/**'." })),
	file_type: Type.Optional(Type.String({ description: "Only search files of this ripgrep type, e.g. 'ts', 'py', 'rust'." })),
	case_sensitive: Type.Optional(Type.Boolean({ description: "true forces case-sensitive matching, false case-insensitive. Defaults to smart-case." })),
	fixed_strings: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string instead of a regex." })),
	hidden: Type.Optional(Type.Boolean({ description: "Search hidden files and directories. Defaults to false." })),
	context: Type.Optional(Type.Number({ description: `Lines of context around each match (0-${RG_MAX_CONTEXT}).`, minimum: 0, maximum: RG_MAX_CONTEXT })),
	limit: Type.Optional(Type.Number({ description: `Maximum matches per file (1-${RG_MAX_COUNT}). Defaults to ${RG_DEFAULT_COUNT}.`, minimum: 1, maximum: RG_MAX_COUNT })),
});

export function registerFileSearchTools(pi: ExtensionAPI, deps: FileSearchDeps = {}): void {
	const env = deps.env ?? process.env;
	const fd = resolveOnPath(["fd", "fdfind"], env);
	const rg = resolveOnPath(["rg"], env);

	const searchContext = (ctx: { cwd: string; hasUI?: boolean; ui: { confirm: (title: string, body: string) => Promise<boolean> } }, signal: AbortSignal | undefined): SearchContext => {
		const isChild = isChildSession();
		return {
			cwd: ctx.cwd,
			projectRoot: canonicalPath(process.env[CHILD_ENV.PROJECT_ROOT] ?? ctx.cwd),
			isChild,
			agent: process.env[CHILD_ENV.AGENT],
			// Without a UI (print mode, subagents) the answer is no.
			confirm: async (title, body) => (isChild || !ctx.hasUI ? false : ctx.ui.confirm(title, body)),
			signal,
		};
	};

	if (fd) {
		pi.registerTool({
			name: "fd",
			label: "Find Files",
			description: `Find files and directories by name with fd. Respects .gitignore. At most ${FD_DEFAULT_LIMIT} entries by default; output is capped and says when it was cut. Files that commonly hold secrets are never listed.`,
			promptSnippet: "Find files and directories by name with fd",
			promptGuidelines: ["Use fd instead of bash find or ls -R to discover files by name, extension, or glob; use rg to search file contents."],
			parameters: FD_PARAMETERS,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const output = await executeSearch("fd", fd, params as FdParams, searchContext(ctx, signal));
				return { content: [{ type: "text", text: output.text }], details: { matchCount: output.matchCount, truncated: output.truncated } };
			},
		});
	}

	if (rg) {
		pi.registerTool({
			name: "rg",
			label: "Search Content",
			description: `Search file contents with ripgrep. Smart-case, respects .gitignore, at most ${RG_DEFAULT_COUNT} matches per file by default; output is capped and says when it was cut. Files that commonly hold secrets are never searched.`,
			promptSnippet: "Search file contents with ripgrep",
			promptGuidelines: ["Use rg instead of bash grep to search file contents; use fd to find files by name.", "Set fixed_strings when searching for literal code containing regex metacharacters."],
			parameters: RG_PARAMETERS,
			async execute(_toolCallId, params, signal, _onUpdate, ctx) {
				const output = await executeSearch("rg", rg, params as RgParams, searchContext(ctx, signal));
				return { content: [{ type: "text", text: output.text }], details: { matchCount: output.matchCount, truncated: output.truncated } };
			},
		});
	}
}

export default function (pi: ExtensionAPI) {
	registerFileSearchTools(pi);
}
