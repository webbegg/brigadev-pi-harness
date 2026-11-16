import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extensionsFromArgv, tidyInstalled, tidyState } from "../lib/tidy-detect.ts";

// Recheck of be74596: a separate pi-tidy reached through -e / --extension or a settings `extensions`
// entry counts as separate (so the bundled copy never loads twice), and tidy.enabled false reports off.
describe("pi-tidy separate-install forms (recheck)", () => {
	it("counts -e npm:pi-tidy and --extension npm:pi-tidy in either order next to brigadev", () => {
		const brigadev = "git:github.com/webbegg/brigadev-pi-harness@feat/bundle-pi-tidy";
		for (const argv of [
			["-e", "npm:pi-tidy", "-e", brigadev, "--mode", "rpc", "--no-session"],
			["-e", brigadev, "-e", "npm:pi-tidy", "--mode", "rpc"],
			["--extension", "npm:pi-tidy", "-e", brigadev],
		]) {
			const extensions = extensionsFromArgv(argv);
			assert.equal(tidyInstalled({ extensions }), true, argv.join(" "));
			assert.equal(tidyState({ extensions }, { bundled: true }), "separate", argv.join(" "));
		}
	});

	it("does not count brigadev itself or an unrelated -e as pi-tidy", () => {
		const extensions = extensionsFromArgv(["-e", "git:github.com/webbegg/brigadev-pi-harness@feat/bundle-pi-tidy", "-e", "/tmp/probe.ts"]);
		assert.equal(tidyInstalled({ extensions }), false);
		assert.equal(tidyState({ extensions }, { bundled: true }), "bundled");
	});

	it("counts a settings extensions entry for a pi-tidy checkout directory or its entry file", () => {
		for (const entry of ["/tmp/x/checkout/pi-tidy", "/tmp/x/checkout/pi-tidy/src/index.ts", "~/src/pi-tidy"]) {
			assert.equal(tidyState({ extensions: [entry] }, { bundled: true }), "separate", entry);
		}
	});

	it("reports off with tidy.enabled false even when only the bundled copy exists", () => {
		assert.equal(tidyState({ piSettings: { tidy: { enabled: false } } }, { bundled: true }), "off");
		assert.equal(tidyInstalled({ piSettings: { tidy: { enabled: false } } }), false);
	});
});
