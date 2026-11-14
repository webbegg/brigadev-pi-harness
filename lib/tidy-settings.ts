/**
 * /brigadev:tidy support: add a tool to pi-tidy's `alwaysShowTools` in the Pi
 * global settings file, without disturbing anything else in it.
 *
 * pi-tidy reads `settings.tidy ?? settings.toolbox` (legacy), so the plan
 * writes into the key it reads and never shadows a legacy `toolbox` config.
 * The planner is pure; the file helpers use node:fs only.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

/** pi-tidy's own default for `alwaysShowTools`. */
export const TIDY_DEFAULT_ALWAYS_SHOW = ["edit", "write"];

export type TidyKey = "tidy" | "toolbox";

export type TidyPlan =
	| { kind: "refuse"; reason: string }
	| { kind: "noop"; key: TidyKey; current: string[] }
	| { kind: "write"; key: TidyKey; before: string[] | undefined; after: string[]; nextText: string };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function planAlwaysShow(rawText: string | undefined, tool = "subagent"): TidyPlan {
	let root: unknown = {};
	if (rawText !== undefined) {
		try {
			root = JSON.parse(rawText.charCodeAt(0) === 0xfeff ? rawText.slice(1) : rawText);
		} catch (error) {
			return { kind: "refuse", reason: `the file is not valid JSON (${(error as Error).message})` };
		}
	}
	if (!isObject(root)) return { kind: "refuse", reason: "the top level of the file is not a JSON object" };

	// Same precedence as pi-tidy: `tidy ?? toolbox`; create `tidy` when neither is set.
	const key: TidyKey = root.tidy != null ? "tidy" : root.toolbox != null ? "toolbox" : "tidy";
	const section = root[key] ?? {};
	if (!isObject(section)) return { kind: "refuse", reason: `"${key}" is not a JSON object` };

	const existing = section.alwaysShowTools;
	const before = Array.isArray(existing) ? (existing as string[]) : undefined;
	if (before?.includes(tool)) return { kind: "noop", key, current: before };

	const after = [...(before ?? TIDY_DEFAULT_ALWAYS_SHOW), tool];
	const next = { ...root, [key]: { ...section, alwaysShowTools: after } };
	return { kind: "write", key, before, after, nextText: `${JSON.stringify(next, null, 2)}\n` };
}

const list = (items: string[]) => `[${items.map((item) => JSON.stringify(item)).join(", ")}]`;

export function describePlan(plan: TidyPlan, path: string, tool = "subagent"): string {
	if (plan.kind === "refuse") return `Not changing ${path}: ${plan.reason}.`;
	if (plan.kind === "noop") return `No change: ${tool} is already in ${plan.key}.alwaysShowTools in ${path} (${list(plan.current)}).`;
	const note = plan.key === "toolbox" ? "\n(legacy \"toolbox\" key: it is the one pi-tidy reads, so no \"tidy\" key is added)" : "";
	return `File: ${path}\nKey:  ${plan.key}.alwaysShowTools\nChange: ${plan.before ? list(plan.before) : "(not set)"} → ${list(plan.after)}${note}`;
}

/** Plan together with the exact text it was computed from. */
export interface ShownPlan {
	raw: string | undefined;
	plan: TidyPlan;
}

export function readTidyPlan(path: string, tool = "subagent"): ShownPlan {
	let raw: string | undefined;
	try {
		raw = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			return { raw: undefined, plan: { kind: "refuse", reason: `the file cannot be read (${(error as Error).message})` } };
		}
	}
	return { raw, plan: planAlwaysShow(raw, tool) };
}

export type CommitResult = { ok: true } | { ok: false; reason: string };

/**
 * Writes a plan that was shown to the user. Re-reads and re-plans right before
 * writing and refuses if the file changed since, then writes via a temp file in
 * the same directory plus rename, keeping the original file mode. A symlinked
 * settings file is written through, not replaced.
 */
export function commitTidyPlan(path: string, shown: ShownPlan, tool = "subagent"): CommitResult {
	if (shown.plan.kind !== "write") return { ok: false, reason: shown.plan.kind === "refuse" ? shown.plan.reason : "nothing to change" };
	const now = readTidyPlan(path, tool);
	if (now.raw !== shown.raw || now.plan.kind !== "write" || now.plan.nextText !== shown.plan.nextText) {
		return { ok: false, reason: "the file changed since the change was shown; nothing was written, run the command again" };
	}
	let target = path;
	let mode: number | undefined;
	try {
		if (existsSync(path)) {
			target = realpathSync(path);
			mode = statSync(target).mode & 0o7777;
		}
		mkdirSync(dirname(target), { recursive: true });
	} catch (error) {
		return { ok: false, reason: `cannot prepare ${path} (${(error as Error).message})` };
	}
	const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now().toString(36)}.tmp`);
	try {
		writeFileSync(temp, now.plan.nextText, { encoding: "utf8", flag: "wx" });
		if (mode !== undefined) chmodSync(temp, mode);
		renameSync(temp, target);
		return { ok: true };
	} catch (error) {
		try {
			unlinkSync(temp);
		} catch {
			// temp file was never created or is already gone
		}
		return { ok: false, reason: `write failed (${(error as Error).message})` };
	}
}
