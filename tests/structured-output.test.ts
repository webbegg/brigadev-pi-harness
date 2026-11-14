import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseAgent } from "../lib/agents.ts";
import {
	checkStructuredRun,
	extractStructuredOutput,
	formatStructured,
	loadOutputSchema,
	shouldNudge,
	STRUCTURED_OUTPUT_TOOL,
	validateAgainstSchema,
} from "../lib/structured-output.ts";

const schema = {
	type: "object",
	required: ["verdict", "findings"],
	additionalProperties: false,
	properties: {
		verdict: { type: "string", enum: ["pass", "fail"] },
		count: { type: "integer" },
		findings: {
			type: "array",
			items: { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1 }, line: { type: ["integer", "null"] } } },
		},
	},
};

describe("validateAgainstSchema", () => {
	it("accepts a conforming value", () => {
		assert.deepEqual(validateAgainstSchema(schema, { verdict: "pass", count: 2, findings: [{ id: "F1", line: null }] }), []);
	});

	it("names every violation with its path", () => {
		const errors = validateAgainstSchema(schema, { verdict: "maybe", count: 1.5, findings: [{ line: "x" }], extra: true });
		assert.deepEqual(errors.sort(), [
			"$.count: expected integer",
			"$.extra: unexpected property",
			"$.findings[0].id: required",
			"$.findings[0].line: expected integer|null",
			'$.verdict: must be one of "pass", "fail"',
		]);
	});

	it("treats prototype-named keys as ordinary properties", () => {
		const payload = JSON.parse('{"verdict":"pass","findings":[],"constructor":1,"toString":2,"__proto__":{"x":1}}');
		assert.deepEqual(validateAgainstSchema(schema, payload).sort(), ["$.__proto__: unexpected property", "$.constructor: unexpected property", "$.toString: unexpected property"]);
		assert.deepEqual(validateAgainstSchema({ type: "object", required: ["toString"] }, {}), ["$.toString: required"]);
	});

	it("rejects a wrong root type", () => {
		assert.deepEqual(validateAgainstSchema(schema, []), ["$: expected object"]);
	});

	it("checks minLength and minItems", () => {
		assert.deepEqual(validateAgainstSchema({ type: "array", minItems: 1 }, []), ["$: expected at least 1 item"]);
		assert.deepEqual(validateAgainstSchema({ type: "string", minLength: 2 }, "a"), ["$: expected at least 2 characters"]);
	});

	it("checks minProperties on objects", () => {
		const object = { type: "object", minProperties: 1, properties: { a: { type: "string" } } };
		assert.deepEqual(validateAgainstSchema(object, {}), ["$: expected at least 1 property"]);
		assert.deepEqual(validateAgainstSchema({ ...object, minProperties: 2 }, { a: "x" }), ["$: expected at least 2 properties"]);
		assert.deepEqual(validateAgainstSchema(object, { a: "x" }), []);
	});
});

const call = (id: string, args: unknown) => ({ role: "assistant", content: [{ type: "toolCall", id, name: STRUCTURED_OUTPUT_TOOL, arguments: args }] });
const result = (id: string, isError = false) => ({ role: "toolResult", toolCallId: id, toolName: STRUCTURED_OUTPUT_TOOL, isError, content: [] });

describe("extractStructuredOutput", () => {
	it("returns the arguments of the last accepted call", () => {
		const messages = [call("a", { verdict: "x" }), result("a", true), call("b", { verdict: "pass", findings: [] }), result("b")];
		assert.deepEqual(extractStructuredOutput(messages), { found: true, value: { verdict: "pass", findings: [] } });
	});

	it("reports nothing when the tool was never accepted", () => {
		assert.deepEqual(extractStructuredOutput([call("a", {}), result("a", true)]), { found: false });
		assert.deepEqual(extractStructuredOutput([{ role: "assistant", content: [{ type: "text", text: "done" }] }]), { found: false });
	});
});

