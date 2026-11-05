import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyCommand } from "../lib/command-classifier.ts";
import { commandPreview, decideCommand, isSensitivePath, MODE_PROMPT, PERMISSION_MODE } from "../lib/permission-policy.ts";

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

describe("decideCommand for dependency changes", () => {
	it("asks in normal and in yolo", () => {
		for (const command of ["npm install", "pip install requests", "uv sync"]) {
			assert.equal(decide(command, PERMISSION_MODE.NORMAL), "confirm", command);
			assert.equal(decide(command, PERMISSION_MODE.YOLO), "confirm", command);
		}
	});

	it("blocks in subagents", () => {
		assert.equal(decide("npm install", PERMISSION_MODE.NORMAL, true), "block");
		assert.equal(decide("pip install x", PERMISSION_MODE.YOLO, true), "block");
	});

	it("still allows read-only package-manager commands", () => {
		assert.equal(decide("npm ls", PERMISSION_MODE.YOLO), "allow");
		assert.equal(decide("npm run build", PERMISSION_MODE.NORMAL, true), "allow");
	});

	it("asks for a dependency change chained after a waived delivery in yolo", () => {
		assert.equal(decide("git commit -m x && npm install", PERMISSION_MODE.YOLO), "confirm");
	});

	it("keeps the mode prompts accurate", () => {
		assert.match(MODE_PROMPT.yolo, /dependency/i);
		assert.match(MODE_PROMPT.normal, /dependency/i);
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

describe("commandPreview", () => {
	it("keeps short commands intact", () => {
		assert.equal(commandPreview("git commit -m x"), "git commit -m x");
	});

	it("keeps the head and the tail of long commands, where the risky part usually is", () => {
		const script = ["cd /repo", "python3 - <<'E'", ...Array.from({ length: 30 }, (_, i) => `line ${i}`), "E", "git add -A && git commit -m 'feat: x'"].join("\n");
		const preview = commandPreview(script);
		const lines = preview.split("\n");
		assert.ok(lines.length <= 7, `got ${lines.length} lines`);
		assert.equal(lines[0], "cd /repo");
		assert.equal(lines.at(-1), "git add -A && git commit -m 'feat: x'");
		assert.match(preview, /… 28 more lines …/);
	});

	it("clips very long lines", () => {
		const preview = commandPreview(`echo ${"x".repeat(500)}`);
		assert.ok(preview.length <= 161);
		assert.ok(preview.endsWith("…"));
	});
});
