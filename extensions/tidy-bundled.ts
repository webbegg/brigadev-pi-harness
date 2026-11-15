/**
 * Loads the pi-tidy that ships with brigadev (package dependency) unless pi-tidy is
 * installed separately or disabled. brigadev's own package.json lists this wrapper, never
 * pi-tidy's entry point, so pi-tidy loads at most once: a separate install always wins.
 *
 * The factory is async (extensions.md, "Writing an Extension" / "Async factory functions":
 * Pi awaits a returned Promise before startup continues), so pi-tidy is imported dynamically.
 * A missing or broken copy (a local checkout without node_modules) cannot take the extension
 * down: it degrades to one warning at the first session start with a UI, never a throw.
 * pi.getSettings() throws while an extension loads, so the settings are read from the files.
 */

import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { agentDir, isChildSession, readSettings } from "../lib/runtime.ts";
import { compactToolsMode, tidyState, type TidyInputs, type TidyState } from "../lib/tidy-detect.ts";

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

/** Same sources `pi.getSettings().packages` merges, read from disk because the API is unavailable at load. */
export function readTidyInputs(cwd: string = process.cwd(), dir: string = agentDir()): TidyInputs {
	let extensionEntries: string[] = [];
	try {
		extensionEntries = readdirSync(join(dir, "extensions"));
	} catch {}
	const piSettings = readJson(join(dir, "settings.json"));
	const projectSettings = readJson(join(cwd, ".pi", "settings.json"));
	return { packages: [...packagesOf(piSettings), ...packagesOf(projectSettings)], extensionEntries, piSettings };
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
		// "bundled" is the only state that loads: separate wins, and off (tidy.enabled false) means off.
		if (tidyState(inputs, { bundled: true }) !== "bundled") return;
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
