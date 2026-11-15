// lib/bg-view.ts: the pure text the model and the user see for background processes.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BgSnapshot } from "../lib/bg-processes.ts";
import { detailWidth, formatElapsed, killText, listText, psDetail, psFooter, psRows, psTitle, sanitizeOutput, startedText, statusLine, statusText, stateLabel, tailOutput } from "../lib/bg-view.ts";

const snap = (overrides: Partial<BgSnapshot> = {}): BgSnapshot => ({
	id: "bg-1",
	name: "dev server",
	command: "npm run dev",
	cwd: "/proj",
	pid: 123,
	state: "running",
	startedAt: 1000,
	output: "",
	totalBytes: 0,
	truncatedBytes: 0,
	...overrides,
});

describe("formatElapsed", () => {
	it("is compact", () => {
		assert.deepEqual([0, 4_400, 59_900, 65_000, 3_605_000, -5].map(formatElapsed), ["0s", "4s", "1m00s", "1m05s", "1h00m", "0s"]);
	});
});

describe("sanitizeOutput", () => {
	it("strips colors and cursor sequences, keeps text, newlines and tabs", () => {
		assert.equal(sanitizeOutput("\u001b[31mred\u001b[0m\tok\nnext\u001b[2K\u001b[1A"), "red\tok\nnext");
	});

	it("keeps only what a carriage return leaves last on a line (progress bars)", () => {
		assert.equal(sanitizeOutput("10%\r50%\r100%\ndone\r\nx"), "100%\ndone\nx");
	});

	it("drops other control characters and OSC titles", () => {
		assert.equal(sanitizeOutput("a\u0000b\u0007c\u001b]0;title\u0007d"), "abcd");
	});
});

describe("tailOutput", () => {
	it("returns short text whole", () => {
		assert.deepEqual(tailOutput("a\nb\n", { maxLines: 5, maxBytes: 1000 }), { text: "a\nb", omittedLines: 0 });
	});

	it("keeps the last lines and says how many were left out", () => {
		const text = Array.from({ length: 10 }, (_, i) => `l${i}`).join("\n");
		assert.deepEqual(tailOutput(text, { maxLines: 3, maxBytes: 1000 }), { text: "l7\nl8\nl9", omittedLines: 7 });
	});

	it("also bounds the bytes, cutting whole lines from the top (a single long line is cut to its end)", () => {
		const lines = ["a".repeat(50), "b".repeat(50), "c".repeat(50)].join("\n");
		const cut = tailOutput(lines, { maxLines: 100, maxBytes: 110 });
		assert.equal(cut.text, `${"b".repeat(50)}\n${"c".repeat(50)}`);
		assert.equal(cut.omittedLines, 1);
		const long = tailOutput("z".repeat(500), { maxLines: 100, maxBytes: 100 });
		assert.equal(long.text.length, 100);
	});

	it("is empty for empty output", () => {
		assert.deepEqual(tailOutput("", {}), { text: "", omittedLines: 0 });
	});
});

