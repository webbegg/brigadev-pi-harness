/**
 * Pure detection of the pi-tidy extension and the compact-tools mode.
 *
 * Public data only: entries of Pi settings `packages`, names in the agent
 * dir `extensions/` folder, and the documented `tidy` / legacy `toolbox`
 * settings key. Never pi-tidy's private internals. No Pi imports.
 */

const TIDY = "pi-tidy";

function sourceOf(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (entry && typeof entry === "object" && typeof (entry as { source?: unknown }).source === "string") return (entry as { source: string }).source;
	return undefined;
}

/** True when a Pi `packages` entry (string or `{ source }`) points at the pi-tidy package. */
export function isTidyPackage(entry: unknown): boolean {
	const source = sourceOf(entry);
	if (!source) return false;
	let rest = source.trim().replace(/#.*$/, "").replace(/[\\/]+$/, "");
	const last = rest.split(/[\\/:]/).pop() ?? "";
	rest = last;
	const at = rest.indexOf("@", 1); // version or ref suffix; a leading @ is a scope
	if (at > 0) rest = rest.slice(0, at);
	rest = rest.replace(/\.git$/, "");
	return rest === TIDY;
}

/** pi-tidy reads `settings.tidy ?? settings.toolbox`; it is off only with `enabled: false`. */
export function tidyEnabled(settings: unknown): boolean {
	if (!settings || typeof settings !== "object") return true;
	const s = settings as { tidy?: unknown; toolbox?: unknown };
	const config = s.tidy ?? s.toolbox;
	if (!config || typeof config !== "object") return true;
	return (config as { enabled?: unknown }).enabled !== false;
}

export interface TidyInputs {
	/** `pi.getSettings().packages` (merged global + project). */
	packages?: readonly unknown[];
	/** Entry names of `<agentDir>/extensions`. */
	extensionEntries?: readonly string[];
	/** Parsed global Pi settings JSON, if readable. */
	piSettings?: unknown;
}

export function tidyInstalled(input: TidyInputs): boolean {
	if ((input.packages ?? []).some(isTidyPackage)) return true;
	return (input.extensionEntries ?? []).some((name) => name === TIDY || name === `${TIDY}.ts`);
}

export interface TidyOptions {
	/** True when brigadev ships a loadable copy of pi-tidy (a dependency that resolves). */
	bundled?: boolean;
}

/**
 * Which pi-tidy draws the transcript: `separate` (installed on its own, always wins), `bundled`
 * (brigadev's copy, only when nothing is installed separately) or `off` (not available, or
 * `tidy.enabled: false`). Pure: the answer depends only on the inputs, never on load order.
 */
export type TidyState = "separate" | "bundled" | "off";

export function tidyState(input: TidyInputs, options: TidyOptions = {}): TidyState {
	if (!tidyEnabled(input.piSettings)) return "off";
	if (tidyInstalled(input)) return "separate";
	return options.bundled ? "bundled" : "off";
}

/** Installed (separately, or bundled when `options.bundled`) and not disabled in its own config. */
export function tidyActive(input: TidyInputs, options: TidyOptions = {}): boolean {
	return tidyState(input, options) !== "off";
}

export type CompactToolsSetting = "auto" | boolean | undefined;

export function compactToolsMode(setting: CompactToolsSetting, tidyIsActive: boolean): { ours: boolean; reason: string } {
	if (setting === true) return { ours: true, reason: `ui.compactTools true${tidyIsActive ? "; pi-tidy active but overridden" : ""}` };
	if (setting === false) return { ours: false, reason: "ui.compactTools false" };
	return tidyIsActive
		? { ours: false, reason: "pi-tidy active; ui.compactTools auto" }
		: { ours: true, reason: "pi-tidy not active; ui.compactTools auto" };
}
