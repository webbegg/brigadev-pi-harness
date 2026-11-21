// A process of tests/lock.test.ts: waits for the go file, then takes the store lock once.
//   node lock-child.ts <store path> <go file> hold|die <hold ms>
// hold: prints HELD (and releases twice after the hold time, printing RELEASED) or BUSY. die: takes the lock and kills itself without releasing it.
import { existsSync } from "node:fs";
import { acquireStore } from "../src/cli.ts";

const [storePath, goFile, mode, holdMs] = process.argv.slice(2);
console.log("READY");
while (!existsSync(goFile)) await new Promise((resolve) => setTimeout(resolve, 1));

const held = acquireStore(storePath);
if (mode === "die") {
	if (typeof held === "function") process.kill(process.pid, "SIGKILL");
	process.exit(3);
}
if (typeof held === "number") {
	console.log("BUSY");
} else {
	console.log("HELD");
	await new Promise((resolve) => setTimeout(resolve, Number(holdMs)));
	held();
	held();
	console.log("RELEASED");
}
