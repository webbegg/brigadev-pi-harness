// Writes outside the project: the secure-yolo folders (where the parent's `write`/`edit` run without asking, like
// the system temp dir) and the ledger of every file the parent wrote outside the project,
// `<repo docs>/outside-writes.jsonl`. Pure helpers plus node:fs; extensions/guard.ts decides and records.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { extractWriteTargets } from "./bash-writes.ts";
import { canonicalPath, expandHome, isInside } from "./paths.ts";
import { isSensitivePath } from "./permission-policy.ts";
import { isRepoDocsPath } from "./repo-docs.ts";
import type { BrigadevSettings } from "./runtime.ts";

/**
 * Why a write outside the project ran: temp dir, secure-yolo folder, a session grant, the repo docs folder, DSP, or a
 * shell command (bash writes are not asked about by path).
 */
export type OutsideWhy = "temp" | "secure" | "granted" | "docs" | "dsp" | "shell";

export interface OutsideWriteRecord {
	ts: string;
	tool: string;
	/** Canonical absolute path written. */
	path: string;
	why: OutsideWhy;
	/** The subagent that wrote it; absent for the parent session. */
	agent?: string;
}

/** Folders a secure-yolo folder must not overlap with. */
export interface SecureDirGuard {
	home: string;
	/** Pi's agent folder: it holds brigadev.json, where this list lives. */
	agentDir: string;
	/** More folders a silent write must never reach: the harness docs home (every repo's evidence log), the install root. */
	protectedDirs?: readonly string[];
}

// Folders in the home directory that hold credentials or tool config (the DSP credential folders, plus GnuPG, kube, git config).
const HOME_SECRET_FOLDERS = [".ssh", ".aws", ".docker", ".gnupg", ".kube", join(".config", "gh"), join(".config", "git"), join(".config", "fish")];

// macOS and Windows disks ignore letter case by default, so `~/.AWS` is `~/.aws` there: fold case before comparing.
const foldCase = process.platform === "darwin" || process.platform === "win32";
const fold = (path: string) => (foldCase ? path.toLowerCase() : path);
const overlaps = (a: string, b: string) => isInside(fold(a), fold(b)) || isInside(fold(b), fold(a));

export type SecureDirCheck = { ok: true; path: string } | { ok: false; reason: string };

/**
 * A folder may become a secure-yolo folder when it is absolute (or `~/…`), not the root, not the home folder or
 * one of its ancestors, does not overlap the agent folder (a folder inside it, or one holding it, would let a write
 * change this very list), a credential folder of the home directory, or `protectedDirs`, and does not commonly hold secrets.
 */
export function checkSecureDir(raw: string, guard: SecureDirGuard): SecureDirCheck {
	const trimmed = raw.trim();
	if (trimmed === "") return { ok: false, reason: "no folder given" };
	const expanded = expandHome(trimmed);
	if (!isAbsolute(expanded)) return { ok: false, reason: `${trimmed} is not absolute (use /… or ~/…)` };
	const path = canonicalPath(expanded);
	const home = canonicalPath(guard.home);
	const agent = canonicalPath(guard.agentDir);
	if (path === "/" || isInside(fold(path), fold(home))) return { ok: false, reason: `${path} is the root, your home folder, or holds it: too broad` };
	if (overlaps(path, agent)) return { ok: false, reason: `${path} overlaps the agent settings folder ${agent}` };
	const secret = HOME_SECRET_FOLDERS.map((rel) => join(home, rel)).find((dir) => overlaps(path, dir));
	if (secret || isSensitivePath(`${path}/`)) return { ok: false, reason: `${path} is, holds, or sits in a folder that holds credentials (${secret ?? path})` };
	const guarded = (guard.protectedDirs ?? []).map((dir) => canonicalPath(dir)).find((dir) => overlaps(path, dir));
	if (guarded) return { ok: false, reason: `${path} overlaps ${guarded}, which the harness protects` };
	return { ok: true, path };
}

