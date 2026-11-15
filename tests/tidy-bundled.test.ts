import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { tidyInstalled, tidyState, type TidyInputs } from "../lib/tidy-detect.ts";
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

describe("readTidyInputs sources", () => {
	let root: string;
	let agent: string;
	let project: string;
	let readTidyInputs: typeof import("../extensions/tidy-bundled.ts").readTidyInputs;

	before(async () => {
		({ readTidyInputs } = await import("../extensions/tidy-bundled.ts"));
		root = mkdtempSync(join(tmpdir(), "tidy-inputs-"));
		agent = join(root, "agent");
		project = join(root, "project");
		mkdirSync(join(agent, "extensions"), { recursive: true });
		mkdirSync(join(project, ".pi"), { recursive: true });
	});
	after(() => rmSync(root, { recursive: true, force: true }));

	const write = (path: string, value: unknown) => writeFileSync(path, JSON.stringify(value));
	const read = (options: { argv?: string[]; bundledRoots?: string[] } = {}) => readTidyInputs(project, agent, { argv: [], bundledRoots: [], ...options });
	const installed = (inputs: TidyInputs) => tidyInstalled(inputs);

	it("sees nothing when no source mentions pi-tidy", () => {
		write(join(agent, "settings.json"), { extensions: ["/x/other.ts"] });
		write(join(project, ".pi", "settings.json"), { extensions: ["/y/other.ts"] });
		assert.equal(installed(read({ argv: ["-e", "/z/other.ts"] })), false);
	});

	it("sees pi-tidy in the global settings extensions array", () => {
		write(join(agent, "settings.json"), { extensions: ["/g/pi-tidy/src/index.ts"] });
		write(join(project, ".pi", "settings.json"), {});
		assert.equal(tidyState(read(), { bundled: true }), "separate");
	});

	it("sees pi-tidy in the project settings extensions array", () => {
		write(join(agent, "settings.json"), {});
		write(join(project, ".pi", "settings.json"), { extensions: ["npm:pi-tidy"] });
		assert.equal(tidyState(read(), { bundled: true }), "separate");
	});

	it("sees pi-tidy passed with -e or --extension on the command line", () => {
		write(join(agent, "settings.json"), {});
		write(join(project, ".pi", "settings.json"), {});
		for (const argv of [["-e", "/c/pi-tidy"], ["--extension", "/c/pi-tidy/src/index.ts"], ["--extension=npm:pi-tidy@1"]]) {
			assert.equal(installed(read({ argv })), true, argv.join(" "));
		}
	});

	it("sees pi-tidy.js in the agent extensions folder", () => {
		write(join(agent, "settings.json"), {});
		writeFileSync(join(agent, "extensions", "pi-tidy.js"), "");
		try {
			assert.equal(installed(read()), true);
		} finally {
			rmSync(join(agent, "extensions", "pi-tidy.js"));
		}
	});

	it("tolerates a non-array extensions value", () => {
		write(join(agent, "settings.json"), { extensions: "/g/pi-tidy" });
		write(join(project, ".pi", "settings.json"), { extensions: { a: 1 } });
		assert.equal(installed(read()), false);
	});

	it("never treats brigadev's own bundled pi-tidy path as a separate install", () => {
		const bundled = join(root, "brigadev", "node_modules", "pi-tidy");
		write(join(agent, "settings.json"), { extensions: [bundled, join(bundled, "src", "index.ts")] });
		write(join(project, ".pi", "settings.json"), {});
		assert.equal(installed(read({ bundledRoots: [bundled], argv: ["-e", bundled, "--extension", `${bundled}/src/index.ts`] })), false);
		// a different pi-tidy checkout still counts
		assert.equal(installed(read({ bundledRoots: [bundled], argv: ["-e", join(root, "other", "pi-tidy")] })), true);
	});

	it("the default bundled roots include this package's node_modules/pi-tidy", async () => {
		const { PACKAGE_ROOT } = await import("../lib/runtime.ts");
		write(join(agent, "settings.json"), {});
		write(join(project, ".pi", "settings.json"), {});
		const own = join(PACKAGE_ROOT, "node_modules", "pi-tidy");
		assert.equal(installed(readTidyInputs(project, agent, { argv: ["-e", own] })), false);
	});
});

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

	it("still runs the bundled pi-tidy when disabled in its own settings (it switches its patches off itself)", async () => {
		const { calls, factory } = setup({ inputs: { piSettings: { tidy: { enabled: false } } } });
		await factory(createFakePi() as never);
		assert.equal(calls.loads, 1);
		assert.equal(calls.installs.length, 1);
	});

	it("does nothing when a separate pi-tidy comes from a settings or CLI extensions entry", async () => {
		for (const inputs of [{ extensions: ["/x/pi-tidy/src/index.ts"] }, { extensions: ["npm:pi-tidy"] }, { extensionEntries: ["pi-tidy.js"] }]) {
			const { calls, factory } = setup({ inputs });
			await factory(createFakePi() as never);
			assert.equal(calls.loads, 0, JSON.stringify(inputs));
		}
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
