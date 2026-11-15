// S1b regression (real processes): grandchildren that take a process group of their own survive neither bg_kill nor
// shutdown, whether the shell dies on SIGTERM (perl setpgrp, a chain of shells) or ignores it until the SIGKILL.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBgProcesses } from "../lib/bg-processes.ts";

const alive = (pid: number) => {
	if (!(pid > 1)) throw new Error(`not a pid: ${pid}`);
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const COMMANDS: Record<string, { command: string; pids: number }> = {
	"perl setpgrp": { command: `perl -e 'setpgrp(0,0); exec "sleep","600"' & echo $!; wait`, pids: 1 },
	"a shell chain": { command: `sh -c 'perl -e "setpgrp(0,0); exec q(sleep), q(600)" & echo $!; wait' & echo $!; wait`, pids: 2 },
	"a TERM-ignoring shell": { command: `trap '' TERM; perl -e '$SIG{TERM}="IGNORE"; setpgrp(0,0); exec "sleep","600"' & echo $!; set -m; sleep 600 & echo $!; wait`, pids: 2 },
};

async function start(manager: ReturnType<typeof createBgProcesses>, command: string, count: number) {
	const started = manager.start({ command, cwd: process.cwd() });
	let pids: number[] = [];
	for (let i = 0; i < 100 && pids.length < count; i++) {
		await sleep(50);
		pids = manager.get(started.id)!.output.trim().split(/\s+/).filter(Boolean).map(Number);
		assert.ok(pids.every((pid) => pid > 1), `pids: ${pids}`);
	}
	assert.equal(pids.length, count, "the grandchildren started");
	await sleep(200); // let `perl` exec into `sleep` in its own group
	return { id: started.id, pids };
}

describe("own-group grandchildren variants (S1b)", { skip: process.platform === "win32" }, () => {
	for (const [label, { command, pids: count }] of Object.entries(COMMANDS)) {
		for (const how of ["bg_kill", "shutdown"] as const) {
			it(`${label}: ${how} leaves nothing alive`, async () => {
				const manager = createBgProcesses({ graceMs: 300 });
				const { id, pids } = await start(manager, command, count);
				try {
					if (how === "bg_kill") assert.equal((await manager.kill(id))?.state, "killed");
					else await manager.shutdown();
					await sleep(300);
					assert.deepEqual(pids.filter(alive), [], `survivors after ${how}`);
				} finally {
					for (const pid of pids) if (pid > 1 && alive(pid)) process.kill(pid, "SIGKILL");
				}
			});
		}
	}
});
