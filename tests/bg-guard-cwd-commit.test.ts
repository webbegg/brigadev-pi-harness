// S1a regression: a bg_start working directory must not let `git commit` skip the evidence gate's "elsewhere" rule.
// bash cannot change directory without `cd` / `git -C`, which the gate blocks as "runs in another directory";
// bg_start's `cwd` is the same move, so it must get the same decision.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

describe("bg_start cwd and the evidence gate (S1a)", () => {
	const saved = { ...process.env };
	let dir: string;
	let repo: string;
	let outside: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;

	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const makeRepo = (path: string, branch: string, file: string) => {
		mkdirSync(path, { recursive: true });
		git(path, "init", "-q", "-b", branch);
		writeFileSync(join(path, file), "1\n");
		git(path, "add", "-A");
		git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
	};

	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-bg-gate-")));
		repo = join(dir, "repo");
		outside = join(dir, "outrepo");
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		process.env.BRIGADEV_HOME = join(dir, "home");
		mkdirSync(repo);
		writeFileSync(join(repo, ".gitignore"), "nested/\n");
		makeRepo(repo, "feat/x", "src.ts"); // the session's repository is clean: the gate alone would allow a commit of it
		makeRepo(join(repo, "nested"), "feat/n", "n.ts");
		appendFileSync(join(repo, "nested", "n.ts"), "2\n"); // untested source change in another repository
		makeRepo(outside, "feat/o", "o.ts");
		appendFileSync(join(outside, "o.ts"), "2\n");
		uninstall = installPiStubs();
		guard = (await import("../extensions/guard.ts")).default;
	});

	after(() => {
		uninstall();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	async function call(toolName: string, input: Record<string, unknown>, setup: { hasUI: boolean; answer?: boolean; yolo?: boolean }) {
		const handlers: Record<string, Function[]> = {};
		guard({
			on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
			registerCommand: () => {},
			registerShortcut: () => {},
			appendEntry: () => {},
			exec: async (command: string, args: string[], options: { cwd: string }) => {
				try {
					return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), stderr: "", code: 0 };
				} catch (error: any) {
					return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
				}
			},
		});
		const asked: string[] = [];
		const entries = setup.yolo ? [{ type: "custom", customType: "brigadev-mode", data: { mode: "yolo" } }] : [];
		const ctx: any = { cwd: repo, hasUI: setup.hasUI, sessionManager: { getBranch: () => entries }, ui: { confirm: async (title: string) => (asked.push(title), setup.answer ?? false), notify: () => {}, setStatus: () => {} } };
		for (const handler of handlers.session_start ?? []) await handler({}, ctx);
		for (const handler of handlers.tool_call ?? []) {
			const result = await handler({ toolName, toolCallId: "1", input }, ctx);
			if (result?.block) return { reason: String(result.reason), asked };
		}
		return { reason: undefined, asked };
	}

	it("yolo without a UI: a commit in a nested repository is blocked as bash blocks `cd nested && git commit`", async () => {
		const viaBash = await call("bash", { command: "cd nested && git commit -am x" }, { hasUI: false, yolo: true });
		assert.match(String(viaBash.reason), /evidence gate/);
		const viaBg = await call("bg_start", { command: "git commit -am x", cwd: "nested" }, { hasUI: false, yolo: true });
		assert.match(String(viaBg.reason), /evidence gate/);
	});

	it("with a UI the user sees the evidence-gate question for a bg_start commit elsewhere, as for bash", async () => {
		const viaBash = await call("bash", { command: "cd nested && git commit -am x" }, { hasUI: true, answer: true, yolo: true });
		const viaBg = await call("bg_start", { command: "git commit -am x", cwd: "nested" }, { hasUI: true, answer: true, yolo: true });
		assert.ok(viaBash.asked.includes("brigadev: evidence gate blocked this commit"));
		assert.ok(viaBg.asked.includes("brigadev: evidence gate blocked this commit"), JSON.stringify(viaBg));
	});

	it("an outside repository the user granted as a working directory still goes through the gate", async () => {
		const viaBg = await call("bg_start", { command: "git commit -am x", cwd: outside }, { hasUI: true, answer: true, yolo: true });
		assert.ok(viaBg.asked.includes("brigadev: evidence gate blocked this commit"), JSON.stringify(viaBg));
	});
});
