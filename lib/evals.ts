// Agent evals: one case per folder, `evals/<agent>/<case>/case.json`, run by scripts/eval.ts.
// A case is a task for one agent, an optional fixture (copied to a temp dir as the agent's cwd),
// and assertions on the agent's structured result and on the files it left behind.
// Pure loading, validation, and matching: no model calls, so every rule here has a unit test.

import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";

export type PathAssertion = { path: string } & ({ equals: unknown } | { matches: string } | { minItems: number } | { exists: true });
export type FileAssertion = { file: string } & ({ exists: true } | { contains: string });
export type Assertion = PathAssertion | FileAssertion;

export interface EvalCaseSpec {
	task: string;
	reason?: string;
	/** A directory under the case folder, copied to a temp dir as the agent's cwd. */
	fixture?: string;
	allowedEditSurfaces?: string[];
	expect: Assertion[];
}

export interface EvalCase extends Omit<EvalCaseSpec, "fixture"> {
	agent: string;
	name: string;
	dir: string;
	/** Absolute path of the fixture directory, when the case has one. */
	fixture?: string;
}

export interface AssertionResult {
	assertion: Assertion;
	pass: boolean;
	reason: string;
}

const CASE_FIELDS = new Set(["task", "reason", "fixture", "allowedEditSurfaces", "expect"]);
const PATH_CHECKS = ["equals", "matches", "minItems", "exists"] as const;
const FILE_CHECKS = ["exists", "contains"] as const;
/** `$`, then `.name`, `[n]`, or `[*]` segments. */
const PATH = /^\$(?:\.[A-Za-z_$][\w$-]*|\[(?:\d+|\*)\])*$/;
const SEGMENT = /\.([A-Za-z_$][\w$-]*)|\[(\d+|\*)\]/g;

const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/** A relative path that stays inside its base: no absolute path, no `..` segment. */
const insideRelative = (p: string): boolean => p.trim() !== "" && !isAbsolute(p) && !p.split(/[\\/]/).includes("..");

function assertionErrors(raw: unknown, at: string): string[] {
	if (!isObject(raw) || (typeof raw.path !== "string" && typeof raw.file !== "string")) return [`${at}: needs path or file`];
	const errors: string[] = [];
	const isPath = typeof raw.path === "string";
	const checks: readonly string[] = isPath ? PATH_CHECKS : FILE_CHECKS;
	const present = checks.filter((k) => k in raw);
	for (const key of Object.keys(raw)) if (key !== (isPath ? "path" : "file") && !checks.includes(key)) errors.push(`${at}: unknown field ${key}`);
	if (present.length !== 1) return [...errors, `${at}: a ${isPath ? "path" : "file"} assertion needs exactly one of ${checks.join(", ")}`];
	if (isPath && !PATH.test(raw.path as string)) errors.push(`${at}.path: invalid path ${raw.path} (use $, .name, [n], [*])`);
	if (!isPath) {
		const file = raw.file as string;
		if (file.startsWith("$") ? !PATH.test(file) : !insideRelative(file)) errors.push(`${at}.file: must be a relative path inside the fixture, or a $ path of the result`);
	}
	const check = present[0];
	if (check === "exists" && raw.exists !== true) errors.push(`${at}.exists: must be true`);
	if (check === "contains" && typeof raw.contains !== "string") errors.push(`${at}.contains: must be a string`);
	if (check === "minItems" && !(Number.isInteger(raw.minItems) && (raw.minItems as number) >= 0)) errors.push(`${at}.minItems: must be a non-negative integer`);
	if (check === "matches") {
		try {
			if (typeof raw.matches !== "string") throw new Error();
			new RegExp(raw.matches);
		} catch {
			errors.push(`${at}.matches: invalid regex ${String(raw.matches)}`);
		}
	}
	return errors;
}

