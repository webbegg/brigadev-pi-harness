/**
 * Structured subagent results: an agent definition may name a JSON Schema
 * (`output: <file>` next to the agent file). Its child process then gets a
 * `structured_output` tool (extensions/structured-output.ts) that ends the
 * run, and the parent validates the payload here before handing it on.
 *
 * The validator covers the JSON Schema subset our agent schemas use: type
 * (string or list), properties, required, additionalProperties: false,
 * items, enum, minItems, minLength. Other keywords are ignored.
 */

import { readFileSync } from "node:fs";

export const STRUCTURED_OUTPUT_TOOL = "structured_output";

export const NUDGE_TEXT = `You finished without calling ${STRUCTURED_OUTPUT_TOOL}. Call it now, once, with your complete result; that call ends the run.`;

export type JsonSchema = Record<string, unknown>;

function typeOf(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

function matchesType(expected: string, value: unknown): boolean {
	if (expected === "integer") return typeof value === "number" && Number.isInteger(value);
	if (expected === "number") return typeof value === "number" && Number.isFinite(value);
	return typeOf(value) === expected;
}

function check(schema: JsonSchema, value: unknown, path: string, errors: string[]): void {
	const types = typeof schema.type === "string" ? [schema.type] : Array.isArray(schema.type) ? (schema.type as string[]) : [];
	if (types.length > 0 && !types.some((t) => matchesType(t, value))) {
		errors.push(`${path}: expected ${types.join("|")}`);
		return;
	}
	if (Array.isArray(schema.enum) && !schema.enum.some((option) => option === value)) {
		errors.push(`${path}: must be one of ${schema.enum.map((o) => JSON.stringify(o)).join(", ")}`);
	}
	if (typeof value === "string" && typeof schema.minLength === "number" && value.length < schema.minLength) {
		errors.push(`${path}: expected at least ${schema.minLength} characters`);
	}
	if (Array.isArray(value)) {
		if (typeof schema.minItems === "number" && value.length < schema.minItems) {
			errors.push(`${path}: expected at least ${schema.minItems} item${schema.minItems === 1 ? "" : "s"}`);
		}
		const items = schema.items;
		if (items && typeof items === "object" && !Array.isArray(items)) value.forEach((item, i) => check(items as JsonSchema, item, `${path}[${i}]`, errors));
	}
	if (typeOf(value) === "object") {
		const record = value as Record<string, unknown>;
		const properties = (schema.properties ?? {}) as Record<string, JsonSchema>;
		for (const key of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
			if (!(key in record)) errors.push(`${path}.${key}: required`);
		}
		for (const [key, child] of Object.entries(record)) {
			if (properties[key]) check(properties[key], child, `${path}.${key}`, errors);
			else if (schema.additionalProperties === false) errors.push(`${path}.${key}: unexpected property`);
		}
	}
}

/** Every violation, each prefixed with its JSON path (`$.findings[0].id`). Empty when valid. */
export function validateAgainstSchema(schema: JsonSchema, value: unknown): string[] {
	const errors: string[] = [];
	check(schema, value, "$", errors);
	return errors;
}

/** Reads an agent's output schema; tool parameters must be an object schema. */
export function loadOutputSchema(file: string): { schema: JsonSchema } | { error: string } {
	let raw: string;
	try {
		raw = readFileSync(file, "utf8");
	} catch {
		return { error: `cannot read output schema ${file}` };
	}
	let schema: unknown;
	try {
		schema = JSON.parse(raw);
	} catch {
		return { error: `output schema ${file} is not valid JSON` };
	}
	if (typeOf(schema) !== "object" || (schema as JsonSchema).type !== "object") return { error: `output schema ${file} must have type "object" at its root` };
	return { schema: schema as JsonSchema };
}

interface MessageLike {
	role: string;
	content?: unknown;
	toolCallId?: string;
	toolName?: string;
	isError?: boolean;
}

/** Arguments of the last structured_output call the child accepted (its tool result is not an error). */
export function extractStructuredOutput(messages: readonly MessageLike[]): { found: true; value: unknown } | { found: false } {
	const accepted = new Set(messages.filter((m) => m.role === "toolResult" && m.toolName === STRUCTURED_OUTPUT_TOOL && !m.isError).map((m) => m.toolCallId));
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "assistant" || !Array.isArray(msg.content)) continue;
		for (let j = msg.content.length - 1; j >= 0; j--) {
			const part = msg.content[j] as { type?: string; id?: string; name?: string; arguments?: unknown };
			if (part?.type === "toolCall" && part.name === STRUCTURED_OUTPUT_TOOL && accepted.has(part.id)) return { found: true, value: part.arguments };
		}
	}
	return { found: false };
}

export type StructuredCheck = { ok: true; value: unknown } | { ok: false; error: string };

/** The parent's verdict on a finished run: a valid payload, or the reason the run failed. */
export function checkStructuredRun(messages: readonly MessageLike[], schema: JsonSchema): StructuredCheck {
	const output = extractStructuredOutput(messages);
	if (!output.found) return { ok: false, error: `Subagent finished without calling ${STRUCTURED_OUTPUT_TOOL}.` };
	const errors = validateAgainstSchema(schema, output.value);
	if (errors.length > 0) return { ok: false, error: `Subagent ${STRUCTURED_OUTPUT_TOOL} does not match its schema: ${errors.join("; ")}` };
	return { ok: true, value: output.value };
}

export function formatStructured(value: unknown): string {
	return `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

/** The child gets exactly one reminder when it settles without a result. */
export function shouldNudge(state: { captured: boolean; nudges: number }): boolean {
	return !state.captured && state.nudges < 1;
}
