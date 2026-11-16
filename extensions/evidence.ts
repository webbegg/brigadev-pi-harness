/**
 * brigadev evidence recorder: appends every finished check command (tests,
 * lint, typecheck, build) to `<repo docs>/evidence/<branch>.jsonl`, keyed to
 * the worktree content tree it ran on. The guard's commit gate reads it.
 *
 * Loaded in the parent (package.json) and in every subagent (-e). Recording
 * never throws and never changes the tool result. Outside git nothing is
 * written.
 *
 * A run is keyed to a tree only if the tree was the same before and after it
 * (an edit made while the test ran must not be vouched for), so the tree is
 * taken when the call starts and again when its result arrives.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readBranchFacts } from "../lib/commit-branch.ts";
import { stripLockPrelude } from "../lib/dsp-credlock.ts";
import { appendEvidence, checkKind, evidenceFile, runRecordFromResult, settleRunTree, type ToolResultLike } from "../lib/evidence.ts";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { CHILD_ENV } from "../lib/runtime.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";
import { worktreeTree } from "../lib/worktree-tree.ts";

export default function (pi: ExtensionAPI) {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	// Tree before each running check command, by tool call id (undefined: no git).
	const treeBefore = new Map<string, string | undefined>();

	pi.on("tool_call", async (event, ctx) => {
		try {
			// Cheap test first: hashing the worktree only pays off for a check command.
			if (event.toolName !== "bash" || typeof event.input?.command !== "string" || checkKind(stripLockPrelude(event.input.command)) === undefined) return undefined;
			treeBefore.set(event.toolCallId, await worktreeTree(ctx.cwd));
		} catch {
			// Without the tree before the run, the result is recorded as unknown.
		}
		return undefined;
	});

	pi.on("tool_result", async (event, ctx) => {
		try {
			if (event.toolName !== "bash" || typeof event.input?.command !== "string" || checkKind(stripLockPrelude(event.input.command)) === undefined) return undefined;
			const before = treeBefore.get(event.toolCallId);
			treeBefore.delete(event.toolCallId);
			const settled = settleRunTree(before, await worktreeTree(ctx.cwd));
			if (!settled.record) return undefined;
			const branch = (await readBranchFacts(exec, ctx.cwd)).currentBranch;
			const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: ctx.cwd, timeout: 15_000 });
			const record = runRecordFromResult(event as unknown as ToolResultLike, {
				ts: new Date().toISOString(),
				branch,
				tree: settled.tree,
				note: settled.note,
				cwd: ctx.cwd,
				topLevel: top.code === 0 ? top.stdout.trim() || undefined : undefined,
				agent: process.env[CHILD_ENV.AGENT] || "parent",
			});
			if (record) appendEvidence(evidenceFile(repoDocsDir(ctx.cwd), branch), record);
		} catch {
			// Evidence is best effort: a failed write must not disturb the run.
		}
		return undefined;
	});
}
