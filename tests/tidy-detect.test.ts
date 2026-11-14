import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactToolsMode, isTidyPackage, tidyActive, tidyEnabled } from "../lib/tidy-detect.ts";

describe("isTidyPackage", () => {
	it("matches npm, git, url and local sources of pi-tidy", () => {
		for (const source of [
			"npm:pi-tidy",
			"npm:pi-tidy@0.9.7",
			"git:github.com/Andy8647/pi-tidy",
			"git:github.com/Andy8647/pi-tidy@v1",
			"git:github.com/Andy8647/pi-tidy.git",
			"https://github.com/Andy8647/pi-tidy",
			"https://github.com/Andy8647/pi-tidy.git#main",
			"/Users/me/dev/pi-tidy",
			"/Users/me/dev/pi-tidy/",
			"~/dev/pi-tidy",
			"../pi-tidy",
			"pi-tidy",
		]) {
			assert.equal(isTidyPackage(source), true, source);
		}
	});

	it("matches object entries by their source", () => {
		assert.equal(isTidyPackage({ source: "npm:pi-tidy", autoload: true }), true);
		assert.equal(isTidyPackage({ source: "npm:other" }), false);
	});

	it("does not match look-alikes or junk", () => {
		for (const source of ["npm:pi-tidy-extras", "npm:my-pi-tidyish", "/x/my-pi-tidy", "git:github.com/a/pi-tidy-extras", "npm:pi-tidy-extras@1.0.0", "npm:@scope/other", "", "/x/pi-tidy/sub"]) {
			assert.equal(isTidyPackage(source), false, source);
		}
		for (const junk of [undefined, null, 42, {}, { source: 7 }, []]) assert.equal(isTidyPackage(junk), false);
	});

	it("matches a scoped package named pi-tidy", () => {
		assert.equal(isTidyPackage("npm:@andy/pi-tidy@1.2.3"), true);
	});
});

describe("tidyEnabled", () => {
	it("is enabled with no config, empty config or non-objects", () => {
		for (const s of [undefined, null, {}, "x", [], { tidy: {} }, { tidy: "x" }, { toolbox: { enabled: true } }]) {
			assert.equal(tidyEnabled(s), true);
		}
	});

	it("is disabled by tidy.enabled === false", () => {
		assert.equal(tidyEnabled({ tidy: { enabled: false } }), false);
	});

	it("honors the legacy toolbox key", () => {
		assert.equal(tidyEnabled({ toolbox: { enabled: false } }), false);
	});

	it("tidy takes precedence over toolbox (same as tidy ?? toolbox)", () => {
		assert.equal(tidyEnabled({ tidy: { enabled: true }, toolbox: { enabled: false } }), true);
		assert.equal(tidyEnabled({ tidy: { enabled: false }, toolbox: { enabled: true } }), false);
		assert.equal(tidyEnabled({ tidy: {}, toolbox: { enabled: false } }), true);
	});

	it("only the boolean false disables it", () => {
		assert.equal(tidyEnabled({ tidy: { enabled: 0 } }), true);
		assert.equal(tidyEnabled({ tidy: { enabled: "false" } }), true);
	});
});

describe("tidyActive", () => {
	const base = { packages: [], extensionEntries: [], piSettings: undefined };

	it("is inactive when not installed", () => {
		assert.equal(tidyActive(base), false);
		assert.equal(tidyActive({ ...base, packages: ["npm:pi-tidy-extras"], extensionEntries: ["pi-tidy-extras.ts", "other"] }), false);
	});

	it("is active when installed as a package", () => {
		assert.equal(tidyActive({ ...base, packages: ["npm:foo", "npm:pi-tidy@0.9.7"] }), true);
		assert.equal(tidyActive({ ...base, packages: [{ source: "npm:pi-tidy" }] }), true);
	});

	it("is active when installed in the extensions folder", () => {
		assert.equal(tidyActive({ ...base, extensionEntries: ["pi-tidy"] }), true);
		assert.equal(tidyActive({ ...base, extensionEntries: ["pi-tidy.ts"] }), true);
	});

	it("is inactive when installed but disabled", () => {
		assert.equal(tidyActive({ packages: ["npm:pi-tidy"], extensionEntries: [], piSettings: { tidy: { enabled: false } } }), false);
		assert.equal(tidyActive({ packages: [], extensionEntries: ["pi-tidy.ts"], piSettings: { toolbox: { enabled: false } } }), false);
	});

	it("is inactive when disabled but not installed, and tolerates a missing packages list", () => {
		assert.equal(tidyActive({ ...base, piSettings: { tidy: { enabled: true } } }), false);
		assert.equal(tidyActive({ packages: undefined, extensionEntries: undefined, piSettings: undefined }), false);
	});
});

describe("compactToolsMode", () => {
	it("auto (and undefined) steps aside only when pi-tidy is active", () => {
		for (const setting of ["auto", undefined] as const) {
			assert.equal(compactToolsMode(setting, true).ours, false);
			assert.equal(compactToolsMode(setting, false).ours, true);
		}
		assert.match(compactToolsMode("auto", true).reason, /pi-tidy active/);
		assert.match(compactToolsMode(undefined, true).reason, /auto/);
		assert.match(compactToolsMode("auto", false).reason, /pi-tidy not active/);
	});

	it("true is always ours", () => {
		assert.equal(compactToolsMode(true, true).ours, true);
		assert.equal(compactToolsMode(true, false).ours, true);
		assert.match(compactToolsMode(true, true).reason, /ui\.compactTools true/);
	});

	it("false is never ours", () => {
		assert.equal(compactToolsMode(false, true).ours, false);
		assert.equal(compactToolsMode(false, false).ours, false);
		assert.match(compactToolsMode(false, false).reason, /ui\.compactTools false/);
	});
});
