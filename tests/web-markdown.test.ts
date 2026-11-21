// The web UI's markdown subset: a pure parser (text -> plain-object tree) the page turns into DOM nodes, never HTML.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { webPage } from "../lib/web-page.ts";

await import("../assets/web-ui/markdown.js");
const md = (globalThis as any).brigadevMarkdown as { parse(text: string): any[]; inline(text: string): any[] };

const text = (v: string) => ({ t: "text", v });

describe("web page", () => {
	it("inlines the markdown parser before the page script, as one static file", () => {
		const html = webPage();
		assert.doesNotMatch(html, /@inline/);
		const parser = html.indexOf("root.brigadevMarkdown =");
		assert.ok(parser > 0, "the parser is inlined");
		assert.ok(parser < html.indexOf("var STEPS"), "before the page script that uses it");
		assert.doesNotMatch(html, /<script[^>]*\ssrc=/i, "no external script");
	});
});

describe("web markdown: blocks", () => {
	it("splits paragraphs on blank lines and keeps single line breaks", () => {
		assert.deepEqual(md.parse("one\ntwo\n\nthree"), [
			{ t: "p", c: [text("one\ntwo")] },
			{ t: "p", c: [text("three")] },
		]);
	});

	it("reads headings, rules and quotes", () => {
		assert.deepEqual(md.parse("## Title\n---\n> said"), [
			{ t: "h", level: 2, c: [text("Title")] },
			{ t: "hr" },
			{ t: "quote", c: [text("said")] },
		]);
	});

	it("keeps fenced code verbatim, with its language, unclosed fences included", () => {
		assert.deepEqual(md.parse("```bash\nnpm test  # **not bold**\n```\nafter"), [
			{ t: "code", lang: "bash", text: "npm test  # **not bold**" },
			{ t: "p", c: [text("after")] },
		]);
		assert.deepEqual(md.parse("```\nopen"), [{ t: "code", lang: "", text: "open" }]);
	});

	it("reads bullet, numbered and task lists, continuation lines included", () => {
		assert.deepEqual(md.parse("- a\n  more\n* b\n\n1. one\n2) two"), [
			{ t: "ul", items: [{ check: null, c: [text("a\nmore")] }, { check: null, c: [text("b")] }] },
			{ t: "ol", start: 1, items: [{ check: null, c: [text("one")] }, { check: null, c: [text("two")] }] },
		]);
		assert.deepEqual(md.parse("- [ ] todo\n- [x] done"), [
			{ t: "ul", items: [{ check: false, c: [text("todo")] }, { check: true, c: [text("done")] }] },
		]);
	});

	it("reads pipe tables, separator row required, cells inline-parsed", () => {
		assert.deepEqual(md.parse("| A | B |\n| --- | :-: |\n| `x` | y \\| z |"), [
			{ t: "table", head: [[text("A")], [text("B")]], rows: [[[{ t: "code", v: "x" }], [text("y | z")]]] },
		]);
		assert.deepEqual(md.parse("| not | a table |"), [{ t: "p", c: [text("| not | a table |")] }]);
	});
});

describe("web markdown: inline", () => {
	it("reads code, bold, italic and links", () => {
		assert.deepEqual(md.inline("`a*b*` **bold** *it* _it2_ [site](https://x.dev/p?q=1)"), [
			{ t: "code", v: "a*b*" },
			text(" "),
			{ t: "b", c: [text("bold")] },
			text(" "),
			{ t: "i", c: [text("it")] },
			text(" "),
			{ t: "i", c: [text("it2")] },
			text(" "),
			{ t: "a", href: "https://x.dev/p?q=1", c: [text("site")] },
		]);
	});

	it("nests emphasis inside bold", () => {
		assert.deepEqual(md.inline("**a *b* c**"), [{ t: "b", c: [text("a "), { t: "i", c: [text("b")] }, text(" c")] }]);
	});

	it("leaves a link that is not http(s) as plain text", () => {
		assert.deepEqual(md.inline("[x](javascript:alert(1))"), [text("[x](javascript:alert(1))")]);
	});

	it("keeps markup, unmatched markers and snake_case words as text", () => {
		assert.deepEqual(md.inline("<script>alert(1)</script>"), [text("<script>alert(1)</script>")]);
		assert.deepEqual(md.inline("2 * 3 and **open"), [text("2 * 3 and **open")]);
		assert.deepEqual(md.inline("ask_user_choice and BRIGADEV_WEB_PORT"), [text("ask_user_choice and BRIGADEV_WEB_PORT")]);
	});

	// About 120k chars each: a linear parse takes ~10-20 ms, a quadratic one seconds, so the 250 ms bound holds under a loaded machine
	// and still fails a quadratic path (a 15k input with 50 ms could not tell the two apart under load).
	it("stays linear on unmatched emphasis, link openers and code spans (each ~120k chars parses in under 250 ms)", () => {
		const cases: Array<[string, string]> = [
			["*a ", "*a ".repeat(40_000)],
			["_a ", "_a ".repeat(40_000)],
			["**a ", "**a ".repeat(30_000)],
			["[", "[".repeat(120_000)],
			["[a ", "[a ".repeat(40_000) + "]"],
			["[a\\n", "[a\n".repeat(40_000) + "](x)"],
			["[a](", "[a](x".repeat(24_000)],
			["`a", "`a".repeat(60_000)],
			["``a`", "``a`".repeat(30_000)],
		];
		for (const [name, source] of cases) {
			const started = performance.now();
			md.parse(source);
			const took = performance.now() - started;
			assert.ok(took < 250, `${JSON.stringify(name)} x ${source.length} chars took ${took.toFixed(0)} ms`);
		}
	});

	it("keeps the output for the cases around the opener search: matches after unmatched openers, links, nesting", () => {
		assert.deepEqual(md.inline("*a *b*"), [{ t: "i", c: [text("a *b")] }]);
		assert.deepEqual(md.inline("**a **b**"), [{ t: "b", c: [text("a **b")] }]);
		assert.deepEqual(md.inline("[a [b](https://x.dev)"), [{ t: "a", href: "https://x.dev", c: [text("a [b")] }]);
		assert.deepEqual(md.inline("[a\nb](https://x.dev) [c](https://y.dev)"), [text("[a\nb](https://x.dev) "), { t: "a", href: "https://y.dev", c: [text("c")] }]);
		assert.deepEqual(md.inline("[a](https://x.dev/(b)) tail"), [{ t: "a", href: "https://x.dev/(b)", c: [text("a")] }, text(" tail")]);
		assert.deepEqual(md.inline("[](https://x.dev)"), [text("[](https://x.dev)")]);
	});

	it("never throws on any input", () => {
		for (const s of ["", "**", "``", "[", "[a](", "| |", "```", "-", "1.", "> ", "#".repeat(9), "*_*_*_"]) {
			assert.doesNotThrow(() => md.parse(s), s);
		}
	});
});
