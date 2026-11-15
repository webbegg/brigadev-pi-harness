import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { BranchFacts } from "../lib/commit-branch.ts";
import { canonicalPath } from "../lib/paths.ts";
import { bashWritesEvidence, decideBashCommand, decideFileAccess, shellCallOf, type FileAccessInput } from "../lib/guard-rules.ts";
import { PERMISSION_MODE } from "../lib/permission-policy.ts";
import { installPiStubs } from "./helpers/pi-stubs-loader.ts";

describe("file access decision", () => {
	let scratch: string;
	let project: string;
	let home: string;
	let docs: string;

	before(() => {
		scratch = realpathSync(mkdtempSync(join(tmpdir(), "guard-rules-")));
		project = join(scratch, "project");
		home = join(scratch, "home");
		docs = join(home, "repo-docs");
		mkdirSync(project, { recursive: true });
		mkdirSync(join(docs, "tasks"), { recursive: true });
		mkdirSync(join(home, "other-repo"), { recursive: true });
	});
	after(() => rmSync(scratch, { recursive: true, force: true }));

	const input = (overrides: Partial<FileAccessInput> & { absolutePath: string }): FileAccessInput => ({
		isChild: false,
		projectRoot: project,
		docsDir: docs,
		sensitive: false,
		readOnly: false,
		surfaces: undefined,
		...overrides,
	});

	it("lets the parent write into the repo docs folder without asking", () => {
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(docs, "tasks", "x.md") })), { action: "allow" });
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(docs, "reviews", "new", "r.md") })), { action: "allow" });
	});

	it("asks for a dangling symlink in the docs folder that points outside", () => {
		const link = join(docs, "tasks", "dangling.md");
		symlinkSync(join(home, "other-repo", "missing.md"), link);
		assert.equal(decideFileAccess(input({ absolutePath: canonicalPath(link) })).action, "ask");
	});

	it("blocks a subagent writing there, even a writer with surfaces", () => {
		const path = join(docs, "tasks", "x.md");
		for (const overrides of [{}, { surfaces: ["tasks"] }, { readOnly: true }]) {
			const decision = decideFileAccess(input({ absolutePath: path, isChild: true, ...overrides }));
			assert.equal(decision.action, "block");
			assert.match("reason" in decision ? decision.reason : "", /outside the project root/);
		}
	});

	it("asks for a write elsewhere outside the project, naming the directory", () => {
		const path = join(home, "other-repo", "x");
		assert.deepEqual(decideFileAccess(input({ absolutePath: path })), { action: "ask", kind: "outside", target: join(home, "other-repo") });
		assert.equal(decideFileAccess(input({ absolutePath: join(scratch, "elsewhere.txt") })).action, "ask");
	});

	it("blocks a subagent writing outside the project", () => {
		assert.equal(decideFileAccess(input({ absolutePath: join(home, "other-repo", "x"), isChild: true })).action, "block");
	});

	it("does not treat a sibling that shares the docs folder's name prefix as docs", () => {
		assert.equal(decideFileAccess(input({ absolutePath: `${docs}-evil/x.md` })).action, "ask");
	});

	it("still asks for a sensitive path inside the docs folder, then applies the docs rule", () => {
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(docs, ".env"), sensitive: true })), { action: "ask", kind: "sensitive", then: { action: "allow" } });
	});

	it("asks for a sensitive path outside the project, then still asks for the write", () => {
		const path = join(home, "other-repo", ".env");
		assert.deepEqual(decideFileAccess(input({ absolutePath: path, sensitive: true })), { action: "ask", kind: "sensitive", then: { action: "ask", kind: "outside", target: join(home, "other-repo") } });
	});

	it("blocks a sensitive path for a subagent, read or write, inside or outside", () => {
		for (const absolutePath of [join(docs, ".env"), join(project, ".env")]) {
			for (const isWrite of [true, false]) {
				const decision = decideFileAccess(input({ absolutePath, sensitive: true, isChild: true, isWrite }));
				assert.equal(decision.action, "block");
				assert.match("reason" in decision ? decision.reason : "", /may hold secrets/);
			}
		}
	});

	it("allows reads of anything not sensitive, and asks for sensitive reads", () => {
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(home, "other-repo", "x"), isWrite: false })), { action: "allow" });
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(home, "other-repo", "x"), isWrite: false, isChild: true })), { action: "allow" });
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(home, ".ssh", "id_rsa"), sensitive: true, isWrite: false })), { action: "ask", kind: "sensitive", then: { action: "allow" } });
	});

	it("allows the parent to write inside the project", () => {
		assert.deepEqual(decideFileAccess(input({ absolutePath: join(project, "src", "a.ts") })), { action: "allow" });
	});

	it("applies read-only and edit surfaces to a subagent inside the project", () => {
		const path = join(project, "src", "a.ts");
		const readOnly = decideFileAccess(input({ absolutePath: path, isChild: true, readOnly: true, agent: "brigadev-explore" }));
		assert.deepEqual(readOnly, { action: "block", reason: "Blocked by brigadev guard: brigadev-explore is read-only." });
		assert.deepEqual(decideFileAccess(input({ absolutePath: path, isChild: true, readOnly: true })), { action: "block", reason: "Blocked by brigadev guard: this agent is read-only." });

		assert.deepEqual(decideFileAccess(input({ absolutePath: path, isChild: true, surfaces: ["src"] })), { action: "allow" });
		assert.deepEqual(decideFileAccess(input({ absolutePath: path, isChild: true })), { action: "allow" });
		const outside = decideFileAccess(input({ absolutePath: join(project, "lib", "b.ts"), isChild: true, surfaces: ["src"] }));
		assert.equal(outside.action, "block");
		assert.match("reason" in outside ? outside.reason : "", /lib\/b\.ts is outside the allowed edit surfaces \(src\)/);
	});

	it("resolves the docs folder only when a parent write lands outside the project", () => {
		let reads = 0;
		const docsDir = () => {
			reads++;
			return docs;
		};
		decideFileAccess(input({ absolutePath: join(project, "a.ts"), docsDir }));
		decideFileAccess(input({ absolutePath: join(home, "other-repo", "x"), isChild: true, docsDir }));
		decideFileAccess(input({ absolutePath: join(home, "x"), isWrite: false, docsDir }));
		assert.equal(reads, 0);
		decideFileAccess(input({ absolutePath: join(docs, "tasks", "x.md"), docsDir }));
		assert.equal(reads, 1);
	});
});

