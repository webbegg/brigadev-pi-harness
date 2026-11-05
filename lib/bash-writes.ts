// Finds the files a shell command writes by their literal names. Best effort,
// like the command classifier: variables, substitutions, globs, and scripts
// run by an interpreter are not expanded or followed. Those writes are caught
// after the fact by the worktree snapshot comparison.

import { relative, resolve, sep } from "node:path";
import { basename, blankConditionals, blankHeredocs, SHELLS, tokenize, unwrap } from "./command-classifier.ts";
import { isWithinSurfaces } from "./edit-surfaces.ts";
import { canonicalPath, expandHome, isInside } from "./paths.ts";

// Words the shell treats as syntax in front of a command.
const LEADING_KEYWORDS = new Set(["then", "do", "else", "elif", "if", "while", "until", "!", "{"]);
const DEVICE_SINKS = /^\/dev\//;
// Anything the shell would expand before opening the file.
const UNRESOLVABLE = /[$`*?[\]{}]/;

interface OptionSpec {
	/** Short options that take a value (attached or as the next word). */
	valueShort?: string;
	/** Short options that take an attached value only (sed -i[SUFFIX]). */
	attachedShort?: string;
	/** Long options that take a value (`--name=value` or `--name value`). */
	valueLong?: readonly string[];
}

interface ParsedArgs {
	positionals: string[];
	/** Option name (without dashes) to its value, "" when it has none. */
	options: Map<string, string[]>;
}

function parseArgs(args: readonly string[], spec: OptionSpec = {}): ParsedArgs {
	const positionals: string[] = [];
	const options = new Map<string, string[]>();
	const add = (name: string, value: string) => options.set(name, [...(options.get(name) ?? []), value]);
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			positionals.push(...args.slice(i + 1));
			break;
		}
		if (arg.startsWith("--")) {
			const eq = arg.indexOf("=");
			const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
			if (eq !== -1) add(name, arg.slice(eq + 1));
			else if (spec.valueLong?.includes(name)) add(name, args[++i] ?? "");
			else add(name, "");
			continue;
		}
		if (arg.length > 1 && arg.startsWith("-")) {
			for (let j = 1; j < arg.length; j++) {
				const letter = arg[j];
				const rest = arg.slice(j + 1);
				if (spec.attachedShort?.includes(letter)) {
					add(letter, rest);
					break;
				}
				if (spec.valueShort?.includes(letter)) {
					add(letter, rest || (args[++i] ?? ""));
					break;
				}
				add(letter, "");
			}
			continue;
		}
		positionals.push(arg);
	}
	return { positionals, options };
}

const has = (parsed: ParsedArgs, ...names: string[]) => names.some((n) => parsed.options.has(n));

/** Raw (unresolved) file arguments the command writes. */
function commandTargets(name: string, args: string[]): string[] {
	switch (name) {
		case "tee":
			return parseArgs(args).positionals;
		case "touch":
			return parseArgs(args, { valueShort: "rtd", valueLong: ["reference", "date", "time"] }).positionals;
		case "mkdir":
			return parseArgs(args, { valueShort: "m", valueLong: ["mode", "context"] }).positionals;
		case "truncate":
			return parseArgs(args, { valueShort: "sr", valueLong: ["size", "reference"] }).positionals;
		case "sed": {
			const parsed = parseArgs(args, { valueShort: "efl", attachedShort: "i", valueLong: ["expression", "file", "line-length"] });
			if (!has(parsed, "i", "in-place")) return [];
			// The script is the first word unless -e/-f supplied it. BSD sed's `-i ''` leaves an empty word.
			const files = parsed.positionals.filter((p) => p !== "");
			return has(parsed, "e", "f", "expression", "file") ? files : files.slice(1);
		}
		case "cp":
		case "mv":
		case "install":
		case "ln": {
			const parsed = parseArgs(args, { valueShort: "tSmog", valueLong: ["target-directory", "suffix", "mode", "owner", "group"] });
			const dir = parsed.options.get("t") ?? parsed.options.get("target-directory");
			if (dir) return [dir[dir.length - 1]];
			return parsed.positionals.length >= 2 ? [parsed.positionals[parsed.positionals.length - 1]] : [];
		}
		default:
			return [];
	}
}

function isDescriptorDuplication(op: string, target: string): boolean {
	return op === ">&" && /^(\d+-?|-)$/.test(target);
}

/**
 * Absolute paths of the files the command writes by literal name, in order
 * of appearance. Relative names resolve against `cwd`, following literal
 * `cd` commands. Targets the shell would expand are skipped, as are
 * `/dev/*` sinks and descriptor duplication such as `2>&1`.
 */
export function extractWriteTargets(command: string, cwd: string): string[] {
	const found: string[] = [];
	let dir: string | undefined = cwd;

	const add = (raw: string) => {
		if (raw === "" || raw === "-" || UNRESOLVABLE.test(raw)) return;
		const expanded = expandHome(raw);
		if (DEVICE_SINKS.test(expanded)) return;
		if (!expanded.startsWith("/") && dir === undefined) return;
		const path = resolve(dir ?? "/", expanded);
		if (!found.includes(path)) found.push(path);
	};

	const walk = (text: string) => {
		// Directory to return to at each open `(`: a subshell's cd ends at its `)`.
		const scopes: Array<string | undefined> = [];
		// Open `case` statements, as the scope depth they started at: while one is
		// innermost, a `)` with no `(` to close ends a pattern, not a subshell.
		const cases: number[] = [];
		for (const segment of tokenize(blankConditionals(blankHeredocs(text)), { redirections: true })) {
			if (segment.before === "(") scopes.push(dir);
			else if (segment.before === ")" && scopes.length > 0 && cases[cases.length - 1] !== scopes.length) dir = scopes.pop();

			for (const redirect of segment.redirects) {
				if (!isDescriptorDuplication(redirect.op, redirect.target)) add(redirect.target);
			}

			let words = segment.argv;
			while (words.length > 0 && LEADING_KEYWORDS.has(words[0])) words = words.slice(1);
			const { argv } = unwrap(words);
			if (argv.length === 0) continue;
			if (words[0] === "case") cases.push(scopes.length);
			else if (words[0] === "esac") cases.pop();
			const name = basename(argv[0]);
			const args = argv.slice(1);

			if (name === "cd") {
				const target = args.find((a) => !a.startsWith("-"));
				dir = target !== undefined && target !== "-" && !UNRESOLVABLE.test(target) && dir !== undefined ? resolve(dir, expandHome(target)) : undefined;
			} else if (SHELLS.has(name) || name === "eval") {
				const scriptIndex = name === "eval" ? -1 : args.findIndex((a) => /^-[a-z]*c[a-z]*$/.test(a));
				const script = name === "eval" ? args.join(" ") : scriptIndex >= 0 ? args[scriptIndex + 1] : undefined;
				if (script) {
					// eval runs in this shell, so its cd carries on; a new shell's does not.
					const outer = dir;
					walk(script);
					if (name !== "eval") dir = outer;
				}
			} else {
				for (const raw of commandTargets(name, args)) add(raw);
			}
		}
	};

	walk(command);
	return found;
}

/**
 * Project-relative paths the command writes by literal name that are inside
 * `root` but outside `surfaces`. Targets outside the root are not judged here.
 */
export function writesOutsideSurfaces(command: string, cwd: string, root: string, surfaces: readonly string[]): string[] {
	const canonicalRoot = canonicalPath(root);
	const violations: string[] = [];
	for (const target of extractWriteTargets(command, cwd)) {
		const absolute = canonicalPath(target);
		if (!isInside(canonicalRoot, absolute)) continue;
		const rel = relative(canonicalRoot, absolute).split(sep).join("/");
		if (rel !== "" && !isWithinSurfaces(rel, surfaces) && !violations.includes(rel)) violations.push(rel);
	}
	return violations;
}
