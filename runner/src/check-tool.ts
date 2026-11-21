// S5: the worker's `check` tool, over lib/check.ts exactly as extensions/check.ts uses it: the same parameters, the same command
// resolution (brigadev.json `check.test`, else detection), the same refusal, the same compact result, and the run is appended
// to the same evidence file (<docs>/evidence/<branch>.jsonl) so the commit gate (and the Pi extension) trust it. Agent: runner-worker.
import { defineTool } from "@earendil-works/pi-durable";
import type { JsonValue } from "@earendil-works/chord/json";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { readSettings, type BrigadevSettings } from "../../lib/runtime.ts";
import type { ExecFn } from "../../lib/worktree-snapshot.ts";
import { runContainedCheck } from "./check-run.ts";
import { defaultContainedEnv } from "./contain.ts";
import { nodeExec } from "./exec.ts";
import { RUNNER_AGENT } from "./guard.ts";

export interface CheckToolOptions {
	/** The worktree, used when the conversation has no cwd of its own. */
	cwd: string;
	exec?: ExecFn;
	/** The brigadev settings, pinned by the caller when the runner opened (a worker that rewrites `brigadev.json` changes nothing); default `~/.pi/agent/brigadev.json`, re-read on every call. */
	settings?: () => BrigadevSettings;
	/** The environment the test process gets (default: the contained environment over the current one; see src/contain.ts). */
	shellEnv?: NodeJS.ProcessEnv;
	/** Longest a run may take, in ms. */
	maxTimeoutMs?: number;
}

const Parameters = obj({
	command: opt(str({ description: "Test command; default: check.test from brigadev.json, else detected (npm test, pytest, cargo test, go test)" })),
	focus: opt(str({ description: "Appended to the command, e.g. one test file" })),
	timeoutSeconds: opt(num({ description: "Default 600" })),
});

export function createCheckTool(options: CheckToolOptions) {
	const exec = options.exec ?? nodeExec;
	const settings = options.settings ?? readSettings;
	return defineTool({
		name: "check",
		description:
			"Run the project's tests and get a compact result: pass/fail counts and the failing tail; the full output goes to a file. Records the run as evidence for the commit gate. Use it instead of bash for tests, and never pipe it.",
		parameters: Parameters,
		async execute(args, api, context) {
			const cwd = (await api.agent(context)).cwd ?? options.cwd;
			const shellEnv = options.shellEnv ?? defaultContainedEnv();
			const result = await runContainedCheck(args, { cwd, exec, signal: context.abortSignal, agent: RUNNER_AGENT, settings: settings(), shellEnv, maxTimeoutMs: options.maxTimeoutMs });
			return {
				output: [{ type: "text" as const, text: result.text }],
				// Details are for UIs; a JSON round trip drops the undefined fields the stored shape cannot hold.
				...(result.details ? { details: JSON.parse(JSON.stringify(result.details)) as JsonValue } : {}),
				...(result.isError ? { isError: true } : {}),
			};
		},
	});
}
