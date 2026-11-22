// SIGUSR1 must not open Node's inspector in the Pi process: the agent's bash (`kill -USR1 <pi pid>`) would get an unauthenticated debugger on 127.0.0.1 and could
// run code inside Pi, past the guard (answer its own confirms, change the mode). Loading the guard installs a listener, which keeps the inspector closed.

import assert from "node:assert/strict";
import { test } from "node:test";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";
import { createFakePi } from "./helpers/fake-pi.ts";

installPiStubs();

test("loading the guard installs a SIGUSR1 listener (so the signal opens no inspector), once however often it loads", { skip: process.platform === "win32" }, async () => {
	const before = process.listenerCount("SIGUSR1");
	const guard = (await import("../extensions/guard.ts")).default;
	guard(createFakePi() as any);
	guard(createFakePi() as any);
	assert.equal(process.listenerCount("SIGUSR1"), before + 1);
});
