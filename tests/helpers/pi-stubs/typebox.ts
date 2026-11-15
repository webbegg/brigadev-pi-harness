// TEST-ONLY stub of `typebox` (a Pi runtime package that is not installed in this repo).
// Builds plain JSON-schema-like objects for the builders extensions/subagents.ts uses, so tests can assert on the
// schema it registers. `Optional` marks the schema with a non-enumerable symbol; `Object` leaves optional fields
// out of `required`, as the real library does. Not a validator.

export const OptionalKind = Symbol.for("test.typebox.optional");

type Schema = Record<string, unknown>;
type Options = Record<string, unknown> | undefined;

const isOptional = (schema: unknown): boolean => typeof schema === "object" && schema !== null && (schema as Record<symbol, unknown>)[OptionalKind] === true;

export const Type = {
	String: (options?: Options): Schema => ({ type: "string", ...options }),
	Number: (options?: Options): Schema => ({ type: "number", ...options }),
	Boolean: (options?: Options): Schema => ({ type: "boolean", ...options }),
	Literal: (value: string | number | boolean, options?: Options): Schema => ({ const: value, ...options }),
	Array: (items: Schema, options?: Options): Schema => ({ type: "array", items, ...options }),
	Union: (anyOf: Schema[], options?: Options): Schema => ({ anyOf, ...options }),
	Optional: (schema: Schema): Schema => {
		const copy = { ...schema };
		Object.defineProperty(copy, OptionalKind, { value: true, enumerable: false });
		return copy;
	},
	Object: (properties: Record<string, Schema>, options?: Options): Schema => {
		const required = Object.keys(properties).filter((key) => !isOptional(properties[key]));
		return { type: "object", properties, ...(required.length > 0 ? { required } : {}), ...options };
	},
};
