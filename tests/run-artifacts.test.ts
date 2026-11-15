import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { newRunId, pruneRunFolders, runsDir, writeRunArtifacts, type RunRecord } from "../lib/run-artifacts.ts";
import { emptyTally } from "../lib/cost.ts";

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
	runId: "20261114T150203Z-brigadev-explore-abc123",
	agent: "brigadev-explore",
	task: "map the code",
	reason: "Evidence budget",
	taskText: "# Task\nmap the code",
	model: "anthropic/claude-sonnet-5-5",
	route: "definition",
	exitCode: 0,
	stopReason: "stop",
	startedAt: 1,
	endedAt: 2,
	usage: emptyTally(),
	output: "the map",
	messages: [{ role: "assistant", content: [{ type: "text", text: "the map" }] } as any],
	...over,
});

describe("newRunId", () => {
	it("is sortable by time and names the agent, filename-safe", () => {
		const id = newRunId("brigadev-explore", Date.UTC(2026, 10, 14, 15, 2, 3), () => "abc123ffff-rest");
		assert.equal(id, "20261114T150203Z-brigadev-explore-abc123");
	});

	it("replaces characters that are unsafe in a path", () => {
		assert.equal(newRunId("../evil name", 0, () => "zzzzzz"), "19700101T000000Z-evil-name-zzzzzz");
	});
});

describe("writeRunArtifacts: one saved folder per run", () => {
	it("writes task.md, transcript.json, and result.json under <docs>/runs/<runId>/", () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-runs-"));
		try {
			const dir = writeRunArtifacts(docs, record());
			assert.equal(dir, path.join(runsDir(docs), "20261114T150203Z-brigadev-explore-abc123"));
			assert.equal(fs.readFileSync(path.join(dir, "task.md"), "utf8"), "# Task\nmap the code");
			assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "transcript.json"), "utf8")), record().messages);
			const result = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
			assert.equal(result.agent, "brigadev-explore");
			assert.equal(result.output, "the map");
			assert.equal(result.exitCode, 0);
			assert.equal("messages" in result, false);
			assert.equal("taskText" in result, false);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});

	it("keeps the folder and files private to the user", { skip: process.platform === "win32" }, () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-runs-"));
		try {
			const dir = writeRunArtifacts(docs, record());
			assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
			for (const file of ["task.md", "transcript.json", "result.json"]) assert.equal(fs.statSync(path.join(dir, file)).mode & 0o777, 0o600);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});

	it("rejects a run id that would escape the runs folder", () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-runs-"));
		try {
			assert.throws(() => writeRunArtifacts(docs, record({ runId: "../outside" })), /invalid run id/);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});
});

