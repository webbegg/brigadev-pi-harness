// Evidence blind spots: exit codes that do not belong to the test, and flags that run no tests, never record a pass.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkOutcome } from "../lib/evidence.ts";

describe("checkOutcome: exit 0 must belong to the test", () => {
	for (const command of [`echo npm test`, `grep -n "node --test" package.json`, `true # npm test`, `: npm test`, `! npm test`, `true || npm test`, `exit 0 && npm test`, `echo pipefail; npm test | cat`]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	it("still passes a plain run and an && chain", () => {
		assert.equal(checkOutcome("npm test", 0), "pass");
		assert.equal(checkOutcome("npm run build && npm test", 0), "pass");
	});
});

describe("checkOutcome: help and version flags run no tests", () => {
	for (const command of [
		"npm test --help", "npm test -h", "npm run test --help", "yarn test --help", "pnpm test --help",
		"node --test --help", "node --test --version", "node --test -v",
		"npx vitest --help", "pytest --version", "go test -h", "cargo test --help",
		"npm test -- --help", "pytest --collect-only", "jest --listTests", "npm test --dry-run",
	]) {
		it(`is not a pass: ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of [
		"npm test -v", "npm run test -v", "yarn test -v", "pnpm test -v",
		"npm test --help=true", "npm test --version=true", "npm test -H", "npm test -?", "npm test --usage", "npm test --h",
		"node --test --help=true", "node --test --v8-options", "npx vitest -v", "npx jest -v",
	]) {
		it(`is not a pass (near-variant): ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	it("still passes npm's own output flags", () => {
		assert.equal(checkOutcome("npm test --silent", 0), "pass");
		assert.equal(checkOutcome("npm test -s", 0), "pass");
	});
	for (const command of ["npm --help test", "cargo test --no-run", "go test -list .", "npx jest --showConfig", "npm test -- --help=true"]) {
		it(`is not a pass (listing, config, or flag before test): ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of ["npm test --workspace=pkg-a", "pnpm test --filter api"]) {
		it(`is not a pass (options before -- are not trusted, by user decision): ${command}`, () => assert.notEqual(checkOutcome(command, 0), "pass"));
	}
	for (const command of [
		"npm test", "npm test -- --test-name-pattern=x", "go test -v ./...", "pytest -v",
		"cargo test -v", "npx vitest run", "node --test tests/*.test.ts", "npm run build && npm test",
	]) {
		it(`still passes: ${command}`, () => assert.equal(checkOutcome(command, 0), "pass"));
	}
	it("still passes runner arguments that run tests", () => {
		assert.equal(checkOutcome("npm test -- --test-name-pattern=gate", 0), "pass");
		assert.equal(checkOutcome("node --test tests/evidence.test.ts", 0), "pass");
		assert.equal(checkOutcome("go test -v ./...", 0), "pass");
		assert.equal(checkOutcome("pytest -v", 0), "pass");
	});
});

describe("checkOutcome: package-manager option values and npm config env never vouch for a pass", () => {
	// npm prints help or its version, exits 0, and runs no script for each of these.
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
	for (const command of ["NODE_ENV=test npm test", "npm -s test", "export NODE_ENV=test && npm test"]) {
		it(`still passes: ${command}`, () => assert.equal(checkOutcome(command, 0), "pass"));
	}
});