describe("bash decision", () => {
	const FEATURE: BranchFacts = { currentBranch: "feat/x", defaultBranch: "main", protectedBranches: ["main"] };

	async function decide(command: string, options: { cwd?: string; isChild?: boolean; mode?: "normal" | "yolo"; facts?: BranchFacts } = {}) {
		const cwds: string[] = [];
		const decision = await decideBashCommand({
			command,
			mode: options.mode ?? PERMISSION_MODE.NORMAL,
			isChild: options.isChild ?? false,
			cwd: options.cwd ?? "/work/session",
			readFacts: async (cwd) => {
				cwds.push(cwd);
				return options.facts ?? FEATURE;
			},
		});
		return { action: decision.action, cwds };
	}

	it("reads the branch facts at the session cwd", async () => {
		const result = await decide("git commit -m x", { cwd: "/work/session/sub" });
		assert.deepEqual(result, { action: "allow", cwds: ["/work/session/sub"] });
	});

	it("asks on a protected branch", async () => {
		assert.equal((await decide("git commit -m x", { facts: { currentBranch: "main", defaultBranch: "trunk", protectedBranches: ["trunk", "main"] } })).action, "confirm");
	});

	it("reads nothing for commands that are not a plain commit", async () => {
		assert.deepEqual(await decide("npm test"), { action: "allow", cwds: [] });
		assert.deepEqual(await decide("cd ../x && git commit -m x"), { action: "confirm", cwds: [] });
		assert.deepEqual(await decide("{ cd /x; git commit -m y; }"), { action: "confirm", cwds: [] });
	});

	it("keeps the subagent and yolo rules", async () => {
		assert.deepEqual(await decide("git commit -m x", { isChild: true }), { action: "block", cwds: [] });
		assert.deepEqual(await decide("git commit -m x", { mode: "yolo" }), { action: "allow", cwds: [] });
		assert.deepEqual(await decide("git push", { mode: "normal" }), { action: "confirm", cwds: [] });
	});
});

