import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { descendantTargets, type ProcessEntry } from "../lib/child-run.ts";

// S5: forced kills reach the child's descendant groups, and nothing else.
const SELF = 100;
const SELF_GROUP = 90;
const CHILD = 4242;
const HOSTILE: ProcessEntry[] = [
	{ pid: SELF, ppid: 50, pgid: SELF_GROUP }, // the parent, in a job group it does not lead
	{ pid: 50, ppid: 1, pgid: 50 }, // the user's shell
	{ pid: CHILD, ppid: SELF, pgid: CHILD },
	{ pid: 4300, ppid: CHILD, pgid: 4300 },
	{ pid: 4301, ppid: 4300, pgid: SELF_GROUP }, // a descendant in the parent's group
	{ pid: 4302, ppid: 4300, pgid: 0 },
	{ pid: 4303, ppid: 4300, pgid: 1 },
	{ pid: 0, ppid: CHILD, pgid: 0 },
	{ pid: 1, ppid: CHILD, pgid: 1 },
	{ pid: SELF, ppid: CHILD, pgid: SELF_GROUP }, // the parent again, as a descendant (bogus)
	{ pid: 4400, ppid: SELF, pgid: 4400 }, // a sibling launch: not under the child
	{ pid: 4401, ppid: 1, pgid: 4401 }, // reparented, unrelated group
	{ pid: 4500, ppid: 4300, pgid: 4500 },
	{ pid: 4500, ppid: 4300, pgid: 4500 }, // duplicate row
	{ pid: 4501, ppid: 4500, pgid: 4300 },
	{ pid: 4300, ppid: 4501, pgid: 4300 }, // cycle in parent links
];

describe("descendantTargets safety (S5)", () => {
	it("a hostile table yields only descendant groups and a pid for the one in the parent's group", () => {
		const t = descendantTargets(CHILD, HOSTILE, SELF);
		assert.deepEqual(t.groups.map((g) => g.pgid).sort((a, b) => a - b), [4300, 4500]);
		assert.deepEqual(t.pids, [4301]);
	});

	it("never walks through the parent or pid 1 listed under the child", () => {
		const t = descendantTargets(
			CHILD,
			[
				{ pid: SELF, ppid: CHILD, pgid: SELF_GROUP },
				{ pid: 7000, ppid: SELF, pgid: 7000 },
				{ pid: 1, ppid: CHILD, pgid: 1 },
				{ pid: 7100, ppid: 1, pgid: 7100 },
			],
			SELF,
		);
		assert.deepEqual(t, { groups: [], pids: [] });
	});

	it("huge flat and deep tables stay bounded", () => {
		const flat = [{ pid: SELF, ppid: 1, pgid: SELF_GROUP }, ...Array.from({ length: 200_000 }, (_, i) => ({ pid: 10_000 + i, ppid: CHILD, pgid: 10_000 + i }))];
		const a = descendantTargets(CHILD, flat, SELF);
		assert.ok(a.groups.length + a.pids.length <= 1000);
		const deep = [{ pid: SELF, ppid: 1, pgid: SELF_GROUP }, ...Array.from({ length: 100_000 }, (_, i) => ({ pid: 10_000 + i, ppid: i === 0 ? CHILD : 9_999 + i, pgid: 77 }))];
		const b = descendantTargets(CHILD, deep, SELF);
		assert.deepEqual(b.groups.map((g) => g.pgid), [77]);
		assert.ok(b.groups[0].pids.length <= 1000);
	});
});

// A real stubborn child: ignores SIGTERM and leaves tool processes in groups of their own. The parent process exits
// (exit guard, killAllNow): no descendant may survive it.
const STUBBORN = `import * as fs from "node:fs";
import { spawn } from "node:child_process";
process.on("SIGTERM", () => {});
let buf = "";
process.stdin.on("data", (c) => {
	buf += c;
	if (!buf.includes('"prompt"')) return;
	const a = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
	const b = spawn("sh", ["-c", "sleep 61 & echo $! > \\"$1\\"; wait", "sh", process.env.FAKE_LOG + ".nested"], { detached: true, stdio: "ignore" });
	a.unref(); b.unref();
	setTimeout(() => fs.writeFileSync(process.env.FAKE_LOG, JSON.stringify([process.pid, a.pid, b.pid])), 300);
	setInterval(() => {}, 1000);
});
`;
const PARENT = (lib: string, fake: string, log: string, out: string) => `import * as fs from "node:fs";
const { runChild, installParentExitGuard, liveChildren } = await import(${JSON.stringify(lib)});
installParentExitGuard(liveChildren);
const root = fs.mkdtempSync(${JSON.stringify(path.join(os.tmpdir(), "brigadev-exit-guard-"))});
for (const d of ["docs", "tmp", "proj"]) fs.mkdirSync(root + "/" + d);
runChild({ cwd: root + "/proj", agent: { name: "scout", description: "d", writer: false, systemPrompt: "s", source: "package", filePath: "/a.md" }, request: { agent: "scout", task: "t", reason: "r" }, taskText: "t", route: { model: "p/m", modelSource: "definition", thinkingSource: "definition" }, routeLabel: "definition", price: () => undefined, onUpdate: () => {} },
	{ piInvocation: (args) => ({ command: process.execPath, args: [${JSON.stringify(fake)}, ...args] }), env: { PATH: process.env.PATH, FAKE_LOG: ${JSON.stringify(log)} }, tmpRoot: root + "/tmp", docsDir: () => root + "/docs" }).catch(() => {});
for (let i = 0; i < 100 && !fs.existsSync(${JSON.stringify(log)}); i++) await new Promise((r) => setTimeout(r, 100));
await new Promise((r) => setTimeout(r, 200));
const pids = JSON.parse(fs.readFileSync(${JSON.stringify(log)}, "utf8"));
pids.push(Number(fs.readFileSync(${JSON.stringify(log)} + ".nested", "utf8")));
fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(pids));
process.exit(0);
`;

it("on parent exit (exit guard), a SIGTERM-ignoring child's descendants in their own groups die too (S5)", { skip: process.platform === "win32" }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-forced-kill-"));
	const fake = path.join(dir, "stubborn.mjs");
	const parent = path.join(dir, "parent.mjs");
	const log = path.join(dir, "pids.json");
	const out = path.join(dir, "out.json");
	fs.writeFileSync(fake, STUBBORN);
	fs.writeFileSync(parent, PARENT(new URL("../lib/child-run.ts", import.meta.url).href, fake, log, out));
	execFileSync(process.execPath, [parent], { stdio: "ignore", timeout: 20_000 });
	const pids: number[] = JSON.parse(fs.readFileSync(out, "utf8"));
	const alive = (pid: number) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	};
	await new Promise((r) => setTimeout(r, 500));
	const survivors = pids.filter(alive);
	for (const pid of survivors) process.kill(pid, "SIGKILL");
	assert.deepEqual(survivors, [], "no descendant outlives the parent");
});
