import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export function expandHome(path: string): string {
	return path === "~" ? homedir() : path.startsWith("~/") ? resolve(homedir(), path.slice(2)) : path;
}

/**
 * Absolute path with symlinks resolved, so one directory reached two ways
 * (macOS /tmp and /private/tmp, a symlinked checkout) compares equal. Paths
 * that do not exist yet resolve through their nearest existing parent.
 */
export function canonicalPath(path: string): string {
	let existing = resolve(path);
	const missing: string[] = [];
	while (true) {
		try {
			return join(realpathSync(existing), ...missing.reverse());
		} catch {
			const parent = dirname(existing);
			if (parent === existing) return resolve(path);
			missing.push(existing.slice(parent.length).replace(/^[/\\]/, ""));
			existing = parent;
		}
	}
}

export function isInside(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}
