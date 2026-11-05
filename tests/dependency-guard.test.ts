import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { COMMAND_KIND, classifyCommand } from "../lib/command-classifier.ts";
import { decideCommand, MODE_PROMPT, PERMISSION_MODE } from "../lib/permission-policy.ts";

const kinds = (command: string) => classifyCommand(command).map((m) => m.kind);
const decide = (command: string, mode: (typeof PERMISSION_MODE)[keyof typeof PERMISSION_MODE], isChild = false) =>
	decideCommand(classifyCommand(command), mode, isChild).action;

describe("dependency guard", () => {
	it("flags package-manager subcommands after options (monorepo forms)", () => {
		for (const command of ["pnpm --filter web add react", "pnpm -F web install", "pnpm -w add typescript", "npm -w pkg install x", "pnpm -C web install", "npm --prefix=dir install"]) {
			assert.deepEqual(kinds(command), [COMMAND_KIND.DEPENDENCY], command);
		}
	});

	it("sees dependency changes behind env, timeout, python -m pip, and eval", () => {
		for (const command of ["env X=1 npm install", "timeout 60 npm ci", "python -m pip install x", "eval 'npm i'", "(cd web && pnpm i)"]) {
			assert.deepEqual(kinds(command), [COMMAND_KIND.DEPENDENCY], command);
		}
	});

	it("leaves quoted, heredoc, and option-value near-misses alone", () => {
		assert.deepEqual(kinds(`git commit -m "npm install"`), [COMMAND_KIND.DELIVERY]);
		for (const command of ["cat <<EOF > a.md\nnpm install\nEOF", "npm -w pkg test", "npm --prefix dir test", "pnpm --filter web test", "yarn -v", "yarn --help", "npm help install"]) {
			assert.deepEqual(kinds(command), [], command);
		}
	});

	it("asks in normal and yolo and blocks in subagents for every manager family", () => {
		for (const command of ["yarn", "pnpm up", "bun i", "pip3 uninstall x", "uv pip install x", "poetry update", "cargo install x", "go get x", "brew upgrade", "gem install rails"]) {
			assert.equal(decide(command, PERMISSION_MODE.NORMAL), "confirm", command);
			assert.equal(decide(command, PERMISSION_MODE.YOLO), "confirm", command);
			assert.equal(decide(command, PERMISSION_MODE.YOLO, true), "block", command);
		}
	});

	it("keeps hard-deny ahead of a dependency change in every mode", () => {
		for (const command of ["npm install && rm -rf ~", "rm -rf / ; pip install x"]) {
			for (const mode of [PERMISSION_MODE.NORMAL, PERMISSION_MODE.YOLO]) {
				const decision = decideCommand(classifyCommand(command), mode, false);
				assert.equal(decision.action, "block", command);
				assert.match(decision.action === "block" ? decision.reason : "", /never allowed/);
			}
		}
	});

	it("keeps each mode prompt under 220 bytes and says dependency changes still ask in yolo", () => {
		for (const line of Object.values(MODE_PROMPT)) assert.ok(Buffer.byteLength(line) < 220, line);
		assert.match(MODE_PROMPT.yolo, /dependency[^.]*still ask/i);
	});
});