/** The configured secure-yolo folders that pass `checkSecureDir`, canonical and deduplicated; anything else is dropped. */
export function secureYoloDirs(configured: unknown, guard: SecureDirGuard): string[] {
	if (!Array.isArray(configured)) return [];
	const dirs: string[] = [];
	for (const entry of configured) {
		if (typeof entry !== "string") continue;
		const check = checkSecureDir(entry, guard);
		if (check.ok && !dirs.includes(check.path)) dirs.push(check.path);
	}
	return dirs;
}

/**
 * The system temp roots minus the root folder, the home folder, and its ancestors (a `TMPDIR` set to the home folder would
 * otherwise make every write in it silent). Other overlaps (an agent folder kept under /tmp) are the user's setup: /tmp is
 * writable by every local process anyway.
 */
export function trustedTempRoots(roots: readonly string[], home: string): string[] {
	const canonicalHome = canonicalPath(home);
	return roots.filter((root) => root !== "/" && !isInside(root, canonicalHome));
}

export interface OutsideScope {
	projectRoot: string;
	/** A function is called only for a path outside the project (resolving it runs git). */
	docsDir: string | (() => string);
	tempRoots: readonly string[];
	secureDirs: readonly string[];
	dsp: boolean;
	/** The write comes from a shell command: outside the trusted folders it is "shell", whatever the mode. */
	shell?: boolean;
}

/** Why an allowed write to `absolute` ran, or undefined when it is inside the project (nothing to record). */
export function outsideWhy(absolute: string, scope: OutsideScope): OutsideWhy | undefined {
	if (isInside(scope.projectRoot, absolute)) return undefined;
	if (isRepoDocsPath(typeof scope.docsDir === "function" ? scope.docsDir() : scope.docsDir, absolute)) return "docs";
	if (scope.tempRoots.some((root) => isInside(root, absolute))) return "temp";
	if (scope.secureDirs.some((root) => isInside(root, absolute))) return "secure";
	if (scope.shell) return "shell";
	return scope.dsp ? "dsp" : "granted";
}

export interface OutsideTarget {
	path: string;
	why: OutsideWhy;
}

/**
 * The files a shell command writes outside the project by literal name (`>`, `>>`, `tee`, `cp`/`mv` destinations,
 * `touch`, `sed -i`, ... as lib/bash-writes.ts reads them), canonical, once each, with their reason. Best effort:
 * names the shell would expand, scripts, and interpreters are not read. The root, `home`, and the temp and secure
 * roots themselves are left out: a copy into one of them names the folder, not the file it creates.
 */
export function bashOutsideTargets(command: string, cwd: string, scope: OutsideScope & { home?: string }): OutsideTarget[] {
	const roots = new Set(["/", ...scope.tempRoots, ...scope.secureDirs, ...(scope.home ? [canonicalPath(scope.home)] : [])]);
	const found: OutsideTarget[] = [];
	for (const target of extractWriteTargets(command, cwd)) {
		const path = canonicalPath(target);
		if (roots.has(path) || found.some((entry) => entry.path === path)) continue;
		const why = outsideWhy(path, { ...scope, shell: true });
		if (why) found.push({ path, why });
	}
	return found;
}

function stamp(path: string): string | undefined {
	try {
		const stats = statSync(path);
		return `${stats.ino}:${stats.size}:${stats.mtimeMs}`;
	} catch {
		return undefined;
	}
}

/** Stamps the targets now; the returned check gives the ones that exist afterwards and were created or changed since. */
export function changedSince<T extends { path: string }>(targets: readonly T[]): () => T[] {
	const before = targets.map((target) => stamp(target.path));
	return () =>
		targets.filter((target, index) => {
			const after = stamp(target.path);
			return after !== undefined && after !== before[index];
		});
}

export function outsideWritesFile(docsDir: string): string {
	return join(docsDir, "outside-writes.jsonl");
}

/** Appends one record (the folder is created; the file is user-only). Throws on I/O errors; the caller decides. */
export function appendOutsideWrite(file: string, record: OutsideWriteRecord): void {
	mkdirSync(dirname(file), { recursive: true });
	const fresh = !existsSync(file);
	appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
	if (fresh) chmodSync(file, 0o600);
}

const WHYS: readonly string[] = ["temp", "secure", "granted", "docs", "dsp", "shell"];