/** Validates the shape of a parsed case.json; every problem is named with its field. */
export function parseCase(raw: unknown): { ok: true; spec: EvalCaseSpec } | { ok: false; errors: string[] } {
	if (!isObject(raw)) return { ok: false, errors: ["case.json must be a JSON object"] };
	const errors = Object.keys(raw)
		.filter((key) => !CASE_FIELDS.has(key))
		.map((key) => `unknown field: ${key}`);
	if (typeof raw.task !== "string" || !raw.task.trim()) errors.push("task: required, a non-empty string");
	if (raw.reason !== undefined && typeof raw.reason !== "string") errors.push("reason: must be a string");
	if (raw.fixture !== undefined && !(typeof raw.fixture === "string" && insideRelative(raw.fixture))) errors.push("fixture: must be a relative directory inside the case");
	if (raw.allowedEditSurfaces !== undefined && !(Array.isArray(raw.allowedEditSurfaces) && raw.allowedEditSurfaces.every((s) => typeof s === "string"))) errors.push("allowedEditSurfaces: must be an array of strings");
	if (!Array.isArray(raw.expect) || raw.expect.length === 0) errors.push("expect: required, a non-empty array of assertions");
	else raw.expect.forEach((assertion, i) => errors.push(...assertionErrors(assertion, `expect[${i}]`)));
	return errors.length ? { ok: false, errors } : { ok: true, spec: raw as unknown as EvalCaseSpec };
}

const subdirs = (dir: string): string[] =>
	readdirSync(dir, { withFileTypes: true })
		.filter((d) => d.isDirectory())
		.map((d) => d.name)
		.sort();

/** Every case under `evalsDir` (one agent's with `agent`), sorted by agent then case; a bad case is an error line, not a throw. */
export function loadCases(evalsDir: string, agent?: string): { cases: EvalCase[]; errors: string[] } {
	if (!existsSync(evalsDir)) return { cases: [], errors: [`no evals folder at ${evalsDir}`] };
	const cases: EvalCase[] = [];
	const errors: string[] = [];
	for (const agentName of subdirs(evalsDir)) {
		if (agent !== undefined && agentName !== agent) continue;
		for (const name of subdirs(join(evalsDir, agentName))) {
			const dir = join(evalsDir, agentName, name);
			const label = `${agentName}/${name}`;
			const file = join(dir, "case.json");
			if (!existsSync(file)) {
				errors.push(`${label}: missing case.json`);
				continue;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(readFileSync(file, "utf8"));
			} catch (err) {
				errors.push(`${label}: case.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`);
				continue;
			}
			const parsed = parseCase(raw);
			if (!parsed.ok) {
				errors.push(...parsed.errors.map((e) => `${label}: ${e}`));
				continue;
			}
			const fixture = parsed.spec.fixture === undefined ? undefined : join(dir, parsed.spec.fixture);
			const problem = fixture === undefined ? undefined : fixtureProblem(dir, fixture, parsed.spec.fixture!);
			if (problem) {
				errors.push(`${label}: fixture: ${problem}`);
				continue;
			}
			cases.push({ ...parsed.spec, agent: agentName, name, dir, fixture });
		}
	}
	return { cases, errors };
}

/**
 * Why a case's fixture cannot be copied as the agent's cwd, or undefined. It must be a real folder strictly inside the case
 * folder: `.` would hand the agent the case's own `expect`, and a symlink or `..` would copy (and let the agent write into)
 * a folder outside the case.
 */
function fixtureProblem(caseDir: string, fixture: string, declared: string): string | undefined {
	const rel = relative(caseDir, fixture);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return "must be a folder inside the case folder";
	if (!existsSync(fixture) && !lstatOrUndefined(fixture)) return `no such directory ${declared}`;
	if (lstatOrUndefined(fixture)?.isSymbolicLink()) return "must not be a symlink";
	return statSync(fixture).isDirectory() ? undefined : `no such directory ${declared}`;
}

function lstatOrUndefined(path: string): ReturnType<typeof lstatSync> | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/** The values a path selects (`[*]` fans out over an array); empty when nothing is there. */
export function selectPath(value: unknown, path: string): unknown[] {
	let current: unknown[] = [value];
	for (const [, key, index] of path.slice(1).matchAll(SEGMENT)) {
		const next: unknown[] = [];
		for (const v of current) {
			if (key !== undefined) {
				// Own keys only: `$.constructor` or `$.__proto__` must not find something every object inherits.
				if (isObject(v) && Object.hasOwn(v, key)) next.push(v[key]);
			} else if (Array.isArray(v)) {
				if (index === "*") next.push(...v);
				else if (Number(index) < v.length) next.push(v[Number(index)]);
			}
		}
		current = next;
	}
	return current;
}

const show = (values: unknown[]): string => (values.length === 1 ? JSON.stringify(values[0]) : `[${values.map((v) => JSON.stringify(v)).join(", ")}]`);

