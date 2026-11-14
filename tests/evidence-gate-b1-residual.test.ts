import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkOutcome } from "../lib/evidence.ts";

// S4 / B1 residual: npm 11.20.0 prints help or its version, exits 0, and runs no script for each of these.
describe("evidence gate: package-manager option values and npm config env never vouch for a pass", () => {
	for (const command of [
		// `-F` / `--filter` are pnpm options; npm does not take a value for them, so the next word is read as an option.
		"npm test -F --help", "npm test --filter --help", "npm test -F -v", "npm run test -F --help", "npm test --filter --usage",
		// npm reads `--color=<value>` and still acts on a flag-like value.
		"npm test --color=-v", "npm test --color=--help", "npm test --color=--usage",
		// npm reads its config from the environment: `usage` prints the usage and skips the script.
		"npm_config_usage=true npm test", "NPM_CONFIG_USAGE=true npm test", "npm_config_usage=1 npm test",
		"export npm_config_usage=true && npm test",
		// Options before `--` are not trusted, by user decision: only `-s` / `--silent` pass.
		"npm test --color=always", "npm test -w pkg", "npm test --workspace=pkg", "npm test --loglevel warn", "pnpm test --filter pkg",
		// Other ways to set npm config in an earlier segment.
		"npm_config_usage=true true && npm test", "pnpm_config_x=1 pnpm test", "yarn_config_x=1 yarn test",
	]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of [
		"npm test", "NODE_ENV=test npm test", "npm test -s", "npm -s test", "npm test --silent", "npm test -- --test-name-pattern=x",
		"export NODE_ENV=test && npm test",
	]) {
		it(`still passes: ${command}`, () => assert.equal(checkOutcome(command, 0), "pass"));
	}
});
