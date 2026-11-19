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
	/** The full text of the result: the final text, the structured payload as a JSON block, or the error. */
	output: string;
	/** The validated structured payload as the child returned it, in full (agents with an output schema). */
	structured?: unknown;
	/** The child's final assistant text, in full. */
	finalText?: string;
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

/** A run id dated further ahead of the clock than this is not trusted for its age (see `pruneRunFolders`). */
const FUTURE_SKEW_MS = 86_400_000;

export interface PruneOptions {
	/** Remove run folders launched more than this many days ago. Default 14. */
	maxAgeDays?: number;
	/** After the age rule, keep at most this many of the newest folders. Default 200. */
	maxFolders?: number;
	/** Remove at most this many folders per call, so a large backlog (the first prune after an upgrade) does not stall a session start; the rest waits for the next call. Default 50. */
	maxRemovals?: number;
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

/** The one-line warning for a prune that hit errors (count and the first one), or undefined when there were none. */
export function pruneWarning(result: Pick<PruneResult, "errors">): string | undefined {
	const n = result.errors.length;
	if (n === 0) return undefined;
	return `brigadev: ${n} ${n === 1 ? "problem" : "problems"} while pruning old run folders; first: ${result.errors[0]}`;
}

/**
 * Retention for `<docs>/runs/`: removes run folders older than `maxAgeDays`, then the oldest
 * beyond `maxFolders`, at most `maxRemovals` per call (oldest first; the count rule only gets what the
 * age rule left of the cap). Age comes from the timestamp in the folder name, not the mtime, so
 * copying or touching a folder does not revive it. The exception is a name dated more than a day after `now`
 * (a made-up or copied id whose mtime is real): by its name it would sort as the newest forever and hold a slot, so its age
 * comes from its mtime instead and the age and count rules apply to it like any other. A folder written while the clock
 * itself was wrong has a future mtime too: it still waits until the clock catches up.
 * Only real directories (lstat, never a symlink) whose name is a generated run id are touched; everything else is left alone.
 * Never throws; a missing runs folder is a no-op.
 */
export function pruneRunFolders(docsDir: string, options: PruneOptions = {}): PruneResult {
	const result: PruneResult = { removed: [], errors: [] };
	try {
		const maxAgeMs = (options.maxAgeDays ?? 14) * 86_400_000;
		const maxFolders = options.maxFolders ?? 200;
		let budget = Math.max(0, options.maxRemovals ?? 50);
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
			let time = runIdTime(name);
			if (time === undefined) continue;
			try {
				const stat = fs.lstatSync(path.join(root, name));
				if (!stat.isDirectory()) continue;
				if (time - now > FUTURE_SKEW_MS) time = stat.mtimeMs;
			} catch (err) {
				result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
				continue;
			}
			candidates.push({ name, time });
		}
		const tryRemove = (name: string): boolean => {
			// An attempt spends the budget, a failed one too: the work per call stays bounded.
			budget--;
			try {
				remove(path.join(root, name));
				result.removed.push(name);
				return true;
			} catch (err) {
				result.errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
				return false;
			}
		};
		// Oldest first; the name breaks ties so the order is stable.
		candidates.sort((a, b) => a.time - b.time || (a.name < b.name ? -1 : 1));
		const remaining = candidates.filter((c) => (now - c.time > maxAgeMs && budget > 0 ? !tryRemove(c.name) : true));
		const excess = remaining.length - Math.max(0, maxFolders);
		for (const c of remaining.slice(0, Math.max(0, excess))) {
			if (budget <= 0) break;
			tryRemove(c.name);
		}
	} catch (err) {
		result.errors.push(err instanceof Error ? err.message : String(err));
	}
	return result;
}

/** Writes `task.md`, `transcript.json`, and `result.json` (with the full structured result and final text) to `<docs>/runs/<runId>/`; returns the folder. */
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
