import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
	appendOutsideWrite,
	bashOutsideTargets,
	changedSince,
	checkSecureDir,
	formatOutsideWrites,
	outsideWhy,
	outsideWritesFile,
	readOutsideWrites,
	runYoloDirCommand,
	secureYoloDirs,
	trustedTempRoots,
} from "../lib/outside-writes.ts";
import type { BrigadevSettings } from "../lib/runtime.ts";

let scratch: string;
let home: string;
let agentDir: string;

before(() => {
	scratch = realpathSync(mkdtempSync(join(tmpdir(), "outside-writes-")));
	home = join(scratch, "home");
	agentDir = join(home, ".pi", "agent");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(join(home, "scratch"), { recursive: true });
});
after(() => rmSync(scratch, { recursive: true, force: true }));

const guard = () => ({ home, agentDir });

describe("secure-yolo folder validation", () => {
	it("accepts an absolute folder and returns it canonical", () => {
		assert.deepEqual(checkSecureDir(join(home, "scratch"), guard()), { ok: true, path: join(home, "scratch") });
		assert.deepEqual(checkSecureDir(`${join(home, "scratch")}/`, guard()), { ok: true, path: join(home, "scratch") });
	});

	it("refuses relative paths, the root, the home folder and its ancestors", () => {
		for (const raw of ["", "  ", "relative/dir", "/", home, scratch]) {
			assert.equal(checkSecureDir(raw, guard()).ok, false, raw);
		}
	});

	it("refuses a folder that holds or sits inside the agent settings folder", () => {
		assert.equal(checkSecureDir(join(home, ".pi"), guard()).ok, false);
		assert.equal(checkSecureDir(join(agentDir, "extensions"), guard()).ok, false);
	});

	it("refuses a folder that commonly holds secrets", () => {
		assert.equal(checkSecureDir(join(home, ".ssh"), guard()).ok, false);
	});

	for (const rel of [".ssh", ".aws", ".docker", ".gnupg", ".kube", join(".config", "gh"), join(".config", "git"), join(".config", "fish"), ".config", join(".aws", "sso")]) {
		it(`refuses ~/${rel}: it is, holds, or sits in a credential or config folder`, () => {
			assert.equal(checkSecureDir(join(home, rel), guard()).ok, false, rel);
		});
	}

	it("refuses a differently-cased credential or agent folder on a case-insensitive platform", { skip: process.platform !== "darwin" && process.platform !== "win32" }, () => {
		for (const rel of [".AWS", ".SSH", ".Config", join(".config", "GH"), ".Docker", ".PI"]) assert.equal(checkSecureDir(join(home, rel), guard()).ok, false, rel);
		assert.equal(checkSecureDir(home.toUpperCase(), guard()).ok, false);
	});

	it("refuses a folder that overlaps the harness docs home or the install root", () => {
		const g = { ...guard(), protectedDirs: [join(home, ".brigadev"), join(scratch, "lib", "brigadev")] };
		for (const raw of [join(home, ".brigadev"), join(home, ".brigadev", "other-repo"), join(scratch, "lib"), join(scratch, "lib", "brigadev", "extensions")]) {
			assert.equal(checkSecureDir(raw, g).ok, false, raw);
		}
		assert.equal(checkSecureDir(join(home, "scratch"), g).ok, true);
	});

	it("drops a system temp root that is the root, the home folder, or holds it", () => {
		assert.deepEqual(trustedTempRoots([join(home, "tmp-ok"), home, scratch, "/"], home), [join(home, "tmp-ok")]);
	});

	it("keeps only valid configured folders, deduplicated", () => {
		const dirs = secureYoloDirs([join(home, "scratch"), `${join(home, "scratch")}/`, "/", 42, "rel", join(home, ".ssh")], guard());
		assert.deepEqual(dirs, [join(home, "scratch")]);
		assert.deepEqual(secureYoloDirs(undefined, guard()), []);
		assert.deepEqual(secureYoloDirs("not-an-array", guard()), []);
	});
});

