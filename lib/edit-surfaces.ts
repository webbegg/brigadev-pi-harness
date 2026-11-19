// Allowed edit surfaces: the repository-relative paths or globs a bounded
// writer may touch. The parent derives them; the guard enforces them.

const GLOB_CHARS = /[*?[\]{}]/;

/** Returns a list of problems; an empty list means the surfaces are valid. */
export function validateSurfaces(surfaces: readonly string[] | undefined): string[] {
	if (!surfaces || surfaces.length === 0) return ["allowedEditSurfaces must list at least one repository-relative path or glob"];
	const problems: string[] = [];
	for (const raw of surfaces) {
		const surface = raw.trim();
		if (!surface) problems.push("empty surface entry");
		else if (surface === "." || surface === "./" || surface === "*" || surface === "**" || surface === "**/*") problems.push(`"${raw}" covers the whole repository`);
		else if (surface.startsWith("/") || /^[A-Za-z]:[\\/]/.test(surface) || surface.startsWith("~")) problems.push(`"${raw}" must be repository-relative, not absolute`);
		else if (surface.split("/").includes("..")) problems.push(`"${raw}" must not escape the repository with ".."`);
	}
	return problems;
}

function normalize(path: string): string {
	return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Index of the `}` closing the `{` at `open` (nesting counted); -1 when there is none. */
function closingBrace(glob: string, open: number): number {
	let depth = 0;
	for (let i = open; i < glob.length; i++) {
		if (glob[i] === "{") depth++;
		else if (glob[i] === "}" && --depth === 0) return i;
	}
	return -1;
}

/** Splits `a,b{c,d}` at the commas outside nested braces. */
function splitAlternatives(body: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let start = 0;
	for (let i = 0; i < body.length; i++) {
		if (body[i] === "{") depth++;
		else if (body[i] === "}") depth--;
		else if (body[i] === "," && depth === 0) {
			parts.push(body.slice(start, i));
			start = i + 1;
		}
	}
	parts.push(body.slice(start));
	return parts;
}

/** `*` (within a segment), `**` (across segments), `?`, and `{a,b}` alternation; `ignoreCase` for case-insensitive matching. */
export function globToRegExp(glob: string, ignoreCase = false): RegExp {
	return new RegExp(`^${globSource(glob)}$`, ignoreCase ? "i" : "");
}

function globSource(glob: string): string {
	let source = "";
	for (let i = 0; i < glob.length; i++) {
		const ch = glob[i];
		if (ch === "{") {
			const close = closingBrace(glob, i);
			if (close !== -1) {
				source += `(?:${splitAlternatives(glob.slice(i + 1, close)).map(globSource).join("|")})`;
				i = close;
				continue;
			}
		}
		if (ch === "*") {
			if (glob[i + 1] === "*") {
				const slash = glob[i + 2] === "/";
				source += slash ? "(?:.*/)?" : ".*";
				i += slash ? 2 : 1;
			} else source += "[^/]*";
		} else if (ch === "?") source += "[^/]";
		else source += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
	}
	return source;
}

/** True when a repository-relative path is inside one of the surfaces. */
export function isWithinSurfaces(relativePath: string, surfaces: readonly string[]): boolean {
	const path = normalize(relativePath);
	return surfaces.some((raw) => {
		const surface = normalize(raw.trim());
		if (GLOB_CHARS.test(surface)) return globToRegExp(surface).test(path);
		// A plain entry matches the exact file or anything under that directory.
		return path === surface || path.startsWith(`${surface}/`);
	});
}

function staticSegments(surface: string): string[] {
	const segments = normalize(surface).split("/");
	const firstGlob = segments.findIndex((s) => GLOB_CHARS.test(s));
	return firstGlob === -1 ? segments : segments.slice(0, firstGlob);
}

function isSegmentPrefix(a: string[], b: string[]): boolean {
	return a.length <= b.length && a.every((s, i) => s === b[i]);
}

/**
 * Conservative overlap check: two surfaces overlap when the static part of
 * one is a path prefix of the other. It may report overlap for disjoint
 * globs in one directory (src/*.ts vs src/*.js); it never misses a real one.
 */
export function surfacesOverlap(a: readonly string[], b: readonly string[]): string | undefined {
	for (const left of a) {
		for (const right of b) {
			const l = staticSegments(left);
			const r = staticSegments(right);
			if (isSegmentPrefix(l, r) || isSegmentPrefix(r, l)) return `"${left}" overlaps "${right}"`;
		}
	}
	return undefined;
}
