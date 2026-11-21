// The runner's variant of the web page (T7, R4): the same static file, with the link and ended messages naming the runner instead of Pi. The messages are
// injected server side as static text (a process id, never a secret); the Pi variant must stay exactly what it was.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { ASSETS_ROOT } from "../lib/runtime.ts";
import { webPage } from "../lib/web-page.ts";

const PI_LINK = 'var LINK_MESSAGE = "This link was already used or expired. In pi, run /brigadev:web open for a new one.";';
const PI_ENDED = 'var ENDED_MESSAGE = "This session ended (pi stopped the web UI or restarted it). In pi, run /brigadev:web open for a new link.";';
const PI_SIGNIN = 'var SIGNIN_HINT = "In pi, run /brigadev:web open for a new link.";';

const messageOf = (html: string, name: string): string => {
	const line = new RegExp(`var ${name} = (".*");`).exec(html);
	assert.ok(line, `${name} is in the page`);
	return JSON.parse(line[1]) as string;
};

test("the Pi variant is the page as it was: the default, and an explicit `pi`, are the same file with the Pi messages", () => {
	const html = webPage();
	assert.equal(webPage(ASSETS_ROOT, { variant: "pi" }), html);
	for (const line of [PI_LINK, PI_ENDED, PI_SIGNIN]) assert.ok(html.includes(line), line);
	assert.ok(!html.includes("kill -USR1"), "the Pi page says nothing of the runner's signal");
	// The asset itself carries the Pi strings: the variant only replaces them.
	const asset = readFileSync(join(ASSETS_ROOT, "web-ui", "index.html"), "utf8");
	for (const line of [PI_LINK, PI_ENDED, PI_SIGNIN]) assert.ok(asset.includes(line), `asset: ${line}`);
});

test("the runner variant names the runner's signal and terminal in the link, ended, and sign-in messages, and never Pi's command", () => {
	const html = webPage(ASSETS_ROOT, { variant: "runner", pid: 4242 });
	assert.equal(webPage({ variant: "runner", pid: 4242 }), html, "the options alone work too");
	for (const name of ["LINK_MESSAGE", "ENDED_MESSAGE", "SIGNIN_HINT"]) {
		const message = messageOf(html, name);
		assert.match(message, /run `kill -USR1 4242` or press Enter in the runner's terminal for a new link/, name);
		assert.ok(!/brigadev:web|\bIn pi\b/.test(message), `${name} does not send the user to pi: ${message}`);
	}
	assert.match(messageOf(html, "LINK_MESSAGE"), /^This link was already used or expired\./);
	for (const line of [PI_LINK, PI_ENDED, PI_SIGNIN]) assert.ok(!html.includes(line), `replaced: ${line}`);
	// Only the three message lines differ from the Pi page.
	const pi = webPage().split("\n");
	const runner = html.split("\n");
	assert.equal(runner.length, pi.length);
	assert.deepEqual(
		runner.map((line, i) => (line === pi[i] ? undefined : i)).filter((i) => i !== undefined).length,
		3,
	);
});

test("the pid is a number of this process's world, not text: anything else is refused, so nothing but a number reaches the page", () => {
	for (const pid of [0, -1, 1.5, Number.NaN, "1; alert(1)" as unknown as number]) {
		assert.throws(() => webPage(ASSETS_ROOT, { variant: "runner", pid }), /pid/, String(pid));
	}
	assert.throws(() => webPage(ASSETS_ROOT, { variant: "runner" }), /pid/, "the runner variant needs its pid");
});

test("the page switches to runner mode from the session snapshot (kind: runner): no composer, Pause for Abort, no cancel, a runner title", () => {
	const html = webPage();
	assert.match(html, /state\.session\.kind === "runner"/, "runner mode is read from the session snapshot");
	assert.match(html, /"Pause"/, "the abort button reads Pause in runner mode");
	assert.match(html, /brigadev-runner · /, "the title names the runner and the doc");
	assert.match(html, /cancel: a\.cancellable && live && !runner/, "cancel buttons are hidden in runner mode");
	assert.match(html, /id="stop-hint"/);
	assert.match(html, /id="title"/);
});

test("the page holds no secret: the code is read from the address and the runner variant adds only static text", () => {
	const html = webPage(ASSETS_ROOT, { variant: "runner", pid: 7 });
	assert.ok(!/code=[A-Za-z0-9_-]{20,}/.test(html));
	assert.ok(!html.includes("Authorization\": \"Bearer \" + \"") && !/Bearer [A-Za-z0-9_-]{20,}/.test(html));
});
