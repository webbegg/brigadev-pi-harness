import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildEditorLaunch, resolveEditor, splitCommand } from "../lib/editor-launch.ts";

describe("editor launch", () => {
	it("prefers VISUAL over EDITOR", () => {
		assert.equal(resolveEditor({ VISUAL: "code -w", EDITOR: "vi" }), "code -w");
		assert.equal(resolveEditor({ EDITOR: "vi" }), "vi");
	});

	it("treats unset or blank variables as no editor", () => {
		assert.equal(resolveEditor({}), undefined);
		assert.equal(resolveEditor({ VISUAL: "  ", EDITOR: "" }), undefined);
		assert.equal(resolveEditor({ VISUAL: " ", EDITOR: "nano" }), "nano");
	});

	it("splits the editor string into command and args without a shell", () => {
		assert.deepEqual(splitCommand("code --wait"), ["code", "--wait"]);
		assert.deepEqual(splitCommand('"/Applications/My Editor/bin/ed" -w'), ["/Applications/My Editor/bin/ed", "-w"]);
		assert.deepEqual(splitCommand("vim   -u 'my rc'"), ["vim", "-u", "my rc"]);
		assert.deepEqual(splitCommand("  "), []);
	});

	it("keeps the path as one literal argv element", () => {
		for (const path of ["/repo/my file.ts", "/repo/a;rm -rf x.ts", "/repo/$(touch pwned).ts", "/repo/`id`.ts", "/repo/a&b|c>d.ts"]) {
			const launch = buildEditorLaunch({ EDITOR: "code -w" }, path);
			assert.deepEqual(launch, { ok: true, command: "code", args: ["-w", path] });
		}
	});

	it("does not interpret shell syntax in the editor string either", () => {
		const launch = buildEditorLaunch({ EDITOR: "vi; rm x" }, "/repo/f.ts");
		assert.deepEqual(launch, { ok: true, command: "vi;", args: ["rm", "x", "/repo/f.ts"] });
	});

	it("returns a typed no-editor result", () => {
		const launch = buildEditorLaunch({}, "/repo/f.ts");
		assert.deepEqual(launch, { ok: false, reason: "no-editor", message: "No editor configured. Set $VISUAL or $EDITOR." });
	});
});
