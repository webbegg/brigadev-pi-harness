/**
 * brigadev evidence recorder: appends every finished check command (tests,
 * lint, typecheck, build) to `<repo docs>/evidence/<branch>.jsonl`, keyed to
 * the worktree content tree it ran on. The guard's PR gate reads it.
 *
 * Loaded in the parent (package.json) and in every subagent (-e). Recording
 * never throws and never changes the tool result. Outside git nothing is
 * written.
 *
 * A run is keyed to a tree only if the tree was the same before and after it
 * (an edit made while the test ran must not be vouched for), so the tree is
 * taken when the call starts and again when its result arrives. Docs do not
 * count: each run also carries the tree of its non-doc paths.
 *
 * The run belongs to the repository of its effective directory, a leading
 * `cd <dir> &&` included (a session in a parent folder of nested repositories),
 * and to that repository's branch.
 *
 * A recognized test run whose output is piped (`node --test | tail -20`) gets
 * `set -o pipefail; ` in front before it runs, so its exit code is the
 * runner's and the outcome can be trusted. Pi's bash tool runs commands in
 * bash (or zsh), where `pipefail` exists; the prefix would be an error in a
 * plain POSIX `sh` such as dash, which Pi's bash tool does not use. When the
 * consumer closes early (`| head`) the runner can die of SIGPIPE: exit 141
 * under the injected prefix is recorded as `unknown`, not as a failure
 * (lib/evidence.ts `checkOutcome`).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readCurrentBranch } from "../lib/commit-branch.ts";
import { appendEvidence, checkDirectory, checkKind, evidenceFile, pipefailCommand, runRecordFromResult, settleRunTree, type ToolResultLike } from "../lib/evidence.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { CHILD_ENV } from "../lib/runtime.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";
import { worktreeTreeResult } from "../lib/worktree-tree.ts";

/** Trees of a repository's worktree: the full one and the one without docs; undefined without git or on a failure. */
const trees = async (dir: string) => {
	const result = await worktreeTreeResult(dir, { sourceTree: true });
	return result.kind === "tree" ? result : undefined;
};

export default function (pi: ExtensionAPI) {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	// What was known when each check command started, by tool call id.
	const before = new Map<string, { dir: string; tree?: string; srcTree?: string }>();
	// The command a call really ran, when pipefail was put in front of it.
	const injected = new Map<string, string>();

	pi.on("tool_call", async (event, ctx) => {
		try {
			// Cheap test first: hashing the worktree only pays off for a check command.
			if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
			const kind = checkKind(event.input.command);
			if (kind === undefined) return undefined;
			const dir = checkDirectory(event.input.command, ctx.cwd);
			const keyed = await trees(dir);
			before.set(event.toolCallId, { dir, tree: keyed?.tree, srcTree: keyed?.sourceTree });
			const prefixed = kind === "test" && event.input.command.includes("|") ? pipefailCommand(event.input.command, { cwd: ctx.cwd, topLevel: keyed?.root }) : undefined;
			if (prefixed) {
				event.input.command = prefixed;
				injected.set(event.toolCallId, prefixed);
			}
		} catch {
			// Without the tree before the run, the result is recorded as unknown.
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName !== "bash" || typeof event.input?.command !== "string") return undefined;
			// The result event may still carry the command as the model wrote it.
			const command = injected.get(event.toolCallId) ?? event.input.command;
			injected.delete(event.toolCallId);
			const started = before.get(event.toolCallId);
			before.delete(event.toolCallId);
			if (checkKind(command) === undefined) return undefined;
			const dir = started?.dir ?? checkDirectory(command, ctx.cwd);
			const after = await trees(dir);
			const settled = settleRunTree(started?.tree, after?.tree, started?.srcTree, after?.sourceTree);
			if (!settled.record) return undefined;
			const branch = await readCurrentBranch(exec, dir);
			const record = runRecordFromResult({ ...(event as unknown as ToolResultLike), input: { ...event.input, command } }, {
				ts: new Date().toISOString(),
				branch,
				tree: settled.tree,
				srcTree: settled.srcTree,
				note: settled.note,
				cwd: ctx.cwd,
				topLevel: after?.root,
				agent: process.env[CHILD_ENV.AGENT] || "parent",
			});
			if (record) appendEvidence(evidenceFile(repoDocsDir(dir), branch), record);
		} catch {
			// Evidence is best effort: a failed write must not disturb the run.
		}
		return undefined;
	});
}
