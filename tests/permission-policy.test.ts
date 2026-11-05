import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { decideCommand, isSensitivePath, PERMISSION_MODE } from "../lib/permission-policy.ts";

const decide = (command: string, mode = PERMISSION_MODE.NORMAL, isChild = false) => decideCommand(classifyCommand(command), mode, isChild).action;

describe("decideCommand", () => {
	it("allows ordinary commands in every mode", () => {
		assert.equal(decide("npm test"), "allow");
		assert.equal(decide("npm test", PERMISSION_MODE.YOLO), "allow");
		assert.equal(decide("npm test", PERMISSION_MODE.NORMAL, true), "allow");
	});

	it("asks before delivery in normal mode only", () => {
		assert.equal(decide("git commit -m x"), "confirm");
		assert.equal(decide("git commit -m x", PERMISSION_MODE.YOLO), "allow");
		assert.equal(decide("gh pr create --fill", PERMISSION_MODE.YOLO), "allow");
	});

	it("keeps destructive, publish, and privileged confirmations in yolo", () => {
		assert.equal(decide("git push --force", PERMISSION_MODE.YOLO), "confirm");
		assert.equal(decide("npm publish", PERMISSION_MODE.YOLO), "confirm");
		assert.equal(decide("sudo make install", PERMISSION_MODE.YOLO), "confirm");
	});

	it("blocks hard-deny forms everywhere", () => {
		assert.equal(decide("rm -rf ~", PERMISSION_MODE.YOLO), "block");
	});

	it("blocks every risky kind in subagents, including delivery", () => {
		assert.equal(decide("git commit -m x", PERMISSION_MODE.YOLO, true), "block");
		assert.equal(decide("rm -rf build", PERMISSION_MODE.NORMAL, true), "block");
	});
});

describe("isSensitivePath", () => {
	it("recognizes secret files", () => {
		for (const path of [".env", "app/.env.local", "/Users/x/.ssh/config", "certs/server.pem", "id_ed25519", "/Users/x/.pi/agent/auth.json"]) {
			assert.equal(isSensitivePath(path), true, path);
		}
	});

	it("allows templates and ordinary files", () => {
		for (const path of [".env.example", "src/env.ts", "README.md", "keyboard.ts"]) {
			assert.equal(isSensitivePath(path), false, path);
		}
	});
});
