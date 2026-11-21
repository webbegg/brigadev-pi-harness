import assert from "node:assert/strict";
import { test } from "node:test";
import { redact } from "../lib/redact.ts";

test("redact: credentials in URLs", () => {
	assert.equal(redact("git clone https://user:tok3n@github.com/o/r.git"), "git clone https://***@github.com/o/r.git");
	assert.equal(redact("git remote add o https://ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/o/r"), "git remote add o https://***@github.com/o/r");
	assert.equal(redact("psql postgres://admin:s3cr3t@db.internal:5432/app"), "psql postgres://***@db.internal:5432/app");
	assert.equal(redact("curl https://example.com/a?b=c@d"), "curl https://example.com/a?b=c@d", "an @ after the host is not a credential");
	assert.equal(redact("see https://example.com/user@x"), "see https://example.com/user@x");
});

test("redact: Authorization headers keep the scheme and lose the credential", () => {
	assert.equal(redact('curl -H "Authorization: Bearer abc.def.ghi" https://x.test'), 'curl -H "Authorization: Bearer ***" https://x.test');
	assert.equal(redact("curl -H 'authorization: basic dXNlcjpwYXNz' x"), "curl -H 'authorization: basic ***' x");
	assert.equal(redact("Authorization: Bearer short"), "Authorization: Bearer ***");
	assert.equal(redact("the Bearer of bad news"), "the Bearer of bad news");
});

test("redact: token-like strings", () => {
	const tokens = [
		"ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
		"gho_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
		"ghs_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8",
		"github_pat_" + "11ABCDEFG0abcdefghijkl_mnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
		"sk-ant-" + "api03-abcdefghijklmnopqrstuvwxyz0123456789",
		"sk-" + "proj1234567890abcdefghijklmnop",
		"xoxb-" + "123456789012-abcdefghijklmnop",
		"xoxa-" + "123456789012-abcdefghijklmnop",
		"xoxp-" + "123456789012-abcdefghijklmnop",
		"AKIA" + "IOSFODNN7EXAMPLE",
		"0123456789abcdef0123456789abcdef", // 32 hex
		"9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", // 64 hex
		"dGhpcy1pcy1hLWxvbmctYmFzZTY0LXRva2VuLXZhbHVlMDEyMzQ1Njc4OQ", // base64, mixed classes
	];
	for (const token of tokens) {
		const out = redact(`deploy --to prod ${token} now`);
		assert.ok(!out.includes(token), `${token.slice(0, 12)}… still there: ${out}`);
		assert.match(out, /^deploy --to prod \*\*\* now$/, token.slice(0, 12));
	}
});

test("redact: ordinary text, paths, words and short ids are left alone", () => {
	for (const text of [
		"git status",
		"npm test -- tests/web-server.test.ts",
		"read /Users/someone/projects/brigadev-pi-harness/extensions/web-ui.ts",
		"edit lib/human-prompt.ts",
		"grep -rn sk-learn src",
		"ls -la ~/.ssh",
		"docker run -p 8080:80 nginx",
		"docker run -p8080:80 nginx",
		"mkdir -p a/b",
		"very-long-lowercase-kebab-case-file-name-with-many-words.md",
		"Which database should the project use for the audit log?",
		"commit abcdef1",
	]) {
		assert.equal(redact(text), text);
	}
});

test("redact: password-like flags and variables", () => {
	assert.equal(redact("mysql -u root --password=hunter2 db"), "mysql -u root --password=*** db");
	assert.equal(redact("mysql --password hunter2 db"), "mysql --password *** db");
	assert.equal(redact("mysql -phunter2 db"), "mysql -p*** db");
	assert.equal(redact("tool --token=abc --api-key xyz --secret=s"), "tool --token=*** --api-key *** --secret=***");
	assert.equal(redact("curl -u admin:hunter2 https://x.test"), "curl -u *** https://x.test");
	assert.equal(redact("GITHUB_TOKEN=abc123 npm publish"), "GITHUB_TOKEN=*** npm publish");
	assert.equal(redact('DB_PASSWORD="two words" ./run'), "DB_PASSWORD=*** ./run");
	assert.equal(redact("aws_secret_access_key=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY aws s3 ls"), "aws_secret_access_key=*** aws s3 ls");
});

test("redact: idempotent, handles empty and non-string input, and several secrets at once", () => {
	assert.equal(redact(""), "");
	assert.equal(redact(undefined as unknown as string), "");
	const once = redact("curl -H 'Authorization: Bearer abc' https://u:p@h.test --password=x ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8");
	assert.equal(once, "curl -H 'Authorization: Bearer ***' https://***@h.test --password=*** ***");
	assert.equal(redact(once), once);
});

test("redact: 15k chars of near-matches stay linear", () => {
	const started = performance.now();
	for (const text of ["https://".repeat(5000), "a:".repeat(7500), "-p".repeat(7500), "ghp_".repeat(4000), "A".repeat(15000), "token=".repeat(3000)]) redact(text);
	assert.ok(performance.now() - started < 500, `took ${Math.round(performance.now() - started)} ms`);
});
