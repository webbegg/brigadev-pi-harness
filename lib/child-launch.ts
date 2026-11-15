// How a subagent child process is launched: argv, environment, and stdio.
// One pure function for every launch (sync and async), so the S0 guarantee is
// stated in one place: a child never asks for permission and hangs. It runs
// Pi's RPC mode (`--mode rpc --no-session`, stdin piped so a running child can be
// steered), with the guard extension (which denies instead of confirming for
// children) and the evidence extension. RPC lets a child's extensions send UI
// requests and wait for an answer; lib/child-run.ts answers every one with the
// cancellation response (lib/child-rpc.ts), so no child waits for a person.
// The task is not an argument: the run loop sends it as the RPC `prompt` command.

import { CHILD_ENV, EVIDENCE_EXTENSION_PATH, GUARD_EXTENSION_PATH, STRUCTURED_OUTPUT_EXTENSION_PATH } from "./runtime.ts";
import { STRUCTURED_OUTPUT_TOOL } from "./structured-output.ts";

export interface ChildLaunchInput {
	agent: { name: string; writer: boolean; tools?: string[]; outputSchema?: string };
	allowedEditSurfaces?: string[];
	route: { model?: string; thinking?: string };
	/** True when the agent declares an output schema and it loaded; adds the structured output extension and tool. */
	structured?: boolean;
	/** Canonical working directory (one spelling of it, for PWD and the project root). */
	cwd: string;
	/** Temp file holding the agent's system prompt, when it has one. */
	systemPromptPath?: string;
	parentEnv: NodeJS.ProcessEnv;
}

export interface ChildLaunch {
	args: string[];
	env: NodeJS.ProcessEnv;
	stdio: ["pipe", "pipe", "pipe"];
}

export function childLaunch(input: ChildLaunchInput): ChildLaunch {
	const { agent, route } = input;
	const structured = Boolean(input.structured && agent.outputSchema);

	const args = ["--mode", "rpc", "--no-session", "-e", GUARD_EXTENSION_PATH, "-e", EVIDENCE_EXTENSION_PATH];
	if (structured) args.push("-e", STRUCTURED_OUTPUT_EXTENSION_PATH);
	if (route.model) args.push("--model", route.model);
	if (route.thinking) args.push("--thinking", route.thinking);
	if (agent.tools?.length) args.push("--tools", [...agent.tools, ...(structured ? [STRUCTURED_OUTPUT_TOOL] : [])].join(","));
	if (input.systemPromptPath) args.push("--append-system-prompt", input.systemPromptPath);

	const env: NodeJS.ProcessEnv = {
		...input.parentEnv,
		PWD: input.cwd,
		[CHILD_ENV.CHILD]: "1",
		[CHILD_ENV.AGENT]: agent.name,
		[CHILD_ENV.PROJECT_ROOT]: input.cwd,
		[CHILD_ENV.READ_ONLY]: agent.writer ? "0" : "1",
	};
	if (agent.writer && input.allowedEditSurfaces) env[CHILD_ENV.ALLOWED_SURFACES] = JSON.stringify(input.allowedEditSurfaces);
	else delete env[CHILD_ENV.ALLOWED_SURFACES];
	if (structured && agent.outputSchema) env[CHILD_ENV.OUTPUT_SCHEMA] = agent.outputSchema;
	else delete env[CHILD_ENV.OUTPUT_SCHEMA];

	return { args, env, stdio: ["pipe", "pipe", "pipe"] };
}