function isRecord(value: unknown): value is OutsideWriteRecord {
	if (!value || typeof value !== "object") return false;
	const r = value as Record<string, unknown>;
	return typeof r.ts === "string" && typeof r.tool === "string" && typeof r.path === "string" && typeof r.why === "string" && WHYS.includes(r.why) && (r.agent === undefined || typeof r.agent === "string");
}

/** Every well-formed record in the file, oldest first; a missing file is empty. */
export function readOutsideWrites(file: string): OutsideWriteRecord[] {
	let text: string;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		return [];
	}
	const records: OutsideWriteRecord[] = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			const parsed: unknown = JSON.parse(line);
			if (isRecord(parsed)) records.push(parsed);
		} catch {
			// A torn or foreign line is skipped.
		}
	}
	return records;
}

/** One line per path, most recently written first, with the latest reason and the number of writes. */
export function formatOutsideWrites(records: readonly OutsideWriteRecord[], limit = 50): string {
	if (records.length === 0) return "No writes outside the project recorded.";
	const byPath = new Map<string, { last: OutsideWriteRecord; count: number }>();
	for (const record of records) {
		const entry = byPath.get(record.path);
		byPath.set(record.path, { last: record, count: (entry?.count ?? 0) + 1 });
	}
	const rows = [...byPath.values()].sort((a, b) => b.last.ts.localeCompare(a.last.ts));
	const shown = rows.slice(0, limit);
	const lines = shown.map(({ last, count }) => `${last.ts}  ${last.why.padEnd(7)}  ${last.tool.padEnd(5)}  ${last.path}${last.agent ? `  [${last.agent}]` : ""}${count > 1 ? `  (${count} writes)` : ""}`);
	const more = rows.length > shown.length ? `\n… ${rows.length - shown.length} more` : "";
	return `Files written outside the project: ${rows.length} files\n${lines.join("\n")}${more}`;
}

export interface YoloDirStore {
	read: () => BrigadevSettings;
	write: (update: BrigadevSettings) => void;
}

const YOLO_DIR_USAGE = "Usage: /brigadev:yolo-dir list | add <folder> | remove <folder>";

/** `/brigadev:yolo-dir list|add|remove`: manages `secureYoloDirs` in brigadev.json and names the result. */
export function runYoloDirCommand(args: string, store: YoloDirStore, env: SecureDirGuard & { tempRoots: readonly string[] }): string {
	const trimmed = args.trim();
	const [sub = ""] = trimmed.split(/\s+/);
	const rest = trimmed.slice(sub.length).trim();
	const raw = store.read().secureYoloDirs;
	const configured = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
	const active = secureYoloDirs(configured, env);

	if (sub === "" || sub === "list") {
		const temp = env.tempRoots.map((root) => `  ${root}  (system temp, built in)`);
		const mine = active.map((root) => `  ${root}`);
		const dropped = configured.filter((entry) => !checkSecureDir(entry, env).ok).map((entry) => `  ${entry}  (ignored: ${(checkSecureDir(entry, env) as { reason: string }).reason})`);
		return `Secure-yolo folders (parent write/edit run there without asking; subagents stay blocked):\n${[...temp, ...mine, ...dropped].join("\n")}\n${YOLO_DIR_USAGE}`;
	}
	if (sub === "add") {
		const check = checkSecureDir(rest, env);
		if (!check.ok) return `brigadev: refused, ${check.reason}`;
		if (active.includes(check.path)) return `brigadev: ${check.path} is already a secure-yolo folder`;
		store.write({ secureYoloDirs: [...configured, check.path] });
		return `brigadev: added ${check.path}; write and edit there run without asking`;
	}
	if (sub === "remove") {
		const expanded = expandHome(rest);
		const target = rest === "" ? "" : canonicalPath(expanded);
		const kept = configured.filter((entry) => entry !== rest && canonicalPath(expandHome(entry)) !== target);
		if (rest === "" || kept.length === configured.length) return `brigadev: ${rest || "(none)"} is not a secure-yolo folder`;
		store.write({ secureYoloDirs: kept });
		return `brigadev: removed ${target}`;
	}
	return YOLO_DIR_USAGE;
}