describe("checkStructuredRun", () => {
	it("passes a valid payload through", () => {
		const value = { verdict: "fail", findings: [{ id: "F1" }] };
		assert.deepEqual(checkStructuredRun([call("a", value), result("a")], schema), { ok: true, value });
	});

	it("fails a run that never called the tool", () => {
		const check = checkStructuredRun([], schema);
		assert.equal(check.ok, false);
		assert.match(!check.ok ? check.error : "", /finished without calling structured_output/);
	});

	it("fails an accepted payload that does not match the schema", () => {
		const check = checkStructuredRun([call("a", { verdict: "pass" }), result("a")], schema);
		assert.equal(check.ok, false);
		assert.match(!check.ok ? check.error : "", /\$\.findings: required/);
	});
});

describe("loadOutputSchema", () => {
	const dir = mkdtempSync(join(tmpdir(), "brigadev-schema-"));

	it("loads an object schema", () => {
		const file = join(dir, "ok.schema.json");
		writeFileSync(file, JSON.stringify(schema));
		assert.deepEqual(loadOutputSchema(file), { schema });
	});

	it("rejects a missing file, bad JSON, and a non-object root", () => {
		assert.match((loadOutputSchema(join(dir, "nope.json")) as { error: string }).error, /cannot read/);
		writeFileSync(join(dir, "bad.json"), "{");
		assert.match((loadOutputSchema(join(dir, "bad.json")) as { error: string }).error, /not valid JSON/);
		writeFileSync(join(dir, "arr.json"), JSON.stringify({ type: "array" }));
		assert.match((loadOutputSchema(join(dir, "arr.json")) as { error: string }).error, /type "object"/);
	});
});

describe("structured output helpers", () => {
	it("formats the payload as a fenced JSON block", () => {
		assert.equal(formatStructured({ a: 1 }), '```json\n{\n  "a": 1\n}\n```');
	});

	it("switches to compact JSON above the byte cap and never truncates", () => {
		const value = { findings: Array.from({ length: 400 }, (_, i) => ({ id: `R-${i}`, claim: "é".repeat(60) })) };
		const cap = 10 * 1024;
		assert.ok(Buffer.byteLength(JSON.stringify(value, null, 2), "utf8") > cap);
		const text = formatStructured(value, cap);
		const match = text.match(/^```json\n([\s\S]*)\n```$/);
		assert.ok(match, "a complete fenced block");
		assert.deepEqual(JSON.parse(match[1]), value);
		assert.equal(match[1], JSON.stringify(value));
		assert.equal(formatStructured({ a: 1 }, cap), formatStructured({ a: 1 }), "small payloads stay pretty");
	});

	it("nudges once when the child settles without a result", () => {
		assert.equal(shouldNudge({ captured: false, nudges: 0 }), true);
		assert.equal(shouldNudge({ captured: false, nudges: 1 }), false);
		assert.equal(shouldNudge({ captured: true, nudges: 0 }), false);
	});
});

describe("parseAgent output schema", () => {
	const parse = (content: string) => {
		const [, head, body] = content.split("---\n");
		const frontmatter = Object.fromEntries(head.trim().split("\n").map((l) => l.split(": ")));
		return { frontmatter, body };
	};

	it("resolves the output schema next to the agent file", () => {
		const agent = parseAgent("---\nname: v\ndescription: d\noutput: v.schema.json\n---\nbody", "/pkg/agents/v.md", "package", parse);
		assert.equal(agent?.outputSchema, "/pkg/agents/v.schema.json");
	});

	it("ignores an output path that leaves the agent's directory", () => {
		for (const output of ["../secret.json", "/etc/passwd", "sub/../../x.json", ".."]) {
			const agent = parseAgent(`---\nname: v\ndescription: d\noutput: ${output}\n---\nbody`, "/pkg/agents/v.md", "package", parse);
			assert.ok(agent, output);
			assert.equal(agent.outputSchema, undefined, output);
		}
		const nested = parseAgent("---\nname: v\ndescription: d\noutput: schemas/v.json\n---\nbody", "/pkg/agents/v.md", "package", parse);
		assert.equal(nested?.outputSchema, "/pkg/agents/schemas/v.json");
	});

	it("leaves prose agents without a schema", () => {
		const agent = parseAgent("---\nname: v\ndescription: d\n---\nbody", "/pkg/agents/v.md", "package", parse);
		assert.equal(agent?.outputSchema, undefined);
	});
});
