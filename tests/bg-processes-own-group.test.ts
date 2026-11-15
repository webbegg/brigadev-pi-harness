// S1b regression (real processes): a descendant that sits in a process group of its own must not outlive
// bg_kill or shutdown when the shell itself dies on SIGTERM (`set -m` job control puts `sleep` in its own group).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createBgProcesses } from "../lib/bg-processes.ts";

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function startWithGrandchild(manager: ReturnType<typeof createBgProcesses>) {
	const started = manager.start({ command: "set -m; sleep 600 & echo $!; wait", cwd: process.cwd() });
	let pid = NaN;
	for (let i = 0; i < 50 && Number.isNaN(pid); i++) {
		await sleep(50);
		pid = Number.parseInt(manager.get(started.id)!.output.trim(), 10);
	}
	assert.ok(pid > 1 && alive(pid), "the grandchild started");
	return { id: started.id, grandchild: pid };
}

describe("background process with a grandchild in its own process group (S1b)", { skip: process.platform === "win32" }, () => {
	it("bg_kill leaves nothing alive", async () => {
		const manager = createBgProcesses();
		const { id, grandchild } = await startWithGrandchild(manager);
		try {
			await manager.kill(id);
			await sleep(200);
			assert.equal(alive(grandchild), false, `grandchild ${grandchild} survived bg_kill`);
		} finally {
			if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
		}
	});

	it("shutdown leaves nothing alive", async () => {
		const manager = createBgProcesses();
		const { grandchild } = await startWithGrandchild(manager);
		try {
			await manager.shutdown();
			await sleep(200);
			assert.equal(alive(grandchild), false, `grandchild ${grandchild} survived shutdown`);
		} finally {
			if (alive(grandchild)) process.kill(grandchild, "SIGKILL");
		}
	});
});