describe("why a write outside the project was allowed", () => {
	const scope = () => ({ projectRoot: join(scratch, "project"), docsDir: join(home, ".brigadev", "project"), tempRoots: [join(scratch, "tmp")], secureDirs: [join(home, "scratch")], dsp: false });

	it("names the reason, or nothing inside the project", () => {
		assert.equal(outsideWhy(join(scratch, "project", "a.ts"), scope()), undefined);
		assert.equal(outsideWhy(join(home, ".brigadev", "project", "tasks", "x.md"), scope()), "docs");
		assert.equal(outsideWhy(join(scratch, "tmp", "x"), scope()), "temp");
		assert.equal(outsideWhy(join(home, "scratch", "x"), scope()), "secure");
		assert.equal(outsideWhy(join(home, "elsewhere", "x"), scope()), "granted");
		assert.equal(outsideWhy(join(home, "elsewhere", "x"), { ...scope(), dsp: true }), "dsp");
		assert.equal(outsideWhy(join(home, "elsewhere", "x"), { ...scope(), dsp: true, shell: true }), "shell");
		assert.equal(outsideWhy(join(scratch, "tmp", "x"), { ...scope(), shell: true }), "temp");
	});
});

describe("files a bash command writes outside the project", () => {
	const scope = () => ({ projectRoot: join(scratch, "project"), docsDir: join(home, ".brigadev", "project"), tempRoots: [join(scratch, "tmp")], secureDirs: [join(home, "scratch")], dsp: false, shell: true });

	it("names each literal write target outside the project once, with its reason", () => {
		const command = `echo x > ${join(scratch, "tmp", "a.txt")} && cp f ${join(home, "elsewhere", "b")} && touch inside.txt && echo y >> ${join(scratch, "tmp", "a.txt")} && tee ${join(home, "scratch", "c.log")} < f`;
		assert.deepEqual(bashOutsideTargets(command, join(scratch, "project"), scope()), [
			{ path: join(scratch, "tmp", "a.txt"), why: "temp" },
			{ path: join(home, "elsewhere", "b"), why: "shell" },
			{ path: join(home, "scratch", "c.log"), why: "secure" },
		]);
	});

	it("resolves relative targets against the working directory and skips what the shell would expand", () => {
		assert.deepEqual(bashOutsideTargets("echo x > ../out.txt", join(scratch, "project"), scope()), [{ path: join(scratch, "out.txt"), why: "shell" }]);
		assert.deepEqual(bashOutsideTargets("echo x > $OUT && echo y > /tmp/*.log", join(scratch, "project"), scope()), []);
	});

	it("never names a temp root, the home folder, or the root itself (a copy into the folder, not a file)", () => {
		assert.deepEqual(bashOutsideTargets(`cp a ${join(scratch, "tmp")} && cp b ${home} && cp c /`, join(scratch, "project"), { ...scope(), home }), []);
	});

	it("keeps only targets created or changed since the stamp", () => {
		const dirA = join(scratch, "stamps");
		mkdirSync(dirA, { recursive: true });
		const touched = join(dirA, "touched.txt");
		const untouched = join(dirA, "untouched.txt");
		const created = join(dirA, "created.txt");
		const missing = join(dirA, "missing.txt");
		writeFileSync(touched, "a");
		writeFileSync(untouched, "a");
		utimesSync(touched, 1000, 1000);
		utimesSync(untouched, 1000, 1000);
		const targets = [touched, untouched, created, missing].map((path) => ({ path, why: "shell" as const }));
		const check = changedSince(targets);
		writeFileSync(touched, "b");
		writeFileSync(created, "new");
		assert.deepEqual(check().map((t) => t.path), [touched, created]);
	});
});

