import assert from "node:assert/strict";
import { test } from "node:test";
import { BUS, CHANNELS, createBus, PHASES } from "../lib/bus.ts";
import { BRIDGE_READY, DASHBOARD_PLUGIN_ID, installDashboardAdapter, INVALIDATE, LIST_MODULES, REGISTER_FORWARD } from "../lib/dashboard-adapter.ts";

const recorder = () => {
	const bus = createBus();
	const emitted: Array<{ channel: string; data: any }> = [];
	const emit = bus.emit;
	bus.emit = (channel, data) => {
		emitted.push({ channel, data });
		emit(channel, data);
	};
	return { bus, emitted, of: (channel: string) => emitted.filter((e) => e.channel === channel).map((e) => e.data) };
};

const probe = (bus: ReturnType<typeof createBus>) => {
	const p = { modules: [] as any[] };
	bus.emit(LIST_MODULES, p);
	return p.modules;
};

test("declares every outbound channel at install and again on each bridge-ready", () => {
	const { bus, of } = recorder();
	installDashboardAdapter(bus);
	bus.emit(BRIDGE_READY, {});
	const decls = of(REGISTER_FORWARD);
	assert.equal(decls.length, 2);
	assert.equal(decls[0].pluginId, DASHBOARD_PLUGIN_ID);
	assert.deepEqual(Object.keys(decls[0].channels).sort(), Object.keys(CHANNELS).sort());
	for (const [channel, spec] of Object.entries(CHANNELS)) assert.deepEqual(decls[0].channels[channel], spec);
});

test("answers the module probe with a loop breadcrumb and footer segments", () => {
	const { bus } = recorder();
	installDashboardAdapter(bus);
	const idle = probe(bus);
	const crumb = idle.find((m) => m.kind === "breadcrumb");
	assert.equal(crumb.namespace, "brigadev");
	assert.deepEqual(
		crumb.payload.steps.map((s: any) => [s.id, s.status]),
		PHASES.map((p) => [p, "pending"]),
	);

	bus.emit(BUS.phase, { scope: "loop", phase: "implement", visited: ["authorize", "explore", "implement"], running: true, since: 0, source: "inferred" });
	bus.emit(BUS.mode, { scope: "mode", mode: "normal" });
	bus.emit(BUS.check, { id: "c", command: "npm test", outcome: "fail", at: 0 });
	bus.emit(BUS.agent, { id: "l:0", status: "running" });
	bus.emit(BUS.agent, { id: "l:1", status: "done" });
	const modules = probe(bus);
	const steps = modules.find((m) => m.kind === "breadcrumb").payload;
	assert.equal(steps.current, "implement");
	assert.deepEqual(
		steps.steps.filter((s: any) => s.status !== "pending").map((s: any) => [s.id, s.status]),
		[
			["authorize", "done"],
			["explore", "done"],
			["implement", "active"],
		],
	);
	const footer = Object.fromEntries(modules.filter((m) => m.kind === "footer-segment").map((m) => [m.id, m.payload.text]));
	assert.deepEqual(footer, { phase: "implement (inferred)", mode: "mode normal", agents: "1 agent running", check: "check fail" });
	for (const m of modules) assert.match(m.namespace, /^[a-z0-9-]+$/);
});

test("invalidates only when what the dashboard shows changes", () => {
	const { bus, of } = recorder();
	installDashboardAdapter(bus);
	bus.emit(BUS.agent, { id: "l:0", status: "running", partial: "a" });
	bus.emit(BUS.agent, { id: "l:0", status: "running", partial: "ab" });
	bus.emit(BUS.agent, { id: "l:0", status: "done" });
	bus.emit(BUS.mode, { scope: "mode", mode: "normal" });
	bus.emit(BUS.mode, { scope: "mode", mode: "normal" });
	assert.equal(of(INVALIDATE).length, 3, "agent started, agent ended, mode set; repeats are free");
});

test("an idle phase marks the last run's steps done and none active", () => {
	const { bus } = recorder();
	installDashboardAdapter(bus);
	bus.emit(BUS.phase, { scope: "loop", phase: "idle", visited: ["authorize", "explore"], running: false, since: 0, source: "inferred" });
	const crumb = probe(bus).find((m) => m.kind === "breadcrumb").payload;
	assert.equal(crumb.current, undefined);
	assert.deepEqual(crumb.steps.slice(0, 3).map((s: any) => s.status), ["done", "done", "pending"]);
});

test("the returned dispose stops listening", () => {
	const { bus, of } = recorder();
	const dispose = installDashboardAdapter(bus);
	dispose();
	bus.emit(BRIDGE_READY, {});
	assert.equal(of(REGISTER_FORWARD).length, 1);
	assert.equal(probe(bus).length, 0);
});
