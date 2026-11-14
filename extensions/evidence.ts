/**
 * brigadev evidence recorder: appends every finished check command (tests,
 * lint, typecheck, build) to `<repo docs>/evidence/<branch>.jsonl`, keyed to
 * the worktree content tree it ran on. The guard's commit gate reads it.
 *
 * Loaded in the parent (package.json) and in every subagent (-e). Recording
 * never throws and never changes the tool result. Outside git nothing is
 * written.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBranchFacts } from "../lib/commit-branch.ts";
import { appendEvidence, checkKind, evidenceFile, runRecordFromResult, type ToolResultLike } from "../lib/evidence.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { CHILD_ENV } from "../lib/runtime.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";
import { worktreeTree } from "../lib/worktree-tree.ts";

export default function (pi: ExtensionAPI) {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);

	pi.on("tool_result", async (event, ctx) => {
		try {
			// Cheap test first: hashing the worktree only pays off for a check command.
			if (event.toolName !== "bash" || typeof event.input?.command !== "string" || checkKind(event.input.command) === undefined) return undefined;
			const tree = await worktreeTree(ctx.cwd);
			if (tree === undefined) return undefined;
			const branch = (await readBranchFacts(exec, ctx.cwd)).currentBranch;
			const record = runRecordFromResult(event as unknown as ToolResultLike, {
				ts: new Date().toISOString(),
				branch,
				tree,
				cwd: ctx.cwd,
				agent: process.env[CHILD_ENV.AGENT] || "parent",
			});
			if (record) appendEvidence(evidenceFile(repoDocsDir(ctx.cwd), branch), record);
		} catch {
			// Evidence is best effort: a failed write must not disturb the run.
		}
		return undefined;
	});
}