describe("state and text for the model", () => {
	it("labels every state", () => {
		assert.equal(stateLabel(snap(), 13_000), "running for 12s");
		assert.equal(stateLabel(snap({ state: "done", exitCode: 0, endedAt: 4000 }), 99_000), "done (exit 0) after 3s");
		assert.equal(stateLabel(snap({ state: "failed", exitCode: 2, endedAt: 4000 }), 99_000), "failed (exit 2) after 3s");
		assert.equal(stateLabel(snap({ state: "failed", signal: "SIGSEGV", endedAt: 4000 }), 99_000), "failed (SIGSEGV) after 3s");
		assert.equal(stateLabel(snap({ state: "killed", signal: "SIGTERM", endedAt: 4000 }), 99_000), "killed (SIGTERM) after 3s");
		assert.equal(stateLabel(snap({ state: "failed", error: "spawn ENOENT", endedAt: 1000 }), 99_000), "failed (could not run) after 0s");
	});

	it("tells the model what it started and that it should not poll", () => {
		const text = startedText(snap());
		assert.match(text, /^Started background process bg-1 "dev server" \(pid 123\) in \/proj\./);
		assert.match(text, /no stdin/i);
		assert.match(text, /one message when it exits/);
		assert.match(text, /bg_status bg-1/);
		assert.match(text, /bg_kill bg-1/);
	});

	it("shows the state, the command, and the output tail", () => {
		const text = statusText(snap({ output: "ready\nlistening on 3000\n", totalBytes: 24 }), 13_000);
		assert.match(text, /^bg-1 "dev server": running for 12s \(pid 123\)\n/);
		assert.match(text, /command: npm run dev\ncwd: \/proj\n/);
		assert.match(text, /output \(last 2 lines\):\nready\nlistening on 3000$/);
	});

	it("says when there is no output yet, and when older output was dropped", () => {
		assert.match(statusText(snap(), 2000), /output: \(none yet\)$/);
		const long = Array.from({ length: 300 }, (_, i) => `line ${i}`).join("\n");
		const text = statusText(snap({ output: long, totalBytes: 9_000_000, truncatedBytes: 8_000_000 }), 2000);
		assert.match(text, /last 100 of 300 lines/);
		assert.match(text, /earlier output was dropped/);
		assert.match(text, /line 299$/);
		assert.ok(!text.includes("line 199\n"));
	});

	it("cleans the output the model reads", () => {
		assert.match(statusText(snap({ output: "\u001b[32mgreen\u001b[0m\n" }), 2000), /\ngreen$/);
	});

	it("lists one line per process, or says there are none", () => {
		assert.equal(listText([], 0), "No background processes.");
		const text = listText([snap(), snap({ id: "bg-2", name: "build", command: "make", state: "done", exitCode: 0, endedAt: 4000, pid: undefined })], 13_000);
		assert.deepEqual(text.split("\n"), ['bg-1 "dev server": running for 12s (pid 123): npm run dev', 'bg-2 "build": done (exit 0) after 3s: make']);
	});

	it("reports a kill with the final state", () => {
		assert.match(killText(snap({ state: "killed", signal: "SIGTERM", endedAt: 4000, output: "bye" }), 5000), /^Killed bg-1 "dev server": killed \(SIGTERM\) after 3s/);
		assert.match(killText(snap({ state: "done", exitCode: 0, endedAt: 4000 }), 5000), /^bg-1 "dev server" was not running: done \(exit 0\) after 3s/);
	});
});

describe("status line", () => {
	it("shows the running count only while any run", () => {
		assert.equal(statusLine(0), undefined);
		assert.equal(statusLine(1), "bg: 1 running");
		assert.equal(statusLine(3), "bg: 3 running");
	});
});

describe("overlay", () => {
	it("title counts running and finished", () => {
		assert.equal(psTitle([snap(), snap({ id: "bg-2", state: "done" }), snap({ id: "bg-3", state: "killed" })]), "Background processes · 1 running · 2 finished");
		assert.equal(psTitle([]), "Background processes · none");
	});

	it("one row per process with a tone for its state", () => {
		const rows = psRows([snap(), snap({ id: "bg-2", name: "b", state: "done", exitCode: 0, endedAt: 4000 }), snap({ id: "bg-3", name: "c", state: "failed", exitCode: 1, endedAt: 2000 }), snap({ id: "bg-4", name: "d", state: "killed", endedAt: 2000 })], 13_000);
		assert.deepEqual(rows.map((r) => r.tone), ["text", "success", "error", "muted"]);
		assert.match(rows[0].text, /^bg-1 .*dev server/);
		assert.match(rows[0].text, /12s/);
	});

	it("detail shows header facts and the output wrapped to the pane, never the escape codes", () => {
		const rows = psDetail(snap({ output: `\u001b[31m${"word ".repeat(20)}\u001b[0m\nsecond\n` }), 30, 2000);
		const text = rows.map((r) => r.text);
		assert.equal(text[0], 'bg-1 "dev server"');
		assert.ok(text.some((t) => t === "command: npm run dev"));
		assert.ok(text.includes("second"));
		assert.ok(rows.every((r) => !r.text.includes("\u001b") && r.text.length <= 30));
	});

	it("detail says so when there is no output, and when the tail dropped older output", () => {
		assert.ok(psDetail(snap(), 40, 2000).some((r) => /no output yet/.test(r.text)));
		assert.ok(psDetail(snap({ output: "x", truncatedBytes: 5000 }), 60, 2000).some((r) => /earlier output was dropped/.test(r.text)));
	});

	it("detail width matches the two-pane right pane", () => {
		assert.equal(detailWidth(120), 120 - 40 - 3);
		assert.ok(detailWidth(10) >= 10);
	});

	it("footer names the keys", () => {
		assert.match(psFooter(), /x kill/);
		assert.match(psFooter(), /q close/);
	});
});
