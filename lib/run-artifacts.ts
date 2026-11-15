// One saved folder per subagent run, under the repo docs folder (never inside
// the project): the task the child received, its transcript, and the result.
// Transcripts can hold anything the child read, so everything is user-only.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { Tally } from "./cost.ts";

export interface RunRecord {
	runId: string;
	agent: string;
	task: string;
	reason?: string;
	/** The full task text the child was launched with. */
	taskText: string;
	model?: string;
	thinking?: string;
	route?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	startedAt?: number;
	endedAt?: number;
	usage: Tally;
	/** What the parent was told: the final text, structured payload, or error. */
	output: string;
	messages: Message[];
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const runsDir = (docsDir: string): string => path.join(docsDir, "runs");

/** `<UTC yyyymmddThhmmssZ>-<agent>-<6 hex>`: sorts by launch time, safe as a folder name. */
export function newRunId(agent: string, now: number = Date.now(), random: () => string = randomUUID): string {
	const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const name = agent.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	return `${stamp}-${name}-${random().replace(/-/g, "").slice(0, 6)}`;
}

/** The id format `newRunId` produces: `<yyyymmddThhmmssZ>-<name>-<6 hex>`. */
const GENERATED_RUN_ID = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-[A-Za-z0-9_-]+-[0-9a-f]{6}$/;

/** Launch time from a generated run id, or undefined when the name is not one (or is not a real date). */
function runIdTime(name: string): number | undefined {
	if (!RUN_ID.test(name)) return undefined;
	const m = GENERATED_RUN_ID.exec(name);
	if (!m) return undefined;
	const [y, mo, d, h, mi, s] = m.slice(1, 7).map(Number);
	const time = Date.UTC(y, mo - 1, d, h, mi, s);
	const back = new Date(time);
	const real = back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d && back.getUTCHours() === h && back.getUTCMinutes() === mi && back.getUTCSeconds() === s;
	return real ? time : undefined;
}

export interface PruneOptions {
	/** Remove run folders launched more than this many days ago. Default 14. */
	maxAgeDays?: number;
	/** After the age rule, keep at most this many of the newest folders. Default 200. */
	maxFolders?: number;
	/** Clock, injectable for tests. */
	now?: () => number;
	/** Removes one folder; injectable for tests. Defaults to a recursive `fs.rmSync`. */
	remove?: (dir: string) => void;
}

export interface PruneResult {
	/** Names of the run folders removed. */
	removed: string[];
	/** One message per entry that could not be inspected or removed. */
	errors: string[];
}

/**
 * Retention for `<docs>/runs/`: removes run folders older than `maxAgeDays`, then the oldest
 * beyond `maxFolders`. Age comes from the timestamp in the folder name, not the mtime, so
 * copying or touching a folder does not revive it. Only real directories (lstat, never a
 * symlink) whose name is a generated run id are touched; everything else is left alone.
 * Never throws; a missing runs folder is a no-op.
 */
export function pruneRunFolders(docsDir: string, options: PruneOptions = {}): PruneResult {
	const result: PruneResult = { removed: [], errors: [] };
	try {
		const maxAgeMs = (options.maxAgeDays ?? 14) * 86_400_000;
		const maxFolders = options.maxFolders ?? 200;
		const now = (options.now ?? Date.now)();
		const remove = options.remove ?? ((dir: string) => fs.rmSync(dir, { recursive: true, force: true }));
		const root = runsDir(docsDir);
		try {
			// A symlinked runs folder is never followed.
			if (!fs.lstatSync(root).isDirectory()) return result;
		} catch {
			return result;
		}
		const names = fs.readdirSync(root);
		const candidates: { name: string; time: number }[] = [];
		for (const name of names) {
			const time = runIdTime(name);
			if (time === undefined) continue;
			try {
				if (!fs.lstatSync(path.join(root, name)).isDirectory()) continue;
			} catch (err) {
				result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			candidates.push({ name, time });
		}
		const tryRemove = (name: string): boolean => {
			try {
				remove(path.join(root, name));
				result.removed.push(name);
				return true;
			} catch (err) {
				result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		};
		const remaining = candidates.filter((c) => now - c.time > maxAgeMs ? !tryRemove(c.name) : true);
		const excess = remaining.length - Math.max(0, maxFolders);
		if (excess > 0) {
			// Oldest first; the name breaks ties so the order is stable.
			remaining.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : 1));
			for (const c of remaining.slice(0, excess)) tryRemove(c.name);
		}
	} catch (err) {
		result.errors.push(err instanceof Error ? err.message : String(err));
	}
	return result;
}

/** Writes `task.md`, `transcript.json`, and `result.json` to `<docs>/runs/<runId>/`; returns the folder. */
export function writeRunArtifacts(docsDir: string, record: RunRecord): string {
	if (!RUN_ID.test(record.runId)) throw new Error(`invalid run id: ${record.runId}`);
	const dir = path.join(runsDir(docsDir), record.runId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const { messages, taskText, ...result } = record;
	const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text, { encoding: "utf8", mode: 0o600 });
	write("task.md", taskText);
	write("transcript.json", `${JSON.stringify(messages, null, 2)}\n`);
	write("result.json", `${JSON.stringify(result, null, 2)}\n`);
	return dir;
}