describe("outside-writes ledger", () => {
	it("appends JSON lines with user-only permissions and reads them back, skipping bad lines", () => {
		const docs = join(scratch, "docs-a");
		const file = outsideWritesFile(docs);
		assert.equal(file, join(docs, "outside-writes.jsonl"));
		appendOutsideWrite(file, { ts: "2026-11-17T10:00:00.000Z", tool: "write", path: "/tmp/a", why: "temp" });
		writeFileSync(file, `${readFileSync(file, "utf8")}not json\n{"ts":1}\n`);
		appendOutsideWrite(file, { ts: "2026-11-17T10:01:00.000Z", tool: "edit", path: "/x/b", why: "granted" });
		assert.deepEqual(readOutsideWrites(file), [
			{ ts: "2026-11-17T10:00:00.000Z", tool: "write", path: "/tmp/a", why: "temp" },
			{ ts: "2026-11-17T10:01:00.000Z", tool: "edit", path: "/x/b", why: "granted" },
		]);
		assert.equal(statSync(file).mode & 0o777, 0o600);
		assert.deepEqual(readOutsideWrites(join(scratch, "missing", "outside-writes.jsonl")), []);
	});

	it("lists each path once, most recent first, with its write count", () => {
		const text = formatOutsideWrites([
			{ ts: "2026-11-17T10:00:00.000Z", tool: "write", path: "/tmp/a", why: "temp" },
			{ ts: "2026-11-17T10:01:00.000Z", tool: "write", path: "/x/b", why: "granted" },
			{ ts: "2026-11-17T10:02:00.000Z", tool: "edit", path: "/tmp/a", why: "temp" },
		]);
		const lines = text.split("\n");
		assert.match(lines[0], /2 files/);
		assert.match(lines[1], /temp\s+edit\s+\/tmp\/a\s+\(2 writes\)/);
		assert.match(lines[2], /granted\s+write\s+\/x\/b$/);
		assert.match(formatOutsideWrites([{ ts: "2026-11-17T10:00:00.000Z", tool: "bash", path: "/tmp/c", why: "temp", agent: "worker" }]), /temp\s+bash\s+\/tmp\/c\s+\[worker\]/);
		assert.match(formatOutsideWrites([]), /No writes outside the project/);
	});
});

describe("/brigadev:yolo-dir", () => {
	const store = () => {
		let settings: BrigadevSettings = {};
		return { read: () => settings, write: (update: BrigadevSettings) => (settings = { ...settings, ...update }), get: () => settings };
	};
	const env = () => ({ ...guard(), tempRoots: [join(scratch, "tmp")] });

	it("adds, lists, and removes folders", () => {
		const s = store();
		assert.match(runYoloDirCommand(`add ${join(home, "scratch")}`, s, env()), /added/);
		assert.deepEqual(s.get().secureYoloDirs, [join(home, "scratch")]);
		assert.match(runYoloDirCommand(`add ${join(home, "scratch")}/`, s, env()), /already/);
		assert.deepEqual(s.get().secureYoloDirs, [join(home, "scratch")]);
		const listed = runYoloDirCommand("list", s, env());
		assert.match(listed, new RegExp(join(scratch, "tmp")));
		assert.match(listed, new RegExp(join(home, "scratch")));
		assert.match(runYoloDirCommand(`remove ${join(home, "scratch")}`, s, env()), /removed/);
		assert.deepEqual(s.get().secureYoloDirs, []);
		assert.match(runYoloDirCommand(`remove ${join(home, "scratch")}`, s, env()), /not a secure-yolo folder/);
	});

	it("refuses an unsafe folder and writes nothing", () => {
		const s = store();
		assert.match(runYoloDirCommand(`add ${home}`, s, env()), /refused/);
		assert.equal(s.get().secureYoloDirs, undefined);
	});

	it("answers usage for anything else", () => {
		assert.match(runYoloDirCommand("frobnicate", store(), env()), /Usage: \/brigadev:yolo-dir/);
	});
});
