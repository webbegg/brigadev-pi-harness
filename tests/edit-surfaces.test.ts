// globToRegExp: the shared glob matcher (edit surfaces, risk map).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { globToRegExp, isWithinSurfaces } from "../lib/edit-surfaces.ts";

describe("globToRegExp", () => {
	it("matches * within a segment and ** across segments", () => {
		assert.ok(globToRegExp("lib/*.ts").test("lib/a.ts"));
		assert.ok(!globToRegExp("lib/*.ts").test("lib/x/a.ts"));
		assert.ok(globToRegExp("**/a.ts").test("a.ts"));
		assert.ok(globToRegExp("**/a.ts").test("x/y/a.ts"));
		assert.ok(globToRegExp("src/**").test("src/x/y.ts"));
	});
	it("supports {a,b} alternation, also with globs inside and several groups", () => {
		const re = globToRegExp("lib/{evidence,check}.ts");
		assert.ok(re.test("lib/evidence.ts") && re.test("lib/check.ts"));
		assert.ok(!re.test("lib/other.ts") && !re.test("lib/{evidence,check}.ts"));
		assert.ok(globToRegExp("**/*.{test,spec}.*").test("a/b.spec.ts"));
		assert.ok(globToRegExp("{lib,ext}/{a,b}.ts").test("ext/b.ts"));
		assert.ok(globToRegExp("x/{a*,b}.ts").test("x/abc.ts"));
	});
	it("treats an unclosed brace literally and can ignore case", () => {
		assert.ok(globToRegExp("a{b").test("a{b"));
		assert.ok(globToRegExp("Docker*", true).test("dockerfile"));
		assert.ok(!globToRegExp("Docker*").test("dockerfile"));
	});
	it("brace surfaces work through isWithinSurfaces", () => {
		assert.ok(isWithinSurfaces("lib/check.ts", ["lib/{evidence,check}.ts"]));
		assert.ok(!isWithinSurfaces("lib/other.ts", ["lib/{evidence,check}.ts"]));
	});
});