describe("pruneRunFolders: retention of saved run folders", () => {
	const DAY = 86_400_000;
	const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);
	const idAt = (daysAgo: number, name = "brigadev-explore", hex = "abc123") => newRunId(name, NOW - daysAgo * DAY, () => hex);
	const withDocs = (fn: (docs: string, runs: string) => void) => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-prune-"));
		try {
			const runs = runsDir(docs);
			fs.mkdirSync(runs, { recursive: true });
			fn(docs, runs);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	};
	const mk = (runs: string, id: string) => {
		fs.mkdirSync(path.join(runs, id));
		fs.writeFileSync(path.join(runs, id, "result.json"), "{}");
	};

	it("removes at most maxRemovals folders per call (50 by default), oldest first, and the next call continues", () => {
		withDocs((docs, runs) => {
			// 60 expired folders, 20 to 79 days old; the hex part keeps every id distinct.
			const ids = Array.from({ length: 60 }, (_, i) => idAt(20 + i, "a", i.toString(16).padStart(6, "0")));
			for (const id of ids) mk(runs, id);
			const first = pruneRunFolders(docs, { now: () => NOW });
			assert.equal(first.removed.length, 50);
			assert.deepEqual(first.removed, [...ids].reverse().slice(0, 50), "the oldest 50, oldest first");
			assert.equal(fs.readdirSync(runs).length, 10);
			const second = pruneRunFolders(docs, { now: () => NOW });
			assert.deepEqual(second.removed, [...ids].reverse().slice(50));
			assert.deepEqual(fs.readdirSync(runs), []);
		});
	});

	it("maxRemovals caps the age rule, so the count rule waits for a later call", () => {
		withDocs((docs, runs) => {
			const expired = [30, 31, 32].map((d, i) => idAt(d, "e", `00000${i}`));
			const fresh = [1, 2, 3, 4].map((d, i) => idAt(d, "f", `00001${i}`));
			for (const id of [...expired, ...fresh]) mk(runs, id);
			const out = pruneRunFolders(docs, { now: () => NOW, maxFolders: 2, maxRemovals: 2 });
			assert.deepEqual(out.removed, [expired[2], expired[1]], "oldest expired first; nothing left of the cap for the count rule");
			assert.equal(fs.readdirSync(runs).length, 5);
		});
	});

	it("the count rule uses what the age rule left of the cap, oldest first", () => {
		withDocs((docs, runs) => {
			const expired = idAt(30, "e", "000000");
			const fresh = [1, 2, 3, 4].map((d, i) => idAt(d, "f", `00001${i}`));
			for (const id of [expired, ...fresh]) mk(runs, id);
			const first = pruneRunFolders(docs, { now: () => NOW, maxFolders: 2, maxRemovals: 2 });
			assert.deepEqual(first.removed, [expired, fresh[3]]);
			const second = pruneRunFolders(docs, { now: () => NOW, maxFolders: 2, maxRemovals: 2 });
			assert.deepEqual(second.removed, [fresh[2]]);
			assert.deepEqual(fs.readdirSync(runs).sort(), [fresh[0], fresh[1]].sort());
		});
	});

	it("removes folders older than maxAgeDays (14 by default), by the timestamp in the name", () => {
		withDocs((docs, runs) => {
			const old = idAt(15);
			const fresh = idAt(13);
			mk(runs, old);
			mk(runs, fresh);
			// A fresh mtime must not revive an old folder.
			fs.utimesSync(path.join(runs, old), new Date(NOW), new Date(NOW));
			const out = pruneRunFolders(docs, { now: () => NOW });
			assert.deepEqual(out, { removed: [old], errors: [] });
			assert.equal(fs.existsSync(path.join(runs, old)), false);
			assert.equal(fs.existsSync(path.join(runs, fresh)), true);
		});
	});

	it("honors a custom maxAgeDays", () => {
		withDocs((docs, runs) => {
			mk(runs, idAt(3));
			mk(runs, idAt(1, "b", "bbbbbb"));
			const out = pruneRunFolders(docs, { now: () => NOW, maxAgeDays: 2 });
			assert.equal(out.removed.length, 1);
			assert.equal(fs.readdirSync(runs).length, 1);
		});
	});

	it("keeps only the maxFolders newest when there are too many", () => {
		withDocs((docs, runs) => {
			const ids = [1, 2, 3, 4, 5].map((d, i) => idAt(d, "a", `00000${i}`));
			for (const id of ids) mk(runs, id);
			const out = pruneRunFolders(docs, { now: () => NOW, maxFolders: 2 });
			assert.deepEqual(out.errors, []);
			assert.deepEqual([...out.removed].sort(), [ids[2], ids[3], ids[4]].sort());
			assert.deepEqual(fs.readdirSync(runs).sort(), [ids[0], ids[1]].sort());
		});
	});

	it("applies the age rule first, then the count rule to what remains", () => {
		withDocs((docs, runs) => {
			const old = idAt(30, "a", "000000");
			const keep = [idAt(1, "a", "000001"), idAt(2, "a", "000002")];
			const extra = idAt(3, "a", "000003");
			for (const id of [old, ...keep, extra]) mk(runs, id);
			const out = pruneRunFolders(docs, { now: () => NOW, maxFolders: 2 });
			assert.deepEqual([...out.removed].sort(), [old, extra].sort());
			assert.deepEqual(fs.readdirSync(runs).sort(), keep.sort());
		});
	});

	it("defaults to keeping 200 folders", () => {
		withDocs((docs, runs) => {
			for (let i = 0; i < 202; i++) mk(runs, newRunId("a", NOW - i * 1000, () => i.toString(16).padStart(6, "0")));
			const out = pruneRunFolders(docs, { now: () => NOW });
			assert.equal(out.removed.length, 2);
			assert.equal(fs.readdirSync(runs).length, 200);
		});
	});

	it("leaves files and names that are not run ids alone, even when old", () => {
		withDocs((docs, runs) => {
			const oldId = idAt(100);
			const names = ["notes", "20200101T000000Z-agent", "20200101T000000Z-agent-ZZZZZZ", "2020-01-01-agent-abc123", "20201301T000000Z-agent-abc123", "..hidden"];
			for (const n of names) fs.mkdirSync(path.join(runs, n));
			const oldFile = `${idAt(100, "file", "ffffff")}`;
			fs.writeFileSync(path.join(runs, oldFile), "x");
			mk(runs, oldId);
			const out = pruneRunFolders(docs, { now: () => NOW, maxFolders: 0 });
			assert.deepEqual(out, { removed: [oldId], errors: [] });
			assert.deepEqual(fs.readdirSync(runs).sort(), [...names, oldFile].sort());
		});
	});

	it("does not follow or delete a symlink, even one named like an old run id", { skip: process.platform === "win32" }, () => {
		withDocs((docs, runs) => {
			const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-outside-"));
			try {
				fs.writeFileSync(path.join(outside, "precious.txt"), "keep");
				const link = idAt(100);
				fs.symlinkSync(outside, path.join(runs, link));
				const out = pruneRunFolders(docs, { now: () => NOW, maxFolders: 0 });
				assert.deepEqual(out, { removed: [], errors: [] });
				assert.equal(fs.lstatSync(path.join(runs, link)).isSymbolicLink(), true);
				assert.equal(fs.readFileSync(path.join(outside, "precious.txt"), "utf8"), "keep");
			} finally {
				fs.rmSync(outside, { recursive: true, force: true });
			}
		});
	});

	it("does not follow a symlinked runs folder", { skip: process.platform === "win32" }, () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-prune-"));
		const outside = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-outside-"));
		try {
			const id = idAt(100);
			fs.mkdirSync(path.join(outside, id));
			fs.symlinkSync(outside, runsDir(docs));
			assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }), { removed: [], errors: [] });
			assert.equal(fs.existsSync(path.join(outside, id)), true);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
			fs.rmSync(outside, { recursive: true, force: true });
		}
	});

	it("is a no-op when the runs folder does not exist", () => {
		const docs = fs.mkdtempSync(path.join(os.tmpdir(), "brigadev-prune-"));
		try {
			assert.deepEqual(pruneRunFolders(docs, { now: () => NOW }), { removed: [], errors: [] });
			assert.deepEqual(pruneRunFolders(path.join(docs, "missing"), { now: () => NOW }), { removed: [], errors: [] });
			assert.equal(fs.existsSync(runsDir(docs)), false);
		} finally {
			fs.rmSync(docs, { recursive: true, force: true });
		}
	});

	it("reports an entry it cannot remove and keeps going", () => {
		withDocs((docs, runs) => {
			const a = idAt(40, "a", "000001");
			const b = idAt(41, "a", "000002");
			const c = idAt(42, "a", "000003");
			for (const id of [a, b, c]) mk(runs, id);
			const remove = (p: string) => {
				if (p.endsWith(b)) throw new Error("EACCES: denied");
				fs.rmSync(p, { recursive: true, force: true });
			};
			const out = pruneRunFolders(docs, { now: () => NOW, remove });
			assert.deepEqual([...out.removed].sort(), [a, c].sort());
			assert.equal(out.errors.length, 1);
			assert.match(out.errors[0], new RegExp(`${b}.*EACCES`));
			assert.deepEqual(fs.readdirSync(runs), [b]);
		});
	});
});
