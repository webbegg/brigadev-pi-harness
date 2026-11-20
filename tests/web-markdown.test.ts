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

	it("never throws on any input", () => {
		for (const s of ["", "**", "``", "[", "[a](", "| |", "```", "-", "1.", "> ", "#".repeat(9), "*_*_*_"]) {
			assert.doesNotThrow(() => md.parse(s), s);
		}
	});
});
