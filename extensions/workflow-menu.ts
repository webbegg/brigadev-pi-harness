/**
 * brigadev workflow menu (alt+w, /brigadev:start): pick a day-to-day workflow,
 * answer the questions it declares, review the composed request, and hand it
 * to the orchestrator. `/brigadev:start <name, file id, or key>` skips the list
 * (the launch dashboard uses it, with the name, which is unique). Workflows are files (assets/workflows/, plus the user's
 * own in ~/.brigadev/workflows/ and ~/.brigadev/<repo>/workflows/). The dialogs
 * are select/input/editor, so the menu works in the TUI and over RPC.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { isChildSession, PACKAGE_WORKFLOWS_DIR } from "../lib/runtime.ts";
import { askQuestions, composeRequest, gatherFacts, type Answers } from "../lib/workflow-run.ts";
import { loadWorkflows, resolveWorkflow, workflowDirs, type Workflow } from "../lib/workflows.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";

const SHORTCUT = "alt+w";
const COMMAND = "brigadev:start";
const START = "Start";
const EDIT = "Edit answers";
const CANCEL = "Cancel";

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);

	const open = async (ctx: ExtensionContext, query = "") => {
		if (!ctx.hasUI) return;
		const { workflows, warning } = loadWorkflows((content) => parseFrontmatter<Record<string, unknown>>(content), { packageDir: PACKAGE_WORKFLOWS_DIR, ...workflowDirs(ctx.cwd) });
		if (warning) ctx.ui.notify(warning, "warning");
		if (!workflows.length) return ctx.ui.notify("brigadev: no workflows found", "error");

		let workflow: Workflow | undefined;
		if (query.trim()) {
			try {
				workflow = resolveWorkflow(workflows, query);
			} catch (error) {
				return ctx.ui.notify(`brigadev: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		} else {
			const labels = workflows.map((candidate) => `${candidate.name} — ${candidate.description}`);
			const picked = await ctx.ui.select("Start a workflow", labels);
			workflow = picked === undefined ? undefined : workflows[labels.indexOf(picked)];
		}
		if (!workflow) return;

		const facts = await gatherFacts(exec, ctx.cwd);
		let answers: Answers | undefined = await askQuestions(workflow, facts, ctx.ui);
		while (answers) {
			let request: string;
			try {
				request = composeRequest(workflow, answers, facts);
			} catch (error) {
				return ctx.ui.notify(`brigadev: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
			const choice = await ctx.ui.select(`${workflow.name}: send this request?\n\n${request}`, [START, EDIT, CANCEL]);
			if (choice === START) {
				// sendUserMessage returns void; only expandPromptTemplates makes pi treat the text like typed input.
				try {
					pi.sendUserMessage(request, { expandPromptTemplates: true });
				} catch (error) {
					ctx.ui.notify(`Could not start ${workflow.name}: ${error instanceof Error ? error.message : String(error)}`, "error");
				}
				return;
			}
			if (choice !== EDIT) break;
			answers = await askQuestions(workflow, facts, ctx.ui, answers);
		}
		ctx.ui.notify(`${workflow.name}: cancelled, nothing sent`, "info");
	};

	pi.registerCommand(COMMAND, { description: "Start a day-to-day workflow: pick one (or name it: /brigadev:start bug-fix, /brigadev:start b), answer its questions, send the request", handler: async (args, ctx) => open(ctx, args) });
	pi.registerShortcut(SHORTCUT, { description: "Open the brigadev workflow menu", handler: async (ctx) => open(ctx) });
}
