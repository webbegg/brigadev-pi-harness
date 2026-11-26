/**
 * brigadev retro: /brigadev:retro <runId> closes one subagent run with its outcome.
 *
 *   success  nothing to write
 *   flawed   drafts an eval case, written to evals/<agent>/<runId>/case.json only after a confirm
 *   blocked  drafts the "what was missing" line into the editor
 *   manual   a deliberate human step: nothing to write
 *
 * A user command only: no tools, no hooks, no prompt text. Without a UI it prints the draft and writes nothing.
 */

import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { parseCase } from "../lib/evals.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { repoDocsDir } from "../lib/repo-docs.ts";
import { blockedLine, draftEvalCase, OUTCOMES, readRun, runIdProblem, type Outcome } from "../lib/retro.ts";
import { isChildSession } from "../lib/runtime.ts";

/** True when `target`, through its nearest existing folder with every symlink resolved, stays inside `root`. */
function staysInside(target: string, root: string): boolean {
	let existing = dirname(target);
	while (!existsSync(existing) && dirname(existing) !== existing) existing = dirname(existing);
	try {
		const rel = relative(realpathSync(root), realpathSync(existing));
		return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
	} catch {
		return false;
	}
}

/** Why a draft must not be written, or undefined: it has to load as an eval case. */
function draftProblem(text: string): string | undefined {
	try {
		const parsed = parseCase(JSON.parse(text));
		return parsed.ok ? undefined : parsed.errors.join("; ");
	} catch (err) {
		return err instanceof Error ? err.message : String(err);
	}
}

const USAGE = "Usage: /brigadev:retro <runId>  (a folder name under the repo docs runs/; /brigadev:runs shows the ids)";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	/** The checkout's top level, where evals/ lives; the cwd outside git. */
	const projectRoot = async (cwd: string): Promise<string> => {
		try {
			const result = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
			return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : cwd;
		} catch {
			return cwd;
		}
	};

	pi.registerCommand("brigadev:retro", {
		description: "Close a subagent run with its outcome (success, flawed, blocked, manual); flawed drafts an eval case. Args: <runId>",
		handler: async (args, ctx) => {
			const runId = args.trim();
			const problem = runIdProblem(runId);
			if (problem) return ctx.ui.notify(`${problem}\n${USAGE}`, "warning");
			const read = readRun(repoDocsDir(ctx.cwd), runId);
			if (!read.ok) return ctx.ui.notify(read.error, "warning");
			const { run } = read;
			const draft = draftEvalCase(run);
			const root = await projectRoot(ctx.cwd);
			const target = join(root, draft.path);

			if (!ctx.hasUI) return ctx.ui.notify(`brigadev retro: no UI, nothing written. Eval case draft for ${draft.path}:\n${draft.text}`, "info");

			const outcome = (await ctx.ui.select(`Outcome of ${run.agent} run ${runId}`, [...OUTCOMES])) as Outcome | undefined;
			if (outcome === "flawed") {
				const invalid = draftProblem(draft.text);
				if (invalid) return ctx.ui.notify(`The draft is not a valid eval case (${invalid}); nothing written.\n${draft.text}`, "warning");
				if (!staysInside(target, root)) return ctx.ui.notify(`${target} leads outside the project (a symlinked evals folder?); nothing written.`, "warning");
				if (existsSync(target)) return ctx.ui.notify(`${target} already exists; nothing written.`, "warning");
				if (!(await ctx.ui.confirm("brigadev: write this eval case?", `${target}\n\n${draft.text}`))) return ctx.ui.notify("Eval case not written.", "info");
				mkdirSync(dirname(target), { recursive: true });
				// Checked again after the folders exist (a link made meanwhile), and `wx` never overwrites.
				if (!staysInside(target, root)) return ctx.ui.notify(`${target} leads outside the project; nothing written.`, "warning");
				writeFileSync(target, draft.text, { encoding: "utf8", flag: "wx" });
				return ctx.ui.notify(`Wrote ${target}. Add a fixture and turn the expect skeleton into the right result, then run npm run eval -- ${run.agent}.`, "info");
			}
			if (outcome === "blocked") {
				const line = blockedLine(run);
				ctx.ui.setEditorText(line);
				return ctx.ui.notify(`Drafted in the editor: ${line}`, "info");
			}
			if (outcome === "manual") return ctx.ui.notify("manual: a deliberate human step; nothing to write.", "info");
			if (outcome === "success") return ctx.ui.notify("success: nothing to write.", "info");
		},
	});
}
