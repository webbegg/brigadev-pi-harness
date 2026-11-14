import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { changedIds, todoCard, todoDeltaLine, type Todo } from "../lib/todo-card.ts";

describe("todo card", () => {
	const todos: Todo[] = [
		{ id: "T1", text: "lib", status: "done" },
		{ id: "T2", text: "extension", status: "in_progress" },
		{ id: "T3", text: "deploy", status: "blocked", note: "waiting for admin" },
		{ id: "T4", text: "old idea", status: "dropped" },
	];

	it("shows progress without dropped tasks, and blocked notes", () => {
		const card = todoCard(todos, { collapsed: false, staleRuns: 0 })!;
		assert.equal(card.header.text, "Todo 1/3");
		assert.deepEqual(card.rows.map((r) => r.text), ["✓ T1 lib", "◐ T2 extension", "⊘ T3 deploy · waiting for admin"]);
	});

	it("collapses to the task in progress", () => {
		assert.deepEqual(todoCard(todos, { collapsed: true, staleRuns: 0 })!.rows.map((r) => r.text), ["◐ T2 extension"]);
	});

	it("turns stale after two runs without an update", () => {
		const card = todoCard(todos, { collapsed: false, staleRuns: 2 })!;
		assert.match(card.header.text, /stale 2 runs/);
		assert.equal(card.header.tone, "warning");
	});

	it("disappears when nothing is open", () => {
		assert.equal(todoCard([{ id: "T1", text: "x", status: "done" }], { collapsed: false, staleRuns: 0 }), undefined);
	});

	it("folds finished tasks on long lists", () => {
		const long: Todo[] = Array.from({ length: 12 }, (_, i) => ({ id: `T${i}`, text: "t", status: i < 6 ? "done" : "pending" }));
		const card = todoCard(long, { collapsed: false, staleRuns: 0, maxRows: 5 })!;
		assert.equal(card.rows[0].text, "✓ 6 done");
		assert.equal(card.rows.length, 5);
	});
});

describe("todo delta", () => {
	const before: Todo[] = [
		{ id: "T1", text: "lib", status: "in_progress" },
		{ id: "T2", text: "extension", status: "pending" },
		{ id: "T3", text: "deploy", status: "pending" },
	];
	const after: Todo[] = [
		{ id: "T1", text: "lib", status: "done" },
		{ id: "T2", text: "extension", status: "in_progress" },
		{ id: "T3", text: "deploy", status: "pending" },
		{ id: "T4", text: "old idea", status: "dropped", note: "out of scope" },
	];

	it("lists ids whose status, text, or note changed, and new ids, in list order", () => {
		assert.deepEqual(changedIds(before, after), ["T1", "T2", "T4"]);
		assert.deepEqual(changedIds(after, after), []);
		assert.deepEqual(changedIds(after, [{ ...after[2], note: "later" }]), ["T3"]);
	});

	it("renders one line: progress, then each change; only the task in progress keeps its text", () => {
		const line = todoDeltaLine(after, ["T1", "T2", "T4"])!;
		assert.equal(line.text, "Todo 1/3 · ✓ T1 · ◐ T2 extension · ✕ T4");
		assert.equal(line.text.split("\n").length, 1);
	});

	it("shows only progress when nothing changed", () => {
		assert.equal(todoDeltaLine(after, [])!.text, "Todo 1/3");
	});

	it("has no delta for results stored before deltas were recorded", () => {
		assert.equal(todoDeltaLine(after, undefined), undefined);
	});
});
