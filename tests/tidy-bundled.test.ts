import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { TidyInputs } from "../lib/tidy-detect.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

// The wrapper loads the pi-tidy that ships inside brigadev unless pi-tidy is installed separately.
// Every dependency (child check, settings inputs, the pi-tidy import) is injected, so no real pi-tidy loads here.

let create: typeof import("../extensions/tidy-bundled.ts").createTidyBundled;
let uninstall: () => void;

before(async () => {
	uninstall = installPiStubs();
	({ createTidyBundled: create } = await import("../extensions/tidy-bundled.ts"));
});
after(() => uninstall());

function setup(options: { child?: boolean; inputs?: TidyInputs | (() => TidyInputs); fail?: unknown } = {}) {
	const calls = { loads: 0, installs: [] as unknown[] };
	const factory = create({
		isChild: () => options.child ?? false,
		inputs: typeof options.inputs === "function" ? options.inputs : () => options.inputs ?? {},
		load: async () => {
			calls.loads++;
			if (options.fail !== undefined) throw options.fail;
			return { default: (pi: unknown) => void calls.installs.push(pi) };
		},
	});
	return { calls, factory };
}

describe("tidy-bundled wrapper", () => {
	it("registers nothing and loads nothing in a child session", async () => {
		const pi = createFakePi();
		const { calls, factory } = setup({ child: true });
		await factory(pi as never);
		assert.equal(calls.loads, 0);
		assert.equal(calls.installs.length, 0);
		assert.equal(pi.handlers.size, 0);
	});

	it("does nothing when pi-tidy is installed separately (package or extensions folder)", async () => {
		for (const inputs of [{ packages: ["npm:pi-tidy@0.9.7"] }, { packages: [{ source: "npm:pi-tidy" }] }, { extensionEntries: ["pi-tidy.ts"] }]) {
			const pi = createFakePi();
			const { calls, factory } = setup({ inputs });
			await factory(pi as never);
			assert.equal(calls.loads, 0, JSON.stringify(inputs));
			assert.equal(calls.installs.length, 0);
		}
	});

	it("does nothing when pi-tidy is disabled in its own settings", async () => {
		const { calls, factory } = setup({ inputs: { piSettings: { tidy: { enabled: false } } } });
		await factory(createFakePi() as never);
		assert.equal(calls.loads, 0);
	});

	it("loads the bundled pi-tidy once, handing it the same pi", async () => {
		const pi = createFakePi();
		const { calls, factory } = setup({ inputs: { packages: ["npm:other"], extensionEntries: ["other.ts"] } });
		await factory(pi as never);
		assert.equal(calls.loads, 1);
		assert.deepEqual(calls.installs, [pi]);
	});

	it("a load failure never throws and warns once, on the first session start with a UI", async () => {
		const pi = createFakePi();
		const { calls, factory } = setup({ fail: new Error("Cannot find package 'pi-tidy'") });
		await assert.doesNotReject(async () => factory(pi as never));
		assert.equal(calls.loads, 1);
		const ctx = createFakeCtx({ cwd: process.cwd() });
		await pi.fire("session_start", {}, ctx);
		await pi.fire("session_start", {}, ctx);
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0]?.type, "warning");
		assert.match(ctx.notifications[0]?.message ?? "", /pi-tidy/);
		assert.match(ctx.notifications[0]?.message ?? "", /Cannot find package/);
	});

	it("an install error inside pi-tidy's own factory is also contained", async () => {
		const pi = createFakePi();
		const factory = create({
			isChild: () => false,
			inputs: () => ({}),
			load: async () => ({
				default: () => {
					throw new Error("boom");
				},
			}),
		});
		await assert.doesNotReject(async () => factory(pi as never));
		const ctx = createFakeCtx({ cwd: process.cwd() });
		await pi.fire("session_start", {}, ctx);
		assert.equal(ctx.notifications.length, 1);
		assert.match(ctx.notifications[0]?.message ?? "", /boom/);
	});

	it("a load failure without a UI warns nobody and still does not throw", async () => {
		const pi = createFakePi();
		const { factory } = setup({ fail: "nope" });
		await factory(pi as never);
		const ctx = createFakeCtx({ cwd: process.cwd(), hasUI: false });
		await pi.fire("session_start", {}, ctx);
		assert.equal(ctx.notifications.length, 0);
	});

	it("unreadable settings inputs count as nothing installed", async () => {
		const { calls, factory } = setup({
			inputs: () => {
				throw new Error("EACCES");
			},
		});
		await factory(createFakePi() as never);
		assert.equal(calls.loads, 1);
	});
});
