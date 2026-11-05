// Working-tree snapshots: which files are dirty and what they contain, so two
// snapshots show exactly what a command changed, even in an already dirty
// file. Needs git; without it there is no snapshot and callers skip the check.

import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isWithinSurfaces } from "./edit-surfaces.ts";
import { canonicalPath } from "./paths.ts";

/** Project-relative path (forward slashes) to a content marker; "-" means the path does not exist. */
export type Snapshot = ReadonlyMap<string, string>;

export type ExecFn = (command: string, args: string[], options: { cwd: string; timeout: number }) => Promise<{ stdout: string; stderr: string; code: number }>;

const GIT_TIMEOUT_MS = 15_000;
// Beyond this size a file is marked by size and mtime instead of being read.
const MAX_HASHED_BYTES = 64 * 1024 * 1024;
const MISSING = "-";

/** Paths from `git status --porcelain=v1 -z`; a rename or copy lists its original path too. */
export function parsePorcelain(output: string): string[] {
	const fields = output.split("\0");
	const paths: string[] = [];
	for (let i = 0; i < fields.length; i++) {
		const field = fields[i];
		if (field.length < 4) continue;
		paths.push(field.slice(3));
		if (/[RC]/.test(field.slice(0, 2)) && fields[i + 1]) paths.push(fields[++i]);
	}
	return paths;
}

/** Sorted paths whose marker differs between the snapshots, including paths that appear or disappear. */
export function diffSnapshots(before: Snapshot, after: Snapshot): string[] {
	const changed: string[] = [];
	for (const path of new Set([...before.keys(), ...after.keys()])) {
		if ((before.get(path) ?? MISSING) !== (after.get(path) ?? MISSING) || before.has(path) !== after.has(path)) changed.push(path);
	}
	return changed.sort();
}

export function outsideSurfaces(paths: readonly string[], surfaces: readonly string[]): string[] {
	return paths.filter((path) => !isWithinSurfaces(path, surfaces));
}

function contentMarker(absolute: string): string {
	try {
		const stat = lstatSync(absolute);
		if (stat.isSymbolicLink()) return `link:${readlinkSync(absolute)}`;
		if (stat.isDirectory()) return "dir";
		if (stat.size > MAX_HASHED_BYTES) return `big:${stat.size}:${stat.mtimeMs}`;
		return createHash("sha1").update(readFileSync(absolute)).digest("hex");
	} catch {
		return MISSING;
	}
}

/**
 * Snapshot of the dirty files under `root`: undefined when git is missing,
 * `root` is not in a repository, or git fails.
 */
export async function takeSnapshot(exec: ExecFn, root: string): Promise<Snapshot | undefined> {
	try {
		const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: root, timeout: GIT_TIMEOUT_MS });
		if (top.code !== 0 || !top.stdout.trim()) return undefined;
		const status = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], { cwd: root, timeout: GIT_TIMEOUT_MS });
		if (status.code !== 0) return undefined;

		const toplevel = canonicalPath(top.stdout.trim());
		const projectRoot = canonicalPath(root);
		const snapshot = new Map<string, string>();
		for (const path of parsePorcelain(status.stdout)) {
			const absolute = join(toplevel, path);
			snapshot.set(relative(projectRoot, absolute).split(sep).join("/"), contentMarker(absolute));
		}
		return snapshot;
	} catch {
		return undefined;
	}
}
