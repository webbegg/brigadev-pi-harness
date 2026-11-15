import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { clipboardCandidates, copyToClipboard, missingToolMessage, pickClipboardCommand, type ClipboardRunner } from "../lib/clipboard.ts";

const all = () => true;
const none = () => false;
const only = (...names: string[]) => (command: string) => names.includes(command);

describe("clipboardCandidates", () => {
	it("macOS: pbcopy", () => {
		assert.deepEqual(clipboardCandidates("darwin", {}), [{ command: "pbcopy", args: [] }]);
	});

	it("Windows: clip", () => {
		assert.deepEqual(clipboardCandidates("win32", {}), [{ command: "clip", args: [] }]);
	});

	it("Linux under Wayland: wl-copy first, then xclip, then xsel", () => {
		assert.deepEqual(
			clipboardCandidates("linux", { WAYLAND_DISPLAY: "wayland-0" }).map((c) => c.command),
			["wl-copy", "xclip", "xsel"],
		);
	});

	it("Linux without Wayland: xclip then xsel, with the clipboard selection", () => {
		assert.deepEqual(clipboardCandidates("linux", {}), [
			{ command: "xclip", args: ["-selection", "clipboard"] },
			{ command: "xsel", args: ["--clipboard", "--input"] },
		]);
	});

	it("an empty WAYLAND_DISPLAY does not count", () => {
		assert.equal(clipboardCandidates("linux", { WAYLAND_DISPLAY: "" })[0].command, "xclip");
	});

	it("another platform has none", () => {
		assert.deepEqual(clipboardCandidates("freebsd", {}), []);
	});
});

describe("pickClipboardCommand", () => {
	it("takes the first candidate that is available", () => {
		assert.deepEqual(pickClipboardCommand({ platform: "linux", env: {}, isAvailable: only("xsel") }), { command: "xsel", args: ["--clipboard", "--input"] });
		assert.equal(pickClipboardCommand({ platform: "linux", env: { WAYLAND_DISPLAY: "w" }, isAvailable: all })?.command, "wl-copy");
		assert.equal(pickClipboardCommand({ platform: "linux", env: { WAYLAND_DISPLAY: "w" }, isAvailable: only("xclip") })?.command, "xclip");
	});

	it("is undefined when no candidate is available", () => {
		assert.equal(pickClipboardCommand({ platform: "linux", env: {}, isAvailable: none }), undefined);
	});
});

describe("missingToolMessage", () => {
	it("names what to install per platform", () => {
		assert.match(missingToolMessage("linux"), /wl-copy, xclip or xsel/);
		assert.match(missingToolMessage("darwin"), /pbcopy/);
		assert.match(missingToolMessage("win32"), /clip/);
		assert.match(missingToolMessage("freebsd"), /freebsd/);
	});
});

describe("copyToClipboard", () => {
	const recording = (result: Awaited<ReturnType<ClipboardRunner>> = { code: 0 }) => {
		const calls: Array<{ command: string; args: string[]; input: string; timeoutMs: number }> = [];
		const run: ClipboardRunner = async (command, args, input, timeoutMs) => (calls.push({ command, args, input, timeoutMs }), result);
		return { calls, run };
	};

	it("runs the picked command with the text as input, no shell, and a bounded timeout", async () => {
		const { calls, run } = recording();
		const result = await copyToClipboard("hello\nworld", { platform: "darwin", env: {}, isAvailable: all, run });
		assert.deepEqual(result, { ok: true, tool: "pbcopy" });
		assert.equal(calls.length, 1);
		assert.deepEqual({ command: calls[0].command, args: calls[0].args, input: calls[0].input }, { command: "pbcopy", args: [], input: "hello\nworld" });
		assert.ok(calls[0].timeoutMs > 0 && calls[0].timeoutMs <= 10_000);
	});

	it("passes the xclip arguments as separate argv entries (text never in argv)", async () => {
		const { calls, run } = recording();
		await copyToClipboard("secret; rm -rf /", { platform: "linux", env: {}, isAvailable: only("xclip"), run });
		assert.deepEqual(calls[0].args, ["-selection", "clipboard"]);
		assert.ok(!calls[0].args.some((a) => a.includes("secret")));
	});

	it("without a clipboard tool: a clear failure and nothing is run", async () => {
		const { calls, run } = recording();
		const result = await copyToClipboard("x", { platform: "linux", env: {}, isAvailable: none, run });
		assert.deepEqual(result, { ok: false, error: missingToolMessage("linux") });
		assert.equal(calls.length, 0);
	});

	it("a non-zero exit is a failure naming the tool and the code", async () => {
		const result = await copyToClipboard("x", { platform: "darwin", env: {}, isAvailable: all, run: recording({ code: 3 }).run });
		assert.deepEqual(result, { ok: false, error: "pbcopy exited with code 3" });
	});

	it("a spawn error is a failure with its message", async () => {
		const result = await copyToClipboard("x", { platform: "darwin", env: {}, isAvailable: all, run: recording({ code: null, error: "spawn pbcopy ENOENT" }).run });
		assert.deepEqual(result, { ok: false, error: "pbcopy failed: spawn pbcopy ENOENT" });
	});

	it("a timeout is a failure that says so", async () => {
		const result = await copyToClipboard("x", { platform: "darwin", env: {}, isAvailable: all, run: recording({ code: null, timedOut: true }).run });
		assert.equal(result.ok, false);
		assert.match((result as { error: string }).error, /pbcopy timed out/);
	});

	it("a runner that throws is a failure, not a rejection", async () => {
		const result = await copyToClipboard("x", {
			platform: "darwin",
			env: {},
			isAvailable: all,
			run: async () => {
				throw new Error("kaput");
			},
		});
		assert.deepEqual(result, { ok: false, error: "pbcopy failed: kaput" });
	});
});

describe("the default runner (real process, no shell)", () => {
	it("writes the text to the command's stdin and reports its exit code", async () => {
		const { defaultRunner } = await import("../lib/clipboard.ts");
		// `node -e` stands for the clipboard tool: it exits 0 only when stdin carried exactly the text.
		const script = 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>process.exit(s==="a b;$(x)\\n\\u00e9"?0:7))';
		assert.deepEqual(await defaultRunner(process.execPath, ["-e", script], "a b;$(x)\né", 5000), { code: 0 });
		assert.equal((await defaultRunner(process.execPath, ["-e", script], "other", 5000)).code, 7);
	});

	it("a missing command is an error result, and a hanging one is killed at the timeout", async () => {
		const { defaultRunner } = await import("../lib/clipboard.ts");
		const missing = await defaultRunner("brigadev-no-such-clipboard-tool", [], "x", 2000);
		assert.equal(missing.code, null);
		assert.match(missing.error ?? "", /ENOENT/);
		const hung = await defaultRunner(process.execPath, ["-e", "setInterval(()=>{},1000)"], "x", 300);
		assert.equal(hung.timedOut, true);
	});
});
