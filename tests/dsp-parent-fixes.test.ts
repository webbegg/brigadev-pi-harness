// Parent follow-ups to the DSP worker run: an unknown default branch asks (as in normal mode), and the panel shows DSP.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { decideDspCommand } from "../lib/dsp-policy.ts";
import { renderPanel, type PanelPainter } from "../lib/panel-layout.ts";
import { MODE_PROMPT } from "../lib/permission-policy.ts";
import { fakeExec, realTmp } from "./dsp-fixtures.test.ts";

const plain: PanelPainter = {
	paint: (_tone, text) => text,
	bold: (text) => text,
	measure: (text) => text.length,
	truncate: (text, width) => text.slice(0, Math.max(0, width)),
	fill: (text) => text,
};

describe("DSP parent fixes", () => {
	it("a commit asks when the default branch cannot be determined (main and master both exist, no origin/HEAD)", async () => {
		const project = realTmp("dsp-fix-project-");
		const exec = fakeExec({ branch: "develop", branches: ["main", "master"], originHead: null });
		const { decision } = await decideDspCommand({ command: "git commit -m x", cwd: project, projectRoot: project, home: realTmp("dsp-fix-home-"), tempRoots: [realTmp("dsp-fix-temp-")], exec });
		assert.notEqual(decision.action, "allow");
	});

	it("the DSP prompt line fits the 220-byte mode budget", () => {
		assert.ok(Buffer.byteLength(MODE_PROMPT.dsp) <= 220, String(Buffer.byteLength(MODE_PROMPT.dsp)));
	});

	it("the panel shows ⚠ DSP instead of the yolo flag", () => {
		const lines = renderPanel({ width: 44, height: 60, now: 1_000_000, todos: [], runs: [], changes: [], session: { contextPercent: 10, dsp: true, yolo: false } }, plain);
		assert.ok(lines.some((line) => line.includes("⚠ DSP")));
		assert.ok(!lines.some((line) => line.includes("yolo")));
	});
});
