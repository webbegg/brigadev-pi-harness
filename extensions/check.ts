/**
 * brigadev check: runs the project's tests and returns a small result
 * (pass/fail counts, the failing tail, the output file's path) instead of the
 * full output. The run is recorded in the evidence log with its real exit
 * code, so the commit gate trusts it; a piped `bash` test run is not needed.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCheck } from "../lib/check.ts";
import { CHILD_ENV, readSettings } from "../lib/runtime.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";

const Params = Type.Object({
	command: Type.Optional(Type.String({ description: "Test command; default: check.test from brigadev.json, else detected (npm test, pytest, cargo test, go test)" })),
	focus: Type.Optional(Type.String({ description: "Appended to the command, e.g. one test file" })),
	timeoutSeconds: Type.Optional(Type.Number({ description: "Default 600" })),
});

export default function (pi: ExtensionAPI) {
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);

	pi.registerTool({
		name: "check",
		label: "Check",
		description: "Run the project's tests and get a compact result: pass/fail counts and the failing tail; the full output goes to a file. Records the run as evidence for the commit gate. Use it instead of bash for tests, and never pipe it.",
		parameters: Params,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const result = await runCheck(params, { cwd: ctx.cwd, exec, signal, agent: process.env[CHILD_ENV.AGENT] || "parent", settings: readSettings() });
			return { content: [{ type: "text" as const, text: result.text }], details: result.details, ...(result.isError ? { isError: true } : {}) };
		},
	});
}
