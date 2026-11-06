import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PanelStore, panelState } from "../lib/panel-state.ts";

describe("panel store", () => {
	it("returns undefined for a section nobody published", () => {
		assert.equal(new PanelStore().read("todos"), undefined);
	});

	it("keeps the latest value per section", () => {
		const store = new PanelStore();
		store.publish("cost", { cost: 0.5, apiEquivalent: true });
		store.publish("cost", { cost: 0.9, apiEquivalent: true });
		store.publish("todos", [{ id: "T1", text: "x", status: "pending" }]);
		assert.deepEqual(store.read("cost"), { cost: 0.9, apiEquivalent: true });
		assert.equal(store.read("todos")?.length, 1);
	});

	it("notifies subscribers with the section that changed", () => {
		const store = new PanelStore();
		const seen: string[] = [];
		store.subscribe((section) => seen.push(section));
		store.publish("todos", []);
		store.publish("agents", []);
		assert.deepEqual(seen, ["todos", "agents"]);
	});

	it("stops notifying after unsubscribe, and unsubscribing twice is harmless", () => {
		const store = new PanelStore();
		let calls = 0;
		const unsubscribe = store.subscribe(() => calls++);
		store.publish("agents", []);
		unsubscribe();
		unsubscribe();
		store.publish("agents", []);
		assert.equal(calls, 1);
	});

	it("keeps notifying the others when one subscriber throws", () => {
		const store = new PanelStore();
		let calls = 0;
		store.subscribe(() => {
			throw new Error("boom");
		});
		store.subscribe(() => calls++);
		store.publish("agents", []);
		assert.equal(calls, 1);
	});

	it("is shared process-wide", () => {
		assert.equal(panelState(), panelState());
	});
});