describe("evidence log protection", () => {
	const docs = "/h/.brigadev/repo";
	const evidence = `${docs}/evidence`;
	const input = (overrides: Partial<FileAccessInput> & { absolutePath: string }): FileAccessInput => ({ isChild: false, projectRoot: "/work/project", docsDir: docs, sensitive: false, readOnly: false, surfaces: undefined, ...overrides });

	it("blocks write and edit tool calls into the evidence folder and its children", () => {
		for (const absolutePath of [evidence, `${evidence}/feat-x.jsonl`, `${evidence}/sub/new.jsonl`]) {
			const decision = decideFileAccess(input({ absolutePath }));
			assert.equal(decision.action, "block", absolutePath);
			assert.match("reason" in decision ? decision.reason : "", /evidence/);
		}
	});

	it("blocks it for a subagent and for a sensitive-looking name too", () => {
		assert.equal(decideFileAccess(input({ absolutePath: `${evidence}/x.jsonl`, isChild: true })).action, "block");
		assert.equal(decideFileAccess(input({ absolutePath: `${evidence}/.env`, sensitive: true })).action, "block");
	});

	it("still lets the parent read the evidence and write the other harness documents", () => {
		assert.deepEqual(decideFileAccess(input({ absolutePath: `${evidence}/feat-x.jsonl`, isWrite: false })), { action: "allow" });
		assert.deepEqual(decideFileAccess(input({ absolutePath: `${docs}/tasks/x.md` })), { action: "allow" });
		assert.deepEqual(decideFileAccess(input({ absolutePath: `${docs}/reviews/evidence-notes.md` })), { action: "allow" });
	});

	it("does not treat a sibling folder or a project folder named evidence as the log", () => {
		assert.equal(decideFileAccess(input({ absolutePath: `${docs}/evidence-old/x.jsonl` })).action, "allow");
		assert.deepEqual(decideFileAccess(input({ absolutePath: "/work/project/evidence/a.ts" })), { action: "allow" });
	});

	const dirs = [evidence];

	it("blocks a bash command that writes to the evidence path", () => {
		for (const command of [
			`echo '{}' >> ${evidence}/feat-x.jsonl`,
			`echo '{}' > ~/.brigadev/repo/evidence/feat-x.jsonl`,
			`echo x >> $HOME/.brigadev/repo/evidence/b.jsonl`,
			`printf x | tee ${evidence}/b.jsonl`,
			`cp /tmp/forged.jsonl ${evidence}/b.jsonl`,
			`rm ${evidence}/b.jsonl`,
			`sed -i '' s/fail/pass/ ${evidence}/b.jsonl`,
			`node -e "require('fs').appendFileSync('${evidence}/b.jsonl','x')"`,
			`: > "${evidence}/b.jsonl"`,
		]) {
			assert.equal(bashWritesEvidence(command, dirs), true, command);
		}
	});

	it("lets bash read the evidence", () => {
		for (const command of [`cat ${evidence}/b.jsonl`, `grep fail ${evidence}/b.jsonl | tail -3`, `ls -la ~/.brigadev/repo/evidence`, `jq . ${evidence}/b.jsonl 2>&1`, `tail -n 5 ${evidence}/b.jsonl 2>/dev/null`, `wc -l $HOME/.brigadev/repo/evidence/b.jsonl`]) {
			assert.equal(bashWritesEvidence(command, dirs), false, command);
		}
	});

	it("ignores writes that do not mention the evidence path", () => {
		for (const command of ["echo x > /tmp/a", "npm test > out.txt", "rm -rf build", `cat ${docs}/tasks/x.md > /tmp/y`]) {
			assert.equal(bashWritesEvidence(command, dirs), false, command);
		}
	});
});

describe("shellCallOf", () => {
	it("knows bash and bg_start, and no other tool", () => {
		assert.deepEqual(shellCallOf("bash", { command: "ls" }), { command: "ls" });
		assert.deepEqual(shellCallOf("bg_start", { command: "npm run dev" }), { command: "npm run dev" });
		assert.deepEqual(shellCallOf("bg_start", { command: "x", cwd: "web", name: "n" }), { command: "x", cwd: "web" });
		for (const tool of ["read", "write", "edit", "bg_status", "bg_kill", "bg_list", "subagent"]) assert.equal(shellCallOf(tool, { command: "ls" }), undefined, tool);
	});

	it("never hands a non-string command to the rules; a blank cwd is no cwd", () => {
		assert.deepEqual(shellCallOf("bg_start", { command: 42, cwd: "  " }), { command: "" });
		assert.deepEqual(shellCallOf("bg_start", undefined), { command: "" });
		assert.deepEqual(shellCallOf("bash", null), { command: "" });
	});

	it("bash never carries a cwd, whatever the input says", () => {
		assert.deepEqual(shellCallOf("bash", { command: "ls", cwd: "/elsewhere" }), { command: "ls" });
	});
});

