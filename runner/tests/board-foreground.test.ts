// R4-003: `brigadev-runner start <doc> --web &` from an interactive shell leaves stdin and stdout on the terminal but puts the process in a background job. Reading the
// terminal from there raises SIGTTIN, whose default action stops the process: the runner would sit suspended mid-loop, holding the store, without a word. So `--web` refuses
// (exit 2, before the store, the lock or the server) when this process is not in the terminal's foreground process group, and says to run it in the foreground.
// Node has no `tcgetpgrp`, so the two facts (this process's group, the terminal's foreground group) come from /proc/<pid>/stat on Linux and `ps` elsewhere, once, at start-up.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { after, afterEach, before, beforeEach, describe, it } from "node:test";
import * as cli from "../src/cli.ts";
import { docText, isolateEnv, makeWorkspace, type Workspace } from "./fixture.ts";

let restoreEnv: () => void;
let env: Record<string, string | undefined>;
before(() => {
	restoreEnv = isolateEnv().restore;
	env = { BRIGADEV_HOME: process.env.BRIGADEV_HOME };
});
after(() => restoreEnv());

let ws: Workspace;
beforeEach(() => {
	ws = makeWorkspace();
});
afterEach(() => ws.cleanup());

const T1 = "- T1 [S1] inline: storage deps: none done: `test -f t1.txt` — pending";

async function run(args: string[], terminal: cli.Terminal) {
	let stdout = "";
	let stderr = "";
	const code = await cli.main(args, env, { out: (text) => (stdout += `${text}\n`), err: (text) => (stderr += `${text}\n`) }, ws.repo, terminal);
	return { code, stdout, stderr };
}

describe("the decision: background means the terminal's foreground group is known and is not ours", () => {
	it("is background only when both groups are known and differ; unknown (no controlling terminal, no way to read it) is not", () => {
		assert.equal(cli.isBackground({ pgid: 100, tpgid: 200 }), true, "the shell's group has the terminal: this is a background job");
		assert.equal(cli.isBackground({ pgid: 100, tpgid: 100 }), false, "foreground");
		for (const tpgid of [0, -1, Number.NaN]) assert.equal(cli.isBackground({ pgid: 100, tpgid }), false, `tpgid ${tpgid}: no controlling terminal`);
		assert.equal(cli.isBackground({ pgid: 0, tpgid: 200 }), false);
		assert.equal(cli.isBackground(undefined), false, "not readable: not refused");
	});

	it("reads the two groups from /proc/<pid>/stat (a command name with spaces and `)`) and from `ps -o pgid=,tpgid=`, and nothing else", () => {
		// pid (comm) state ppid pgrp session tty_nr tpgid flags ...
		assert.deepEqual(cli.parseProcStat("4242 (node) S 4000 4242 4000 34816 4300 4194304 1 0"), { pgid: 4242, tpgid: 4300 });
		assert.deepEqual(cli.parseProcStat("77 (a b) c) R 1 77 77 0 -1 4194560 1 0"), { pgid: 77, tpgid: -1 });
		assert.equal(cli.parseProcStat("garbage"), undefined);
		assert.deepEqual(cli.parsePsGroups("  4242  4300\n"), { pgid: 4242, tpgid: 4300 });
		assert.deepEqual(cli.parsePsGroups("27905    0\n"), { pgid: 27905, tpgid: 0 });
		assert.equal(cli.parsePsGroups(""), undefined);
		assert.equal(cli.parsePsGroups("12 -\n"), undefined, "a non-number is unknown, not a group");
	});

	it("reads a real process: a session of its own leads its group and has no terminal (never background)", async () => {
		const child = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
		try {
			const facts = cli.readGroupFacts(child.pid!);
			assert.ok(facts, "the groups of a live process can be read here");
			assert.equal(facts.pgid, child.pid, "detached: its own session, its own group");
			assert.equal(cli.isBackground(facts), false);
			const me = cli.readGroupFacts(process.pid);
			assert.ok(me && me.pgid > 0, "and of this process");
		} finally {
			child.kill("SIGKILL");
		}
	});
});

describe("`--web` in the background of its terminal refuses before anything starts", () => {
	const START = () => ["start", ws.docPath, "--web"];
	const storeExists = () => existsSync(cli.storePathFor(ws.repo, env));

	it("exit 2 with the reason and the way out; no link, no store", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const result = await run(START(), { stdinIsTTY: true, stdoutIsTTY: true, inBackground: () => true });
		assert.equal(result.code, 2);
		assert.match(result.stderr, /--web must run in the foreground/);
		assert.match(result.stderr, /background job/);
		assert.match(result.stderr, /SIGTTIN/, "says what would happen to it");
		assert.match(result.stderr, /without `&`|`fg`/, "and what to do");
		assert.equal(result.stdout, "");
		assert.equal(storeExists(), false);
	});

	it("in the foreground it goes on to the checks that come after; without --web the question is never asked", async () => {
		writeFileSync(ws.docPath, docText([T1]));
		const foreground = await run(START(), { stdinIsTTY: true, stdoutIsTTY: true, inBackground: () => false });
		assert.equal(foreground.code, 1);
		assert.match(foreground.stderr, /not a linked git worktree/);
		const never = () => {
			throw new Error("asked without --web");
		};
		const plain = await run(["start", ws.docPath], { stdinIsTTY: true, stdoutIsTTY: true, inBackground: never });
		assert.equal(plain.code, 1);
		assert.match(plain.stderr, /not a linked git worktree/);
		const piped = await run(START(), { stdinIsTTY: false, stdoutIsTTY: true, inBackground: never });
		assert.equal(piped.code, 2, "the terminal check comes first, and does not need the groups");
		assert.match(piped.stderr, /--web needs a terminal/);
	});
});
