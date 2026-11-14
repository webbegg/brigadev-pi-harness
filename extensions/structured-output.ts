/**
 * brigadev structured output (child processes only): registers the
 * `structured_output` tool whose parameters are the agent's output schema.
 * An accepted call ends the run (terminate), so the payload is the result.
 * A run that settles without one gets a single reminder turn; the parent
 * (extensions/subagents.ts) fails it if the payload is still missing.
 *
 * Loaded with -e by the subagent launcher, never from package.json.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CHILD_ENV, isChildSession } from "../lib/runtime.ts";
import { loadOutputSchema, NUDGE_TEXT, shouldNudge, STRUCTURED_OUTPUT_TOOL, validateAgainstSchema } from "../lib/structured-output.ts";

export default function (pi: ExtensionAPI) {
	const file = process.env[CHILD_ENV.OUTPUT_SCHEMA];
	if (!isChildSession() || !file) return;
	const loaded = loadOutputSchema(file);
	// The parent validated the schema before launch; a failure here leaves the
	// tool unregistered and the parent reports the missing result.
	if ("error" in loaded) return;
	const { schema } = loaded;

	const state = { captured: false, nudges: 0 };

	pi.registerTool({
		name: STRUCTURED_OUTPUT_TOOL,
		label: "Structured output",
		description: "Return your final result in the required shape. Call it once, last; the call ends your run.",
		parameters: Type.Unsafe<Record<string, unknown>>(schema),
		async execute(_id, params) {
			const errors = validateAgainstSchema(schema, params);
			if (errors.length > 0) {
				return { content: [{ type: "text", text: `Rejected; fix and call again:\n- ${errors.join("\n- ")}` }], details: { errors }, isError: true };
			}
			state.captured = true;
			return { content: [{ type: "text", text: "Result recorded." }], details: {}, terminate: true };
		},
	});

	pi.on("agent_before_settle", async () => {
		if (!shouldNudge(state)) return;
		state.nudges++;
		return { entries: [{ type: "custom_message", customType: "brigadev-structured-output", content: NUDGE_TEXT, display: false }], continue: true };
	});
}