/** A path assertion passes when any selected value satisfies it (so `[*]` reads "some item"). */
function checkPath(a: PathAssertion, result: unknown): { pass: boolean; reason: string } {
	if (result === undefined) return { pass: false, reason: "no structured result" };
	const values = selectPath(result, a.path);
	if (values.length === 0) return { pass: false, reason: `${a.path}: not found` };
	if ("exists" in a) return { pass: true, reason: `${a.path} exists` };
	if ("equals" in a) return values.some((v) => isDeepStrictEqual(v, a.equals)) ? { pass: true, reason: `${a.path} equals ${JSON.stringify(a.equals)}` } : { pass: false, reason: `${a.path} is ${show(values)}, expected ${JSON.stringify(a.equals)}` };
	if ("matches" in a) {
		const re = new RegExp(a.matches);
		return values.some((v) => typeof v === "string" && re.test(v)) ? { pass: true, reason: `${a.path} matches /${a.matches}/` } : { pass: false, reason: `${a.path} is ${show(values)}, expected to match /${a.matches}/` };
	}
	const arrays = values.filter(Array.isArray);
	if (arrays.length === 0) return { pass: false, reason: `${a.path} is not an array` };
	const most = Math.max(...arrays.map((v) => v.length));
	return most >= a.minItems ? { pass: true, reason: `${a.path} has ${most} items` } : { pass: false, reason: `${a.path} has ${most} items, expected at least ${a.minItems}` };
}

/** A file in the run's directory: a literal relative path, or a `$` path whose one value is that path (`$.testPath`). */
function checkFile(a: FileAssertion, result: unknown, dir: string): { pass: boolean; reason: string } {
	let file = a.file;
	if (file.startsWith("$")) {
		const values = result === undefined ? [] : selectPath(result, file);
		if (values.length !== 1 || typeof values[0] !== "string" || !values[0]) return { pass: false, reason: `${a.file}: not a single string` };
		file = values[0];
	}
	const target = resolve(dir, file);
	const rel = relative(resolve(dir), target);
	if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { pass: false, reason: `${file}: outside the run's directory` };
	if (!existsSync(target)) return { pass: false, reason: `${file}: not found` };
	if ("exists" in a) return { pass: true, reason: `${file} exists` };
	let text: string;
	try {
		text = readFileSync(target, "utf8");
	} catch (err) {
		return { pass: false, reason: `${file}: unreadable (${err instanceof Error ? err.message : String(err)})` };
	}
	return text.includes(a.contains) ? { pass: true, reason: `${file} contains ${JSON.stringify(a.contains)}` } : { pass: false, reason: `${file} does not contain ${JSON.stringify(a.contains)}` };
}

/** Every assertion against the structured result (undefined when the run returned none) and the run's directory. */
export function evaluate(expect: readonly Assertion[], result: unknown, dir: string): AssertionResult[] {
	return expect.map((assertion) => ({ assertion, ...("path" in assertion ? checkPath(assertion, result) : checkFile(assertion, result, dir)) }));
}

/** `npm run eval -- [agent] [--model provider/id]`. */
export function parseEvalArgs(argv: readonly string[]): { ok: true; args: { agent?: string; model?: string } } | { ok: false; error: string } {
	const args: { agent?: string; model?: string } = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--model" || arg.startsWith("--model=")) {
			const value = arg === "--model" ? argv[++i] : arg.slice("--model=".length);
			if (!value || value.startsWith("-")) return { ok: false, error: "--model needs provider/id" };
			args.model = value;
		} else if (arg.startsWith("-")) return { ok: false, error: `unknown option ${arg}` };
		else if (args.agent === undefined) args.agent = arg;
		else return { ok: false, error: `unexpected argument ${arg}` };
	}
	return { ok: true, args };
}

/**
 * Flat `key: value` frontmatter (strings, quoted strings, true/false), as the package agents write it.
 * The eval runner reads package agents without the Pi runtime, whose YAML parser is a peer dependency.
 */
export function parseFlatFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
	if (!match) return { frontmatter: {}, body: content };
	const frontmatter: Record<string, unknown> = {};
	for (const line of match[1].split(/\r?\n/)) {
		const at = line.indexOf(":");
		if (at <= 0) continue;
		const raw = line.slice(at + 1).trim();
		frontmatter[line.slice(0, at).trim()] = raw === "true" ? true : raw === "false" ? false : raw.replace(/^(["'])(.*)\1$/, "$2");
	}
	return { frontmatter, body: match[2] };
}
