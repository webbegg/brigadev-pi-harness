// S1a regression: a bg_start `cwd` is decided like `cd <cwd> && <command>` for another repository (a symlink into a
// nested repository counts too), and a subdirectory of the session's own repository is NOT "elsewhere": the evidence
// gate then decides on the session's tree, as for a plain `git commit`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

describe("bg_start cwd: same repository vs another one (S1a)", () => {
	const saved = { ...process.env };
	let dir: string;
	let clean: string;
	let dirty: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;

	const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	const makeRepo = (path: string, branch: string, file: string) => {
		mkdirSync(path, { recursive: true });
		git(path, "init", "-q", "-b", "main");
		writeFileSync(join(path, file), "1\n");
		git(path, "add", "-A");
		git(path, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		git(path, "checkout", "-qb", branch);
	};
	const makeSession = (path: string) => {
		mkdirSync(join(path, "src"), { recursive: true });
		writeFileSync(join(path, ".gitignore"), "nested/\nlnk\n");
		writeFileSync(join(path, "src", "a.ts"), "1\n");
		makeRepo(path, "feat/x", "src.ts");
		makeRepo(join(path, "nested"), "feat/n", "n.ts");
		appendFileSync(join(path, "nested", "n.ts"), "2\n");
		symlinkSync("nested", join(path, "lnk"));
	};

	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-bg-same-repo-")));
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		process.env.BRIGADEV_HOME = join(dir, "home");
		clean = join(dir, "clean");
		dirty = join(dir, "dirty");
		makeSession(clean);
		makeSession(dirty);
		appendFileSync(join(dirty, "src", "a.ts"), "2\n"); // an untested source change in the session's own repository
		uninstall = installPiStubs();
		guard = (await import("../extensions/guard.ts")).default;
	});

	after(() => {
		uninstall();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	async function call(cwd: string, toolName: string, input: Record<string, unknown>, yolo = false) {
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
		const entries = yolo ? [{ type: "custom", customType: "brigadev-mode", data: { mode: "yolo" } }] : [];
		const ctx: any = { cwd, hasUI: false, sessionManager: { getBranch: () => entries }, ui: { confirm: async () => false, notify: () => {}, setStatus: () => {} } };
		for (const handler of handlers.session_start ?? []) await handler({}, ctx);
		for (const handler of handlers.tool_call ?? []) {
			const result = await handler({ toolName, toolCallId: "1", input }, ctx);
			if (result?.block) return String(result.reason);
		}
		return undefined;
	}

	for (const sub of ["src", ".", "src/"]) {
		it(`a clean session repository: bg_start cwd "${sub}" commits like a plain git commit (not "another directory")`, async () => {
			assert.equal(await call(clean, "bash", { command: "git commit -am x" }), undefined);
			assert.equal(await call(clean, "bg_start", { command: "git commit -am x", cwd: sub }), undefined);
		});

		it(`an untested change: bg_start cwd "${sub}" gets the same gate reason as a plain git commit`, async () => {
			const viaBash = await call(dirty, "bash", { command: "git commit -am x" });
			const viaBg = await call(dirty, "bg_start", { command: "git commit -am x", cwd: sub });
			assert.match(String(viaBash), /no passing test is recorded/);
			assert.equal(viaBg, viaBash);
		});
	}

	it("a symlink cwd into a nested repository is another directory, as `cd lnk && git commit` is", async () => {
		for (const yolo of [false, true]) {
			const viaBash = await call(clean, "bash", { command: "cd lnk && git commit -am x" }, yolo);
			const viaBg = await call(clean, "bg_start", { command: "git commit -am x", cwd: "lnk" }, yolo);
			assert.match(String(viaBash), /runs in another directory/);
			assert.equal(viaBg, viaBash);
		}
	});
});