// extensions/guard.ts loaded for real (Pi's packages stubbed): a `bg_start` call must get the decision `bash` gets.
describe("bg_start is guarded exactly like bash (S1a)", () => {
	const saved = { ...process.env };
	let dir: string;
	let repo: string;
	let home: string;
	let uninstall: () => void;
	let guard: (pi: any) => void;

	before(async () => {
		dir = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-bg-guard-")));
		repo = join(dir, "repo");
		home = join(dir, "home");
		mkdirSync(join(repo, "sub"), { recursive: true });
		mkdirSync(join(repo, ".ssh"));
		mkdirSync(join(dir, "elsewhere"));
		mkdirSync(join(dir, "other"));
		for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_")) delete process.env[key];
		process.env.BRIGADEV_HOME = home;
		const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
		git("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, "src.ts"), "export const a = 1;\n");
		git("add", "-A");
		git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
		appendFileSync(join(repo, "src.ts"), "export const b = 2;\n"); // a source change with no recorded test: the commit gate applies
		uninstall = installPiStubs();
		guard = (await import("../extensions/guard.ts")).default;
	});

	after(() => {
		uninstall();
		for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
		Object.assign(process.env, saved);
		rmSync(dir, { recursive: true, force: true });
	});

	interface Setup {
		hasUI: boolean;
		/** What the user answers every dialog. */
		answer?: boolean;
		yolo?: boolean;
	}

	async function session(setup: Setup) {
		const handlers: Record<string, Function[]> = {};
		const pi: any = {
			on: (event: string, handler: Function) => (handlers[event] ??= []).push(handler),
			registerCommand: () => {},
			registerShortcut: () => {},
			appendEntry: () => {},
			exec: async (command: string, args: string[], options: { cwd: string }) => {
				try {
					return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8" }), stderr: "", code: 0 };
				} catch (error: any) {
					return { stdout: String(error.stdout ?? ""), stderr: "", code: typeof error.status === "number" ? error.status : 1 };
				}
			},
		};
		guard(pi);
		const asked: string[] = [];
		const entries = setup.yolo ? [{ type: "custom", customType: "brigadev-mode", data: { mode: "yolo" } }] : [];
		const ctx: any = { cwd: repo, hasUI: setup.hasUI, sessionManager: { getBranch: () => entries }, ui: { confirm: async (title: string) => (asked.push(title), setup.answer ?? false), notify: () => {}, setStatus: () => {} } };
		for (const handler of handlers.session_start ?? []) await handler({}, ctx);
		let id = 0;
		return {
			asked,
			/** The block reason, or undefined when the call may run. */
			async call(toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
				for (const handler of handlers.tool_call ?? []) {
					const result = await handler({ toolName, toolCallId: String(++id), input }, ctx);
					if (result?.block) return result.reason as string;
				}
				return undefined;
			},
		};
	}

	const outcome = async (toolName: "bash" | "bg_start", input: Record<string, unknown>, setup: Setup) => {
		const s = await session(setup);
		const reason = await s.call(toolName, input);
		return { reason, asked: s.asked };
	};

	const setups: Array<[string, Setup]> = [
		["no UI", { hasUI: false }],
		["UI, user declines", { hasUI: true, answer: false }],
		["UI, user allows", { hasUI: true, answer: true }],
		["yolo, no UI", { hasUI: false, yolo: true }],
		["yolo, user allows", { hasUI: true, answer: true, yolo: true }],
	];

	// One command per guarded kind; `expect` is what no-UI normal mode does with it (so the comparison below is not vacuous).
	const evidenceLog = () => join(home, "repo", "evidence", "feat-x.jsonl");
	const kinds: Array<[string, () => string, RegExp | undefined]> = [
		["an ordinary command", () => "ls -la", undefined],
		["a hard-deny command", () => "rm -rf ~", /never allowed/],
		["a destructive command", () => "rm -rf build", /User declined/],
		["a delivery command", () => "git push origin feat/x", /User declined/],
		["a dependency command", () => "npm install left-pad", /User declined/],
		["a privileged command", () => "sudo true", /User declined/],
		["a commit the evidence gate stops", () => "git commit -am change", /evidence gate/],
		["a write to the evidence log", () => `echo '{"v":1}' >> ${evidenceLog()}`, /evidence log/],
	];

	for (const [label, command, expected] of kinds) {
		it(`${label}: same decision, same dialogs as bash in every mode`, async () => {
			const text = command();
			for (const [name, setup] of setups) {
				const viaBash = await outcome("bash", { command: text }, setup);
				const viaBg = await outcome("bg_start", { command: text, name: "x" }, setup);
				assert.deepEqual(viaBg, viaBash, `${label} (${name})`);
			}
			const plain = await outcome("bg_start", { command: text }, { hasUI: false });
			if (expected) assert.match(String(plain.reason), expected);
			else assert.equal(plain.reason, undefined);
		});
	}

	it("a hard-deny command is blocked even when the user would say yes", async () => {
		const result = await outcome("bg_start", { command: "rm -rf ~" }, { hasUI: true, answer: true });
		assert.match(String(result.reason), /never allowed/);
		assert.deepEqual(result.asked, []);
	});

	it("asks in normal mode and not for ordinary delivery in yolo, as bash does", async () => {
		assert.deepEqual((await outcome("bg_start", { command: "git push" }, { hasUI: true, answer: true })).asked, ["brigadev: git push"]);
		assert.deepEqual(await outcome("bg_start", { command: "git push" }, { hasUI: true, answer: true, yolo: true }), { reason: undefined, asked: [] });
		assert.deepEqual((await outcome("bg_start", { command: "rm -rf build" }, { hasUI: true, answer: true, yolo: true })).asked.length, 1, "destructive still asks in yolo");
	});

	it("a command that reads the evidence log is not blocked", async () => {
		assert.equal((await outcome("bg_start", { command: `tail -f ${evidenceLog()}` }, { hasUI: false })).reason, undefined);
	});

	it("the commit gate reads the repository at the working directory the process runs in", async () => {
		const viaBash = await outcome("bash", { command: "git commit -am change" }, { hasUI: false });
		const viaSub = await outcome("bg_start", { command: "git commit -am change", cwd: "sub" }, { hasUI: false });
		assert.deepEqual(viaSub, viaBash);
	});

	describe("the working directory", () => {
		it("inside the project asks nothing", async () => {
			for (const cwd of ["sub", join(repo, "sub"), ".", "./sub/.."]) {
				assert.deepEqual(await outcome("bg_start", { command: "ls", cwd }, { hasUI: false }), { reason: undefined, asked: [] }, cwd);
			}
		});

		it("outside the project is the write-outside-project rule: declined without a UI", async () => {
			for (const cwd of [join(dir, "elsewhere"), "../elsewhere", "/"]) {
				const result = await outcome("bg_start", { command: "ls", cwd }, { hasUI: false });
				assert.match(String(result.reason), /User declined write outside the project root/, cwd);
			}
		});

		it("outside the project asks the user, once, and grants that directory only", async () => {
			const s = await session({ hasUI: true, answer: true });
			assert.equal(await s.call("bg_start", { command: "ls", cwd: join(dir, "elsewhere") }), undefined);
			assert.deepEqual(s.asked, ["brigadev: write outside project"]);
			assert.equal(await s.call("bg_start", { command: "ls", cwd: join(dir, "elsewhere") }), undefined);
			assert.equal(await s.call("bg_start", { command: "ls", cwd: join(dir, "elsewhere", "deeper") }), undefined);
			assert.equal(s.asked.length, 1, "the grant covers that directory and below");
			assert.equal(await s.call("bg_start", { command: "ls", cwd: join(dir, "other") }), undefined);
			assert.equal(s.asked.length, 2, "a sibling directory is a new question: the grant was not widened to the parent");
		});

		it("a user who declines blocks the start", async () => {
			const result = await outcome("bg_start", { command: "ls", cwd: join(dir, "elsewhere") }, { hasUI: true, answer: false });
			assert.match(String(result.reason), /User declined write outside the project root/);
		});

		it("a sensitive directory asks first, and is declined without a UI", async () => {
			const cwd = join(repo, ".ssh");
			assert.match(String((await outcome("bg_start", { command: "ls", cwd }, { hasUI: false })).reason), /User declined access to sensitive file/);
			const yes = await outcome("bg_start", { command: "ls", cwd }, { hasUI: true, answer: true });
			assert.deepEqual(yes, { reason: undefined, asked: ["brigadev: sensitive file"] });
		});

		it("the evidence log folder is never a working directory", async () => {
			const result = await outcome("bg_start", { command: "ls", cwd: join(home, "repo", "evidence") }, { hasUI: true, answer: true });
			assert.match(String(result.reason), /evidence log/);
		});

		it("does not change what bash is asked: the same rules for a file in that directory", async () => {
			const s = await session({ hasUI: true, answer: true });
			assert.equal(await s.call("write", { path: join(dir, "elsewhere", "x.txt") }), undefined);
			assert.deepEqual(s.asked, ["brigadev: write outside project"]);
			assert.equal(await s.call("read", { path: join(repo, ".ssh", "id_rsa") }), undefined);
			assert.deepEqual(s.asked, ["brigadev: write outside project", "brigadev: sensitive file"]);
		});
	});

	it("the other background tools are not shell commands: the guard leaves them alone", async () => {
		const s = await session({ hasUI: false });
		for (const tool of ["bg_status", "bg_list", "bg_kill"]) assert.equal(await s.call(tool, { id: "bg-1", command: "rm -rf ~" }), undefined, tool);
	});
});
