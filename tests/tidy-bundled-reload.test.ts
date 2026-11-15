import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TidyInputs } from "../lib/tidy-detect.ts";
import { createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

// pi-tidy patches Pi's shared prototypes once per process and switches them off only when it runs
// again with `tidy.enabled: false` (it writes a global slot, then returns without registering /tidy).
// So with the bundled copy, `enabled: false` must still run pi-tidy; a separate install still wins.

let create: typeof import("../extensions/tidy-bundled.ts").createTidyBundled;
let uninstall: () => void;

before(async () => {
	uninstall = installPiStubs();
	({ createTidyBundled: create } = await import("../extensions/tidy-bundled.ts"));
});
after(() => uninstall());

function setup(inputs: TidyInputs, child = false) {
	const calls = { loads: 0, installs: 0 };
	const factory = create({
		isChild: () => child,
		inputs: () => inputs,
		load: async () => {
			calls.loads++;
			return { default: () => void calls.installs++ };
		},
	});
	return { calls, factory };
}

describe("tidy-bundled wrapper with tidy.enabled false", () => {
	it("still runs the bundled pi-tidy so a /reload can switch its earlier patches off", async () => {
		for (const piSettings of [{ tidy: { enabled: false } }, { toolbox: { enabled: false } }]) {
			const { calls, factory } = setup({ piSettings });
			await factory(createFakePi() as never);
			assert.equal(calls.loads, 1, JSON.stringify(piSettings));
			assert.equal(calls.installs, 1, JSON.stringify(piSettings));
		}
	});

	it("loads nothing when disabled and installed separately (Pi runs the separate copy)", async () => {
		const { calls, factory } = setup({ packages: ["npm:pi-tidy"], piSettings: { tidy: { enabled: false } } });
		await factory(createFakePi() as never);
		assert.equal(calls.loads, 0);
	});

	it("loads nothing in a child session even when disabled", async () => {
		const { calls, factory } = setup({ piSettings: { tidy: { enabled: false } } }, true);
		await factory(createFakePi() as never);
		assert.equal(calls.loads, 0);
	});
});
