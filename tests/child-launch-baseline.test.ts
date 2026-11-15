import assert from "node:assert/strict";
import { it } from "node:test";
import { childLaunch } from "../lib/child-launch.ts";
import { CHILD_ENV, EVIDENCE_EXTENSION_PATH, GUARD_EXTENSION_PATH, STRUCTURED_OUTPUT_EXTENSION_PATH } from "../lib/runtime.ts";
import { STRUCTURED_OUTPUT_TOOL } from "../lib/structured-output.ts";

// The argv/env runAgent built inline before lib/child-launch.ts existed (8b951f6), transcribed.
function legacy(agent: { name: string; writer: boolean; tools?: string[]; outputSchema?: string }, surfaces: string[] | undefined, route: { model?: string; thinking?: string }, structured: boolean, cwd: string, taskText: string, promptPath: string | undefined, parentEnv: NodeJS.ProcessEnv) {
	const args = ["--mode", "json", "-p", "--no-session", "-e", GUARD_EXTENSION_PATH, "-e", EVIDENCE_EXTENSION_PATH];
	if (structured) args.push("-e", STRUCTURED_OUTPUT_EXTENSION_PATH);
	if (route.model) args.push("--model", route.model);
	if (route.thinking) args.push("--thinking", route.thinking);
	if (agent.tools?.length) args.push("--tools", [...agent.tools, ...(structured ? [STRUCTURED_OUTPUT_TOOL] : [])].join(","));
	if (promptPath) args.push("--append-system-prompt", promptPath);
	args.push(taskText);
	const env: NodeJS.ProcessEnv = { ...parentEnv, PWD: cwd, [CHILD_ENV.CHILD]: "1", [CHILD_ENV.AGENT]: agent.name, [CHILD_ENV.PROJECT_ROOT]: cwd, [CHILD_ENV.READ_ONLY]: agent.writer ? "0" : "1" };
	if (agent.writer && surfaces) env[CHILD_ENV.ALLOWED_SURFACES] = JSON.stringify(surfaces);
	else delete env[CHILD_ENV.ALLOWED_SURFACES];
	if (structured) env[CHILD_ENV.OUTPUT_SCHEMA] = agent.outputSchema;
	else delete env[CHILD_ENV.OUTPUT_SCHEMA];
	return { args, env };
}

it("childLaunch matches the pre-refactor argv and env for every combination, always non-interactive", () => {
	for (const writer of [false, true])
		for (const tools of [undefined, [], ["read", "bash"]])
			for (const outputSchema of [undefined, "/x/schema.json"])
				for (const schemaLoaded of [false, true])
					for (const model of [undefined, "a/b"])
						for (const thinking of [undefined, "high"])
							for (const prompt of [undefined, "/t/system.md"])
								for (const surfaces of [undefined, [], ["lib/**"]]) {
									const agent = { name: "w", writer, tools, outputSchema };
									const parentEnv = { PATH: "/bin", [CHILD_ENV.ALLOWED_SURFACES]: "stale", [CHILD_ENV.OUTPUT_SCHEMA]: "stale", [CHILD_ENV.CHILD]: "0" };
									const structured = Boolean(schemaLoaded && outputSchema);
									const expected = legacy(agent, surfaces, { model, thinking }, structured, "/c", "TASK -p --x", prompt, parentEnv);
									const actual = childLaunch({ agent, allowedEditSurfaces: surfaces, route: { model, thinking }, structured, cwd: "/c", taskText: "TASK -p --x", systemPromptPath: prompt, parentEnv });
									assert.deepEqual(actual.args, expected.args);
									assert.deepEqual(actual.env, expected.env);
									assert.deepEqual(actual.stdio, ["ignore", "pipe", "pipe"]);
									assert.equal(actual.env[CHILD_ENV.CHILD], "1");
									assert.ok(!actual.args.includes("--no-extensions"));
								}
});
