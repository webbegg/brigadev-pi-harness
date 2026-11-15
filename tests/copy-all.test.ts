import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { collectConversation, MESSAGE_SEPARATOR } from "../lib/copy-all.ts";
import type { ClipboardRunner } from "../lib/clipboard.ts";
import { createFakeCtx, createFakePi } from "./helpers/fake-pi.ts";

const message = (role: string, content: unknown) => ({ type: "message", message: { role, content } });

describe("collectConversation", () => {
	it("keeps user and assistant text in order, each under a role header, separated by a rule", () => {
		const { text, count } = collectConversation([message("user", "hi"), message("assistant", [{ type: "text", text: "hello" }]), message("user", [{ type: "text", text: "thanks" }])]);
		assert.equal(count, 3);
		assert.equal(text, ["USER:\nhi", "ASSISTANT:\nhello", "USER:\nthanks"].join(MESSAGE_SEPARATOR));
	});

	it("takes only text parts: no thinking, tool calls or images", () => {
		const { text, count } = collectConversation([
			message("assistant", [
				{ type: "thinking", thinking: "secret plan" },
				{ type: "text", text: "part one" },
				{ type: "toolCall", id: "1", name: "bash", arguments: { command: "ls" } },
				{ type: "text", text: "part two" },
			]),
			message("user", [{ type: "image", data: "AAAA", mimeType: "image/png" }]),
		]);
		assert.equal(count, 1, "a message with no text part is not counted");
		assert.equal(text, "ASSISTANT:\npart one\npart two");
	});

	it("ignores other roles, other entry types, compaction summaries and empty text", () => {
		const { text, count } = collectConversation([
			{ type: "custom", customType: "brigadev-btw", data: { answer: "aside" } },
			{ type: "compaction", summary: "old" },
			message("toolResult", [{ type: "text", text: "tool output" }]),
			message("bashExecution", "ls"),
			message("assistant", "   "),
			message("user", "kept"),
			null,
			{ type: "message" },
		]);
		assert.equal(count, 1);
		assert.equal(text, "USER:\nkept");
	});

	it("an empty branch is nothing to copy", () => {
		assert.deepEqual(collectConversation([]), { text: "", count: 0 });
	});
});

describe("extensions/copy-all.ts", () => {
	let savedEnv: NodeJS.ProcessEnv;
	let extension: (pi: any, deps?: any) => void;
	before(async () => {
		// The extension is inert in a child session (BRIGADEV_CHILD=1), and the writer that runs this test is one.
		savedEnv = { ...process.env };
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		extension = (await import("../extensions/copy-all.ts")).default;
	});
	after(() => {
		for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
		Object.assign(process.env, savedEnv);
	});

	const setup = (branch: unknown[], run: ClipboardRunner, platform: NodeJS.Platform = "darwin") => {
		const pi = createFakePi();
		extension(pi, { platform, env: {}, isAvailable: (command: string) => command === "pbcopy", run });
		const ctx = createFakeCtx({ cwd: "/tmp", hasUI: true });
		(ctx.sessionManager as any).getBranch = () => branch;
		return { pi, ctx };
	};

	it("registers /brigadev:copy-all and copies the branch text, then says how many messages", async () => {
		const calls: Array<{ command: string; input: string }> = [];
		const { pi, ctx } = setup([message("user", "q"), message("assistant", [{ type: "text", text: "a" }])], async (command, _args, input) => (calls.push({ command, input }), { code: 0 }));
		assert.ok(pi.commands.has("brigadev:copy-all"));
		await pi.commands.get("brigadev:copy-all").handler("", ctx);
		assert.deepEqual(calls, [{ command: "pbcopy", input: `USER:\nq${MESSAGE_SEPARATOR}ASSISTANT:\na` }]);
		assert.deepEqual(ctx.notifications, [{ message: "Copied 2 messages to the clipboard", type: "info" }]);
	});

	it("a clipboard failure is one clear error notice", async () => {
		const { pi, ctx } = setup([message("user", "q")], async () => ({ code: 1 }));
		await pi.commands.get("brigadev:copy-all").handler("", ctx);
		assert.deepEqual(ctx.notifications, [{ message: "Could not copy to the clipboard: pbcopy exited with code 1", type: "error" }]);
	});

	it("no clipboard tool: the notice says what to install, and nothing is run", async () => {
		let ran = false;
		const { pi, ctx } = setup([message("user", "q")], async () => ((ran = true), { code: 0 }), "linux");
		await pi.commands.get("brigadev:copy-all").handler("", ctx);
		assert.equal(ran, false);
		assert.equal(ctx.notifications.length, 1);
		assert.equal(ctx.notifications[0].type, "error");
		assert.match(ctx.notifications[0].message, /No clipboard tool found.*wl-copy, xclip or xsel/);
	});

	it("nothing to copy says so and runs nothing", async () => {
		let ran = false;
		const { pi, ctx } = setup([], async () => ((ran = true), { code: 0 }));
		await pi.commands.get("brigadev:copy-all").handler("", ctx);
		assert.equal(ran, false);
		assert.deepEqual(ctx.notifications, [{ message: "No user or assistant messages to copy", type: "info" }]);
	});

	it("registers nothing in a child session", () => {
		process.env.BRIGADEV_CHILD = "1";
		try {
			const pi = createFakePi();
			extension(pi);
			assert.equal(pi.commands.size, 0);
		} finally {
			delete process.env.BRIGADEV_CHILD;
		}
	});
});
