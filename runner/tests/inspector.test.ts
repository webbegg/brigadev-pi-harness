// SIGUSR1 must not open Node's inspector in the runner: a worker's `kill -USR1 $PPID` would otherwise get an unauthenticated debugger on 127.0.0.1, so code
// running in the runner, with the real environment (tokens, gh login) the containment keeps from the worker.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { connect, createServer } from "node:net";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const CLI = pathToFileURL(new URL("../src/cli.ts", import.meta.url).pathname).href;

const freePort = () =>
	new Promise<number>((done, fail) => {
		const server = createServer();
		server.on("error", fail);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address() as { port: number };
			server.close(() => done(port));
		});
	});

const accepts = (port: number) =>
	new Promise<boolean>((done) => {
		const socket = connect(port, "127.0.0.1");
		socket.on("connect", () => {
			socket.destroy();
			done(true);
		});
		socket.on("error", () => done(false));
	});

const until = async (check: () => Promise<boolean>, ms: number) => {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await check()) return true;
		await new Promise((r) => setTimeout(r, 50));
	}
	return check();
};

async function inspectorOpensAfterSignal(preload: string): Promise<boolean> {
	const port = await freePort();
	const child = spawn(process.execPath, [`--inspect-port=${port}`, "--input-type=module", "-e", `${preload}\nprocess.stdout.write("ready\\n");\nsetInterval(() => {}, 1000);`], {
		stdio: ["ignore", "pipe", "inherit"],
	});
	try {
		await new Promise<void>((done, fail) => {
			child.stdout.on("data", (chunk: Buffer) => chunk.toString().includes("ready") && done());
			child.on("exit", (code) => fail(new Error(`child exited ${code}`)));
		});
		process.kill(child.pid!, "SIGUSR1");
		return await until(() => accepts(port), 1500);
	} finally {
		child.kill("SIGKILL");
	}
}

test("the probe sees the inspector open on SIGUSR1 in a plain node process (the hazard is real here)", async () => {
	assert.equal(await inspectorOpensAfterSignal(""), true);
});

test("SIGUSR1 to a process that loaded the runner CLI opens no inspector", async () => {
	assert.equal(await inspectorOpensAfterSignal(`await import(${JSON.stringify(CLI)});`), false);
});
