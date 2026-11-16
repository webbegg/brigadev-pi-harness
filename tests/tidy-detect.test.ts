import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compactToolsMode, extensionsFromArgv, isTidyExtensionPath, isTidyPackage, tidyActive, tidyEnabled, tidyInstalled, tidyState } from "../lib/tidy-detect.ts";

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

describe("bundled pi-tidy", () => {
	const none = { packages: [], extensionEntries: [], piSettings: undefined };

	it("is bundled (and active) when nothing is installed separately and the copy is available", () => {
		assert.equal(tidyState(none, { bundled: true }), "bundled");
		assert.equal(tidyActive(none, { bundled: true }), true);
		assert.equal(tidyState({}, { bundled: true }), "bundled");
	});

	it("is off without a separate install when the bundled copy is unavailable or no option is given", () => {
		assert.equal(tidyState(none, { bundled: false }), "off");
		assert.equal(tidyState(none), "off");
		assert.equal(tidyActive(none, { bundled: false }), false);
		assert.equal(tidyActive(none), false);
	});

	it("a separate install (package or extensions folder) takes precedence over the bundled copy", () => {
		assert.equal(tidyState({ ...none, packages: ["npm:pi-tidy"] }, { bundled: true }), "separate");
		assert.equal(tidyState({ ...none, packages: [{ source: "git:github.com/Andy8647/pi-tidy" }] }, { bundled: true }), "separate");
		assert.equal(tidyState({ ...none, extensionEntries: ["pi-tidy.ts"] }, { bundled: true }), "separate");
		assert.equal(tidyState({ ...none, extensionEntries: ["pi-tidy.js"] }, { bundled: true }), "separate");
		assert.equal(tidyState({ ...none, packages: ["npm:pi-tidy"] }, { bundled: false }), "separate");
		assert.equal(tidyActive({ ...none, packages: ["npm:pi-tidy"] }, { bundled: true }), true);
	});

	it("tidy.enabled false turns it off in every mode", () => {
		const disabled = { piSettings: { tidy: { enabled: false } } };
		assert.equal(tidyState({ ...none, ...disabled }, { bundled: true }), "off");
		assert.equal(tidyState({ ...none, ...disabled, packages: ["npm:pi-tidy"] }, { bundled: true }), "off");
		assert.equal(tidyState({ ...none, piSettings: { toolbox: { enabled: false } } }, { bundled: true }), "off");
		assert.equal(tidyActive({ ...none, ...disabled }, { bundled: true }), false);
	});

	it("compact tools in auto mode step aside for the bundled copy", () => {
		assert.equal(compactToolsMode("auto", tidyActive(none, { bundled: true })).ours, false);
		assert.equal(compactToolsMode("auto", tidyActive(none, { bundled: false })).ours, true);
	});
});

describe("isTidyExtensionPath", () => {
	it("matches settings `extensions` / -e entries that point at pi-tidy", () => {
		for (const entry of [
			"/Users/me/dev/pi-tidy",
			"/Users/me/dev/pi-tidy/",
			"/Users/me/dev/pi-tidy/src/index.ts",
			"~/dev/pi-tidy/src/index.ts",
			"../pi-tidy/src/index.ts",
			"C:\\dev\\pi-tidy\\src\\index.ts",
			"npm:pi-tidy",
			"npm:pi-tidy@0.9.7",
			"git:github.com/Andy8647/pi-tidy",
			"git:github.com/Andy8647/pi-tidy@v1",
			"https://github.com/Andy8647/pi-tidy.git#main",
		]) {
			assert.equal(isTidyExtensionPath(entry), true, entry);
		}
	});

	it("does not match look-alikes, other entry files or junk", () => {
		for (const entry of ["/x/pi-tidy-extras/src/index.ts", "/x/my-pi-tidy/src/index.ts", "/x/pi-tidy/src/other.ts", "/x/pi-tidy/sub", "/x/other/src/index.ts", "npm:pi-tidy-extras", ""]) {
			assert.equal(isTidyExtensionPath(entry), false, entry);
		}
		for (const junk of [undefined, null, 42, {}, []]) assert.equal(isTidyExtensionPath(junk), false);
	});
});

describe("extensionsFromArgv", () => {
	it("collects the values of -e and --extension in both spellings", () => {
		assert.deepEqual(extensionsFromArgv(["-e", "/a/pi-tidy", "--extension", "npm:pi-tidy", "--extension=/b/x.ts", "-e=/c/y.ts"]), ["/a/pi-tidy", "npm:pi-tidy", "/b/x.ts", "/c/y.ts"]);
	});

	it("ignores other flags, a trailing flag without a value and a flag followed by a flag", () => {
		assert.deepEqual(extensionsFromArgv(["--model", "x", "hello", "-e"]), []);
		assert.deepEqual(extensionsFromArgv(["-e", "--model", "x"]), []);
		assert.deepEqual(extensionsFromArgv([]), []);
	});
});

describe("separate pi-tidy from extensions sources", () => {
	it("tidyInstalled sees pi-tidy.js in the extensions folder", () => {
		assert.equal(tidyInstalled({ extensionEntries: ["pi-tidy.js"] }), true);
		assert.equal(tidyInstalled({ extensionEntries: ["pi-tidy.jsx", "pi-tidy.json"] }), false);
	});

	it("tidyInstalled sees a settings `extensions` / CLI entry for pi-tidy", () => {
		assert.equal(tidyInstalled({ extensions: ["/x/pi-tidy/src/index.ts"] }), true);
		assert.equal(tidyInstalled({ extensions: ["/x/other.ts", "npm:pi-tidy@1"] }), true);
		assert.equal(tidyInstalled({ extensions: ["/x/other.ts", "/x/pi-tidy-extras"] }), false);
	});

	it("such an entry makes the state separate, also with tidy.enabled false for the wrapper's check", () => {
		assert.equal(tidyState({ extensions: ["/x/pi-tidy"] }, { bundled: true }), "separate");
		assert.equal(tidyState({ extensions: ["/x/pi-tidy"], piSettings: { tidy: { enabled: false } } }, { bundled: true }), "off");
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
