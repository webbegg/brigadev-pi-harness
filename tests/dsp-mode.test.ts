// S1 (mode value, label, footer segment, default-mode warning), S5 (remote dialog), S9 (prompt layer, docs).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { defaultModeWarning, DSP_NEVER_LINE, DSP_REMOTE_TITLE, readRemoteTarget, remoteDialog } from "../lib/dsp-policy.ts";
import { commandPreview, isPermissionMode, MODE_LABEL, MODE_PROMPT, PERMISSION_MODE } from "../lib/permission-policy.ts";
import { statusSegment } from "../lib/shell-bar.ts";
import { fakeExec } from "./dsp-fixtures.test.ts";

const root = join(import.meta.dirname, "..");

describe("S1 the dsp mode", () => {
	it("is a permission mode, and the other values still are", () => {
		assert.equal(isPermissionMode("dsp"), true);
		assert.equal(PERMISSION_MODE.DSP, "dsp");
		assert.equal(isPermissionMode("normal"), true);
		assert.equal(isPermissionMode("yolo"), true);
		for (const value of ["DSP", "dsp ", "super-yolo", "", undefined, null, 3]) assert.equal(isPermissionMode(value), false, String(value));
	});

	it("has the label 'DSP — dangerously skip permissions'", () => {
		assert.equal(MODE_LABEL.dsp, "DSP — dangerously skip permissions");
	});

	it("shows ⚠ DSP in the warning tone in the footer", () => {
		assert.deepEqual(statusSegment("brigadev-mode", "⚠ brigadev: DSP"), { id: "brigadev-mode", text: "⚠ DSP", tone: "warning", priority: 90 });
		assert.equal(statusSegment("brigadev-mode", "🚀 brigadev: yolo")?.text, "🚀 yolo");
		assert.equal(statusSegment("brigadev-mode", "brigadev: normal"), undefined);
	});

	it("the doctor warns when DSP is the default", () => {
		assert.match(String(defaultModeWarning("dsp")), /DSP/);
		assert.match(String(defaultModeWarning("dsp")), /remote/i);
		assert.equal(defaultModeWarning("yolo"), undefined);
		assert.equal(defaultModeWarning(undefined), undefined);
	});
});

describe("S5 the remote dialog", () => {
	it("has the title, the exact command preview, the kind, the target and the closing line", () => {
		const dialog = remoteDialog({
			command: "git push -u origin feat/x",
			items: [{ label: "push", remote: "origin", ref: "feat/x" }],
			target: { remoteName: "origin", url: "git@github.com:me/x.git", branch: "feat/x" },
		});
		assert.equal(dialog.title, "brigadev DSP: remote action — needs your OK");
		assert.equal(DSP_REMOTE_TITLE, dialog.title);
		assert.ok(dialog.body.includes(commandPreview("git push -u origin feat/x")));
		assert.match(dialog.body, /Kind: push/);
		assert.match(dialog.body, /Remote: origin \(git@github\.com:me\/x\.git\)/);
		assert.match(dialog.body, /Branch: feat\/x/);
		assert.ok(dialog.body.split("\n").includes("DSP never runs remote actions on its own."));
		assert.equal(DSP_NEVER_LINE, "DSP never runs remote actions on its own.");
	});

	it("shows the PR number and the base for a PR", () => {
		const merge = remoteDialog({ command: "gh pr merge 12 --squash", items: [{ label: "PR merge", pr: "12" }], target: {} });
		assert.match(merge.body, /Kind: PR merge/);
		assert.match(merge.body, /PR: #12/);
		const create = remoteDialog({ command: "gh pr create --base develop", items: [{ label: "PR create", base: "develop" }], target: { branch: "feat/x" } });
		assert.match(create.body, /Base: develop/);
		assert.match(create.body, /Branch: feat\/x/);
	});

	it("lists several kinds and keeps a long command short", () => {
		const long = Array.from({ length: 30 }, (_, i) => `echo ${i}`).join("\n") + "\ngit push";
		const dialog = remoteDialog({ command: long, items: [{ label: "push" }, { label: "PR create" }], target: {} });
		assert.match(dialog.body, /Kind: push, PR create/);
		assert.ok(dialog.body.split("\n").length < 25, "the dialog stays small enough to show its options");
		assert.ok(dialog.body.includes("more lines"));
	});

	it("says what else needs approval", () => {
		const dialog = remoteDialog({ command: "git push && rm -rf /var/x", items: [{ label: "push" }], target: {}, also: ["rm recursive removal outside the project"] });
		assert.match(dialog.body, /Also: rm recursive removal outside the project/);
	});

	it("reads the remote name, URL and branch the command will use", async () => {
		const exec = fakeExec({ branch: "feat/x", remotes: { origin: "git@github.com:me/x.git", up: "https://example.com/up.git" } });
		assert.deepEqual(await readRemoteTarget(exec, "/x", [{ label: "push", remote: "up" }]), { remoteName: "up", url: "https://example.com/up.git", branch: "feat/x" });
		assert.deepEqual(await readRemoteTarget(exec, "/x", [{ label: "push" }]), { remoteName: "origin", url: "git@github.com:me/x.git", branch: "feat/x" });
	});

	it("a remote that cannot be read is shown without a URL", async () => {
		const exec = fakeExec({ branch: "feat/x" });
		assert.deepEqual(await readRemoteTarget(exec, "/x", [{ label: "push", remote: "nope" }]), { remoteName: "nope", url: undefined, branch: "feat/x" });
	});

	it("does not ask git for a target when the command is not a git remote action", async () => {
		const exec = fakeExec({ branch: "feat/x", remotes: { origin: "u" } });
		const target = await readRemoteTarget(exec, "/x", [{ label: "publish" }]);
		assert.equal(target.remoteName, undefined);
		assert.equal(target.url, undefined);
	});
});

describe("S9 the prompt layer", () => {
	it("MODE_PROMPT.dsp is the specified line", () => {
		assert.equal(
			MODE_PROMPT.dsp,
			"Permission mode DSP: local work runs unasked (history is backed up first). Remote actions and default-branch changes always need the user's OK in the guard dialog: run them, let it ask, never route around it.",
		);
	});

	it("the other mode lines are unchanged", () => {
		assert.match(MODE_PROMPT.normal, /^Permission mode NORMAL:/);
		assert.match(MODE_PROMPT.yolo, /^Permission mode YOLO:/);
	});

	it("the README documents the mode, its table and the residual risk", () => {
		const readme = readFileSync(join(root, "README.md"), "utf8");
		assert.match(readme, /DSP/);
		assert.match(readme, /dangerously skip permissions/i);
		assert.match(readme, /refs\/brigadev\/backup/);
		assert.match(readme, /audit\/dsp\.jsonl/);
		assert.match(readme, /opens its own network connection/i);
	});

	it("the changelog documents it (in Unreleased or a released section)", () => {
		const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
		// Release-proof: renaming `## [Unreleased]` to a version must not break this test.
		const sections = changelog.split(/^## \[/m).slice(1);
		assert.ok(sections.some((section) => /^(Unreleased|\d+\.\d+\.\d+)\]/.test(section) && /DSP mode/.test(section)));
	});
});
