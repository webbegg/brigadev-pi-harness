// R4-002: what the board reads from the store is worker-controlled text, and it goes through the redactors on a timer. src/redact.ts has a pattern whose cost grows with the
// square of a long run of `[a-z0-9+.-]` (a scheme-looking prefix that is tried from every word boundary), so the text is bounded before it is redacted, and a secret that
// the bound cuts in two is not shown half-masked. The wall-clock bound separates linear from quadratic: 200,000 characters take well under it linearly, and minutes squared.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clean, summarize } from "../src/board.ts";
import { redact } from "../src/redact.ts";

const BOUND_MS = 250;

function timed<T>(work: () => T): { value: T; ms: number } {
	const start = performance.now();
	const value = work();
	return { value, ms: performance.now() - start };
}

// Each is a long hostile run for one of the redactors' unbounded-looking patterns.
const HOSTILE: Array<[string, string]> = [
	["a '[a-z0-9+.-]' run of word boundaries (`a.a.a.`), 200,000 characters", "a.".repeat(100_000)],
	["a hyphenated run (`a-a-a-`), 200,000 characters", "a-".repeat(100_000)],
	["a long base64-like run with + and /, 200,000 characters", "Ab3+/xY9".repeat(25_000)],
	["a long base64-like run with no digit, 200,000 characters", "Ab+/xYzQ".repeat(25_000)],
	["a long hex run, 200,000 characters", "0123456789abcdef".repeat(12_500)],
];

describe("the board's redaction costs what it shows, not what the worker sent (R4-002)", () => {
	for (const [what, text] of HOSTILE) {
		it(`${what}: a summary and a cleaned string finish inside ${BOUND_MS} ms`, () => {
			assert.ok(text.length >= 120_000);
			const summary = timed(() => summarize({ command: text }));
			assert.ok(summary.ms < BOUND_MS, `summarize took ${Math.round(summary.ms)} ms`);
			assert.ok(summary.value.length <= 200, "and still a one-line summary");
			const cleaned = timed(() => clean({ note: text, nested: [text] }));
			assert.ok(cleaned.ms < BOUND_MS, `clean took ${Math.round(cleaned.ms)} ms`);
		});
	}

	it("the runner's own redactor is linear too (the root cause: the scheme of a URL credential was an unbounded run, tried from every word boundary), and still masks what it did", () => {
		const slow = timed(() => redact("a.".repeat(100_000), "/nonexistent-home"));
		assert.ok(slow.ms < BOUND_MS, `redact took ${Math.round(slow.ms)} ms`);
		assert.equal(redact("git clone https://user:tok3n@example.test/r.git", "/nonexistent-home"), "git clone https://***@example.test/r.git");
		assert.equal(redact("x-custom+scheme.v2://user:pw@host/", "/nonexistent-home"), "x-custom+scheme.v2://***@host/");
	});

	it("a secret is still masked: in a short command, and in a long one before the bound", () => {
		const token = `ghp_${"Zq9".repeat(14)}`;
		assert.equal(summarize({ command: `curl -H "Authorization: Bearer ${token}" https://x.test` }).includes(token), false);
		assert.match(summarize({ command: `export GITHUB_TOKEN=${token}` }), /GITHUB_TOKEN=\*\*\*/);
		const long = `${token} ${"a.".repeat(100_000)}`;
		const out = summarize({ command: long });
		assert.ok(out.startsWith("*** "), out.slice(0, 40));
		assert.ok(!out.includes("Zq9"));
		assert.ok(!clean(long).includes("Zq9"));
		const url = `https://user:s3cr3t-password@example.test/${"x".repeat(50_000)}`;
		assert.match(summarize({ command: url }), /^https:\/\/\*\*\*@example\.test\//);
	});

	it("a secret that the bound cuts in two does not leak its first half: many tokens shrink to `***`, so the half-token at the cut would sit inside the shown 200 characters", () => {
		const token = `ghp_${"Zq9".repeat(14)}`; // 46 characters, masked whole
		const text = `${`${token} `.repeat(500)}${"y".repeat(5)}`; // 23,000 characters: far past any bound, and every token is a secret
		for (const [name, shown] of [
			["summarize", summarize({ command: text })],
			["clean", clean(text)],
		] as const) {
			assert.ok(!/ghp_|Zq9/.test(shown), `${name} shows a piece of a token: ${shown.slice(0, 120)}`);
		}
		// Every cut position near the bound, so a token is split at each offset inside it (the redactors' threshold is 20 after the prefix).
		for (let pad = 0; pad < 46; pad += 1) {
			const shifted = `${"x ".repeat(1_000)}${"q".repeat(pad)} ${`${token} `.repeat(200)}`;
			assert.ok(!/ghp_|Zq9/.test(summarize({ command: shifted })), `pad ${pad}`);
			assert.ok(!/ghp_|Zq9/.test(clean(shifted)), `pad ${pad}`);
		}
	});

	it("text within the bound is redacted exactly as before, and values that are not strings pass through", () => {
		assert.equal(summarize({ path: "src/a.ts" }), "src/a.ts");
		assert.equal(summarize({ command: "ls   -la\n  /tmp" }), "ls -la /tmp");
		assert.equal(summarize(undefined), "");
		assert.deepEqual(clean({ n: 1, ok: true, none: null, list: ["fine", 2] }), { n: 1, ok: true, none: null, list: ["fine", 2] });
		assert.equal(clean("x".repeat(4_000)), "x".repeat(4_000), "a capped output field is not cut again");
	});
});
