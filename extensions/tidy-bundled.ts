/**
 * Loads the pi-tidy that ships with brigadev (package dependency) unless pi-tidy is
 * installed separately. With `tidy.enabled: false` it still runs pi-tidy, which then switches
 * its own patches off. brigadev's own package.json lists this wrapper, never
 * pi-tidy's entry point, so pi-tidy loads at most once: a separate install always wins.
 *
 * The factory is async (extensions.md, "Writing an Extension" / "Async factory functions":
 * Pi awaits a returned Promise before startup continues), so pi-tidy is imported dynamically.
 * A missing or broken copy (a local checkout without node_modules) cannot take the extension
 * down: it degrades to one warning at the first session start with a UI, never a throw.
 * pi.getSettings() throws while an extension loads, so the settings are read from the files.
 */

import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, isChildSession, PACKAGE_ROOT, readSettings } from "../lib/runtime.ts";
import { compactToolsMode, extensionsFromArgv, tidyInstalled, tidyState, type TidyInputs, type TidyState } from "../lib/tidy-detect.ts";

export interface TidyBundledDeps {
	isChild: () => boolean;
	/** Public data the detection uses: Pi `packages` (global + project), `extensions/` entries, global settings. */
	inputs: () => TidyInputs;
	/** Imports the bundled pi-tidy; rejects when it cannot be resolved. */
	load: () => Promise<{ default: (pi: ExtensionAPI) => unknown }>;
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}

function packagesOf(settings: unknown): unknown[] {
	const packages = settings && typeof settings === "object" ? (settings as { packages?: unknown }).packages : undefined;
	return Array.isArray(packages) ? packages : [];
}

function extensionsOf(settings: unknown): unknown[] {
	const extensions = settings && typeof settings === "object" ? (settings as { extensions?: unknown }).extensions : undefined;
	return Array.isArray(extensions) ? extensions : [];
}

function stripEntryFile(path: string): string {
	return path.replace(/[\\/]+src[\\/]index\.ts$/, "").replace(/[\\/]+$/, "");
}

/** Where brigadev's own copy of pi-tidy lives: inside this package, or hoisted where `pi-tidy` resolves from. */
export function bundledTidyRoots(): string[] {
	const roots = [join(PACKAGE_ROOT, "node_modules", "pi-tidy")];
	try {
		let dir = dirname(createRequire(import.meta.url).resolve("pi-tidy"));
		while (dirname(dir) !== dir && basename(dir) !== "pi-tidy") dir = dirname(dir);
		if (basename(dir) === "pi-tidy") roots.push(dir);
	} catch {}
	return roots;
}

function comparable(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

/** True for a path entry (relative to `base`) that is one of brigadev's own bundled pi-tidy roots. */
function isBundledEntry(entry: unknown, base: string, roots: readonly string[]): boolean {
	if (typeof entry !== "string") return false;
	const text = entry.trim();
	const expanded = text === "~" ? homedir() : text.startsWith("~/") ? join(homedir(), text.slice(2)) : text;
	const path = comparable(resolve(base, stripEntryFile(expanded)));
	return roots.some((root) => comparable(resolve(root)) === path);
}

export interface ReadTidyInputsOptions {
	/** CLI arguments to scan for `-e` / `--extension` (default: this process's). */
	argv?: readonly string[];
	/** brigadev's own pi-tidy roots, never counted as a separate install (default: `bundledTidyRoots()`). */
	bundledRoots?: readonly string[];
}

/**
 * Same sources `pi.getSettings().packages` merges, read from disk because the API is unavailable at load,
 * plus the settings `extensions` arrays (global + project) and `-e` / `--extension` CLI values.
 */
export function readTidyInputs(cwd: string = process.cwd(), dir: string = agentDir(), options: ReadTidyInputsOptions = {}): TidyInputs {
	let extensionEntries: string[] = [];
	try {
		extensionEntries = readdirSync(join(dir, "extensions"));
	} catch {}
	const piSettings = readJson(join(dir, "settings.json"));
	const projectSettings = readJson(join(cwd, ".pi", "settings.json"));
	const roots = options.bundledRoots ?? bundledTidyRoots();
	const own = (base: string) => (entry: unknown) => !isBundledEntry(entry, base, roots);
	const extensions = [
		...extensionsOf(piSettings).filter(own(dir)),
		...extensionsOf(projectSettings).filter(own(join(cwd, ".pi"))),
		...extensionsFromArgv(options.argv ?? process.argv.slice(2)).filter(own(cwd)),
	];
	return { packages: [...packagesOf(piSettings), ...packagesOf(projectSettings)], extensions, extensionEntries, piSettings };
}

/** True when brigadev's copy of pi-tidy resolves from this package (false for a checkout without node_modules). */
export function bundledTidyAvailable(): boolean {
	try {
		createRequire(import.meta.url).resolve("pi-tidy");
		return true;
	} catch {
		return false;
	}
}

/**
 * The effective pi-tidy state and the resulting compact-tools mode, from public data only. Used by
 * compact-tools and /brigadev:doctor so both agree with this wrapper without depending on which
 * extension loaded first. `packages` is `pi.getSettings().packages` when it is readable.
 */
export function resolveTidy(packages?: readonly unknown[]): { state: TidyState; ours: boolean; reason: string } {
	const inputs = readTidyInputs();
	const state = tidyState({ ...inputs, packages: packages ?? inputs.packages }, { bundled: bundledTidyAvailable() });
	return { state, ...compactToolsMode(readSettings().ui?.compactTools, state !== "off") };
}

const defaults: TidyBundledDeps = {
	isChild: () => isChildSession(),
	inputs: () => readTidyInputs(),
	load: () => import("pi-tidy"),
};

export function createTidyBundled(deps: TidyBundledDeps = defaults) {
	return async function (pi: ExtensionAPI): Promise<void> {
		if (deps.isChild()) return;
		let inputs: TidyInputs = {};
		try {
			inputs = deps.inputs();
		} catch {}
		// A separate install always wins. Otherwise run the bundled copy even with tidy.enabled false: pi-tidy
		// patches Pi's shared prototypes once per process and turns them off only by running again with
		// enabled false (it records that, registers nothing, and returns). tidyState still reports "off".
		if (tidyInstalled(inputs)) return;
		try {
			const mod = await deps.load();
			await mod.default(pi);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			let warned = false;
			pi.on("session_start", async (_event, ctx) => {
				if (warned || !ctx.hasUI) return;
				warned = true;
				ctx.ui.notify(`brigadev: the bundled pi-tidy could not be loaded (${reason}); transcript tidying is off. Run npm install in the brigadev package, or install pi-tidy separately.`, "warning");
			});
		}
	};
}

export default createTidyBundled();
