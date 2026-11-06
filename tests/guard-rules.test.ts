import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { BranchFacts } from "../lib/commit-branch.ts";
import { canonicalPath } from "../lib/paths.ts";
import { decideBashCommand, decideFileAccess, type FileAccessInput } from "../lib/guard-rules.ts";
import { PERMISSION_MODE } from "../lib/permission-policy.ts";

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
