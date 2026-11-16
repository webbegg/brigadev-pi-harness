// S3: the automatic backup, against real git in a temp repository.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";
import { BACKUP_PREFIX, backupRefName, createBackup, pruneBackups } from "../lib/dsp-backup.ts";
import { realExec, realTmp } from "./dsp-fixtures.test.ts";

describe("backup refs", () => {
	const dir = realTmp("dsp-backup-");
	let repo: string;
	let n = 0;
	const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const gitIn = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
	const commit = (message: string) => git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", message);
	const showFile = (ref: string, file: string) => git("show", `${ref}:${file}`);
	const fixedNow = new Date("2026-11-16T10:45:12Z");

	after(() => rmSync(dir, { recursive: true, force: true }));

	beforeEach(() => {
		repo = join(dir, `repo${++n}`);
		mkdirSync(repo, { recursive: true });
		git("init", "-q", "-b", "feat/x");
		writeFileSync(join(repo, ".gitignore"), "ignored.log\n");
		writeFileSync(join(repo, "tracked.txt"), "one\n");
		writeFileSync(join(repo, "gone.txt"), "to delete\n");
		git("add", "-A");
		commit("init");
	});

	it("names the ref with a UTC timestamp and a reason slug", () => {
		assert.equal(backupRefName(fixedNow, "reset-hard"), "refs/brigadev/backup/20261116T104512Z-reset-hard");
		assert.equal(backupRefName(fixedNow, "Branch -D / weird name!!"), "refs/brigadev/backup/20261116T104512Z-branch-d-weird-name");
		assert.ok(BACKUP_PREFIX.startsWith("refs/brigadev/backup/"));
	});

	it("snapshots the whole working tree: modified tracked, untracked, deleted; ignored files stay out; parent is HEAD", async () => {
		writeFileSync(join(repo, "tracked.txt"), "one\nmodified\n");
		writeFileSync(join(repo, "untracked.txt"), "brand new\n");
		writeFileSync(join(repo, "ignored.log"), "secret-ish\n");
		rmSync(join(repo, "gone.txt"));
		writeFileSync(join(repo, "staged.txt"), "staged only\n");
		git("add", "staged.txt");
		const head = git("rev-parse", "HEAD");
		const indexBefore = git("diff", "--cached", "--name-only");

		const result = await createBackup(realExec, repo, { slug: "reset-hard", branches: [], refs: [], stashes: [] }, { now: fixedNow });
		assert.equal(result.ok, true, JSON.stringify(result));
		if (!result.ok) return;
		assert.deepEqual(result.refs, ["refs/brigadev/backup/20261116T104512Z-reset-hard"]);

		const ref = result.refs[0];
		assert.equal(showFile(ref, "tracked.txt"), "one\nmodified");
		assert.equal(showFile(ref, "untracked.txt"), "brand new");
		assert.equal(showFile(ref, "staged.txt"), "staged only");
		const files = git("ls-tree", "-r", "--name-only", ref).split("\n");
		assert.ok(!files.includes("gone.txt"), "a deleted file is not in the snapshot");
		assert.ok(!files.includes("ignored.log"), "an ignored file is not in the snapshot");
		assert.equal(git("rev-parse", `${ref}^`), head, "the parent is HEAD");
		assert.equal(git("diff", "--cached", "--name-only"), indexBefore, "the real index is untouched");
		assert.equal(git("status", "--porcelain").includes("untracked.txt"), true, "the working tree is untouched");
	});

	it("the snapshot survives git reset --hard and git clean", async () => {
		writeFileSync(join(repo, "tracked.txt"), "precious change\n");
		writeFileSync(join(repo, "untracked.txt"), "precious new file\n");
		const result = await createBackup(realExec, repo, { slug: "reset-hard", branches: [], refs: [], stashes: [] }, { now: fixedNow });
		assert.equal(result.ok, true);
		git("reset", "--hard");
		git("clean", "-fd");
		git("gc", "--prune=now", "-q");
		assert.equal(git("status", "--porcelain"), "");
		if (result.ok) {
			assert.equal(showFile(result.refs[0], "tracked.txt"), "precious change");
			assert.equal(showFile(result.refs[0], "untracked.txt"), "precious new file");
		}
	});

	it("leaves no temporary index behind", async () => {
		const before = readdirSync(tmpdir()).filter((name) => name.startsWith("brigadev-dsp-")).length;
		await createBackup(realExec, repo, { slug: "x", branches: [], refs: [], stashes: [] }, { now: fixedNow });
		assert.equal(readdirSync(tmpdir()).filter((name) => name.startsWith("brigadev-dsp-")).length, before);
	});

	it("keeps the tip of a branch that branch -D deletes", async () => {
		git("checkout", "-q", "-b", "old");
		writeFileSync(join(repo, "old.txt"), "only on old\n");
		git("add", "-A");
		commit("old work");
		const tip = git("rev-parse", "old");
		git("checkout", "-q", "feat/x");

		const result = await createBackup(realExec, repo, { slug: "branch-delete", branches: ["old"], refs: [], stashes: [] }, { now: fixedNow });
		assert.equal(result.ok, true, JSON.stringify(result));
		if (!result.ok) return;
		assert.equal(result.refs.length, 2);
		git("branch", "-D", "old");
		const branchRef = result.refs.find((r) => r.endsWith("old"))!;
		assert.ok(branchRef, JSON.stringify(result.refs));
		assert.equal(git("rev-parse", branchRef), tip);
		assert.equal(showFile(branchRef, "old.txt"), "only on old");
	});

	it("keeps the stash commit that stash drop loses", async () => {
		writeFileSync(join(repo, "tracked.txt"), "stashed work\n");
		git("stash", "push", "-q");
		const stash = git("rev-parse", "stash@{0}");
		const result = await createBackup(realExec, repo, { slug: "stash-drop", branches: [], refs: [], stashes: ["stash@{0}"] }, { now: fixedNow });
		assert.equal(result.ok, true, JSON.stringify(result));
		if (!result.ok) return;
		git("stash", "drop", "-q");
		const stashRef = result.refs.find((r) => r.includes("stash"))!;
		assert.ok(result.refs.length >= 2);
		assert.equal(result.refs.some((ref) => git("rev-parse", ref) === stash), true, "a ref points at the dropped stash commit");
		assert.ok(stashRef);
	});

	it("keeps every stash for stash clear", async () => {
		writeFileSync(join(repo, "tracked.txt"), "a\n");
		git("stash", "push", "-q");
		writeFileSync(join(repo, "tracked.txt"), "b\n");
		git("stash", "push", "-q");
		const stashes = git("stash", "list", "--format=%H").split("\n");
		const result = await createBackup(realExec, repo, { slug: "stash-clear", branches: [], refs: [], stashes: ["*"] }, { now: fixedNow });
		assert.equal(result.ok, true);
		if (!result.ok) return;
		git("stash", "clear");
		const saved = new Set(result.refs.map((ref) => git("rev-parse", ref)));
		for (const stash of stashes) assert.ok(saved.has(stash), `stash ${stash} is kept`);
	});

	it("keeps a ref that update-ref rewrites", async () => {
		const tip = git("rev-parse", "HEAD");
		git("branch", "side");
		const result = await createBackup(realExec, repo, { slug: "update-ref", branches: [], refs: ["refs/heads/side"], stashes: [] }, { now: fixedNow });
		assert.equal(result.ok, true);
		if (result.ok) assert.equal(result.refs.some((ref) => git("rev-parse", ref) === tip && ref.endsWith("side")), true, JSON.stringify(result.refs));
	});

	it("a repository without commits still gets a snapshot (no parent)", async () => {
		const fresh = join(dir, "fresh");
		mkdirSync(fresh);
		gitIn(fresh, "init", "-q", "-b", "feat/x");
		writeFileSync(join(fresh, "a.txt"), "a\n");
		const result = await createBackup(realExec, fresh, { slug: "x", branches: [], refs: [], stashes: [] }, { now: fixedNow });
		assert.equal(result.ok, true, JSON.stringify(result));
		if (result.ok) assert.equal(gitIn(fresh, "show", `${result.refs[0]}:a.txt`), "a");
	});

	it("two backups in the same second get different refs", async () => {
		const plan = { slug: "x", branches: [], refs: [], stashes: [] };
		const one = await createBackup(realExec, repo, plan, { now: fixedNow });
		const two = await createBackup(realExec, repo, plan, { now: fixedNow });
		assert.equal(one.ok && two.ok, true);
		if (one.ok && two.ok) assert.notEqual(one.refs[0], two.refs[0]);
	});

	describe("failure", () => {
		it("outside a repository", async () => {
			const result = await createBackup(realExec, dir, { slug: "x", branches: [], refs: [], stashes: [] }, { now: fixedNow });
			assert.equal(result.ok, false);
		});

		it("a branch that cannot be resolved", async () => {
			const result = await createBackup(realExec, repo, { slug: "x", branches: ["no-such-branch"], refs: [], stashes: [] }, { now: fixedNow });
			assert.equal(result.ok, false);
			assert.match(String((result as any).error), /no-such-branch/);
		});

		it("a failing git (the injected exec) is a failure, not a throw", async () => {
			const result = await createBackup(async () => { throw new Error("boom"); }, repo, { slug: "x", branches: [], refs: [], stashes: [] }, { now: fixedNow });
			assert.equal(result.ok, false);
		});

		it("a failure leaves no partial backup ref", async () => {
			await createBackup(realExec, repo, { slug: "x", branches: ["no-such-branch"], refs: [], stashes: [] }, { now: fixedNow });
			assert.equal(git("for-each-ref", "refs/brigadev/"), "");
		});

		it("a ref write that fails after another ref was written rolls the first back (real git)", async () => {
			git("checkout", "-q", "-b", "old");
			git("checkout", "-q", "feat/x");
			for (const failAt of [2, 3]) {
				let updates = 0;
				const flaky: typeof realExec = async (command, args, options) => {
					// The Nth ref write (not a delete) fails the way a locked or full ref store would.
					if (command === "git" && args[0] === "update-ref" && args[1] !== "-d" && ++updates === failAt) return { stdout: "", stderr: "fatal: cannot lock ref\n", code: 128 };
					return realExec(command, args, options);
				};
				const plan = { slug: "branch-delete", branches: ["old"], refs: ["refs/heads/old"], stashes: ["stash@{0}"] };
				writeFileSync(join(repo, "tracked.txt"), `stash ${failAt}\n`);
				git("stash", "push", "-q");
				const result = await createBackup(flaky, repo, plan, { now: fixedNow });
				assert.equal(result.ok, false, `failAt ${failAt}: ${JSON.stringify(result)}`);
				assert.match(String((result as any).error), /update-ref .*cannot lock ref/);
				assert.ok(updates >= failAt, "the failing write was reached after an earlier one");
				assert.equal(git("for-each-ref", "refs/brigadev/"), "", `failAt ${failAt}: no backup ref is left`);
				git("stash", "clear");
			}
		});
	});

	describe("pruning", () => {
		const ref = (stamp: string, slug = "x") => `${BACKUP_PREFIX}${stamp}-${slug}`;
		const refs = () => git("for-each-ref", "--format=%(refname)", "refs/brigadev/backup/").split("\n").filter(Boolean);

		it("removes backups older than 14 days and keeps newer ones", async () => {
			const head = git("rev-parse", "HEAD");
			for (const name of [ref("20261101T000000Z"), ref("20261102T110000Z"), ref("20261110T000000Z"), ref("20261116T000000Z")]) git("update-ref", name, head);
			const removed = await pruneBackups(realExec, repo, new Date("2026-11-16T12:00:00Z"));
			assert.deepEqual(removed.sort(), [ref("20261101T000000Z"), ref("20261102T110000Z")]);
			assert.deepEqual(refs(), [ref("20261110T000000Z"), ref("20261116T000000Z")]);
		});

		it("removes at most 50 per run", async () => {
			const head = git("rev-parse", "HEAD");
			for (let i = 0; i < 60; i++) git("update-ref", ref(`202610${String(1 + (i % 9)).padStart(2, "0")}T${String(i).padStart(6, "0")}Z`, `n${i}`), head);
			const removed = await pruneBackups(realExec, repo, new Date("2026-11-16T12:00:00Z"));
			assert.equal(removed.length, 50);
			assert.equal(refs().length, 10);
		});

		it("leaves refs it cannot date alone", async () => {
			const head = git("rev-parse", "HEAD");
			git("update-ref", `${BACKUP_PREFIX}handmade`, head);
			await pruneBackups(realExec, repo, new Date("2030-01-01T00:00:00Z"));
			assert.deepEqual(refs(), [`${BACKUP_PREFIX}handmade`]);
		});

		it("createBackup prunes old backups after it succeeds", async () => {
			const head = git("rev-parse", "HEAD");
			git("update-ref", ref("20260101T000000Z", "old"), head);
			const result = await createBackup(realExec, repo, { slug: "x", branches: [], refs: [], stashes: [] }, { now: fixedNow });
			assert.equal(result.ok, true);
			assert.equal(refs().includes(ref("20260101T000000Z", "old")), false);
		});
	});
});
