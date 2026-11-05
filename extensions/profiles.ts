/**
 * brigadev profiles: named model routing presets. Each profile maps the
 * orchestrator and every agent (or a "review-*" style glob, or "*") to a
 * model and thinking level. One profile is the default; a session can bind
 * another without touching shared files.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_KEY,
	isThinkingLevel,
	ORCHESTRATOR_KEY,
	parseProfilesFile,
	resolveAgentRoute,
	routeFor,
	resolveModelRef,
	THINKING_LEVELS,
	unmatchedKeys,
	validateProfileName,
	withFallbacks,
	withRoute,
	type Profile,
	type ProfilesFile,
	type RouteEntry,
} from "../lib/model-routing.ts";
import { currentModelRef, loadAgents, modelCatalog } from "../lib/pi-adapters.ts";
import { effectiveProfile, PROFILE_ENTRY, profilesPath, readProfiles, writePiDefaultModel, writeProfiles } from "../lib/profiles-store.ts";
import { ASSETS_ROOT, isChildSession } from "../lib/runtime.ts";

const STATUS_KEY = "brigadev-profile";
const SUBCOMMANDS = ["show", "list", "use", "default", "clear", "set", "fallback", "new", "delete", "init", "path"] as const;
const USAGE = [
	"/brigadev:profile                 show the effective routing",
	"/brigadev:profile list            list profiles (◉ session, ★ default)",
	"/brigadev:profile use <name>      use a profile in this session only",
	"/brigadev:profile default <name>  make it the default (also sets Pi's default model)",
	"/brigadev:profile clear           drop this session's profile",
	"/brigadev:profile set <profile> <agent|review-*|*|orchestrator> <model|inherit> [thinking|inherit]",
	"/brigadev:profile fallback <profile> <agent|review-*|*|orchestrator> <model> [thinking]   (add; \"clear\" instead of a model removes the chain)",
	"/brigadev:profile new <name> [copy-from]   /brigadev:profile delete <name>",
	"/brigadev:profile init            add the example profiles (economy, balanced, deep)",
].join("\n");

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;

	const effective = (ctx: ExtensionContext) => {
		const { file, problems } = readProfiles();
		return { file, problems, eff: effectiveProfile(file, ctx.sessionManager.getBranch()) };
	};

	const publishStatus = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const { eff } = effective(ctx);
		ctx.ui.setStatus(STATUS_KEY, eff.name ? `profile: ${eff.name}${eff.source === "session" ? " (session)" : ""}` : undefined);
	};

	/** Moves the live orchestrator to the profile's model and thinking level. */
	const applyOrchestrator = async (ctx: ExtensionContext, profile: Profile): Promise<string> => {
		const route = profile[ORCHESTRATOR_KEY];
		if (!route) return "orchestrator unchanged (the profile has no orchestrator route)";
		const notes: string[] = [];
		if (route.model) {
			const resolved = resolveModelRef(route.model, modelCatalog(ctx), ctx.model?.provider);
			if ("error" in resolved) return `orchestrator unchanged: ${resolved.error}`;
			const model = ctx.modelRegistry.find(resolved.model.provider, resolved.model.id);
			if (!model || !(await pi.setModel(model))) return `orchestrator unchanged: no authentication for ${route.model}`;
			notes.push(`${resolved.model.provider}/${resolved.model.id}`);
		}
		if (route.thinking) {
			pi.setThinkingLevel(route.thinking);
			notes.push(`thinking ${pi.getThinkingLevel()}`);
		}
		return `orchestrator → ${notes.join(" · ")}`;
	};

	const save = (ctx: ExtensionContext, file: ProfilesFile, message: string) => {
		writeProfiles(file);
		publishStatus(ctx);
		ctx.ui.notify(message, "info");
	};

	const requireProfile = (ctx: ExtensionContext, file: ProfilesFile, name: string | undefined): name is string => {
		if (name && file.profiles[name]) return true;
		ctx.ui.notify(name ? `No profile "${name}". Profiles: ${Object.keys(file.profiles).join(", ") || "none (run /brigadev:profile init)"}` : USAGE, "error");
		return false;
	};

	const describeRouting = (ctx: ExtensionContext): string => {
		const { file, problems, eff } = effective(ctx);
		const agents = loadAgents(ctx);
		const lines: string[] = [];
		const header = eff.name ? `Profile: ${eff.name} (${eff.source})` : "Profile: none — agents use their definition or the session model";
		lines.push(header);
		if (eff.missing) lines.push(`⚠ this session's profile "${eff.missing}" no longer exists`);
		const orch = eff.profile?.[ORCHESTRATOR_KEY];
		const chain = (key: string | undefined) => {
			const steps = key ? eff.profile?.[key]?.fallbacks : undefined;
			return steps?.length ? `  ↪ ${steps.map((f) => f.model.split("/").pop()).join(" → ")}` : "";
		};
		lines.push(`orchestrator        ${currentModelRef(ctx) ?? "?"} · ${ctx.thinkingLevel ?? "?"}  (live)${orch?.model ? `  profile wants ${orch.model}${orch.thinking ? ` · ${orch.thinking}` : ""}` : ""}${chain(ORCHESTRATOR_KEY)}`);
		const width = Math.max(18, ...agents.map((a) => a.name.length));
		for (const agent of agents) {
			const r = resolveAgentRoute({ profile: eff.profile, agent, parent: { model: currentModelRef(ctx), thinking: ctx.thinkingLevel } });
			const source = r.profileKey ? `profile:${r.profileKey}` : r.modelSource;
			lines.push(`${agent.name.padEnd(width)}  ${r.model ?? "?"} · ${r.thinking ?? "default"}  (${source})${chain(routeFor(eff.profile, agent.name)?.key)}`);
		}
		const unknown = eff.profile ? unmatchedKeys(eff.profile, agents.map((a) => a.name)) : [];
		if (unknown.length) lines.push(`⚠ routing keys that match no agent (ignored): ${unknown.join(", ")}`);
		for (const p of problems) lines.push(`⚠ ${p}`);
		lines.push(`file: ${profilesPath()}`);
		return lines.join("\n");
	};

	const parseRoute = (ctx: ExtensionContext, modelArg: string | undefined, thinkingArg: string | undefined): RouteEntry | string => {
		const entry: RouteEntry = {};
		if (!modelArg) return "missing <model|inherit>";
		if (modelArg === "inherit" || modelArg === "-") entry.model = undefined;
		else {
			const resolved = resolveModelRef(modelArg, modelCatalog(ctx), ctx.model?.provider);
			if ("error" in resolved) return resolved.error;
			entry.model = `${resolved.model.provider}/${resolved.model.id}`;
		}
		if (thinkingArg === "inherit" || thinkingArg === "-") entry.thinking = undefined;
		else if (thinkingArg !== undefined) {
			if (!isThinkingLevel(thinkingArg)) return `thinking must be one of ${THINKING_LEVELS.join(", ")} or inherit`;
			entry.thinking = thinkingArg;
		}
		return entry;
	};

	pi.on("session_start", async (_event, ctx) => publishStatus(ctx));
	pi.on("session_tree", async (_event, ctx) => publishStatus(ctx));

	pi.registerCommand("brigadev:profile", {
		description: "Model routing profiles: show | list | use | default | clear | set | new | delete | init",
		getArgumentCompletions: (prefix) => {
			const parts = prefix.split(/\s+/);
			if (parts.length <= 1) {
				const items = SUBCOMMANDS.filter((s) => s.startsWith(parts[0] ?? "")).map((value) => ({ value, label: value }));
				return items.length ? items : null;
			}
			if (parts.length === 2 && ["use", "default", "delete", "set", "fallback", "new"].includes(parts[0])) {
				const names = Object.keys(readProfiles().file.profiles).filter((n) => n.startsWith(parts[1]));
				return names.length ? names.map((n) => ({ value: `${parts[0]} ${n}`, label: n })) : null;
			}
			return null;
		},
		handler: async (args, ctx) => {
			const [sub = "show", a, b, c, d] = args.trim().split(/\s+/).filter(Boolean);
			const { file, eff } = effective(ctx);
			try {
				switch (sub) {
					case "show":
						return ctx.ui.notify(describeRouting(ctx), "info");
					case "list": {
						const names = Object.keys(file.profiles);
						if (!names.length) return ctx.ui.notify("No profiles yet. Run /brigadev:profile init", "info");
						return ctx.ui.notify(names.map((n) => `${n === eff.name && eff.source === "session" ? "◉" : " "}${n === file.active ? "★" : " "} ${n}`).join("\n"), "info");
					}
					case "use": {
						let name = a;
						if (!name && ctx.hasUI) name = await ctx.ui.select("Use profile in this session", Object.keys(file.profiles));
						if (!requireProfile(ctx, file, name)) return;
						pi.appendEntry(PROFILE_ENTRY, { name });
						publishStatus(ctx);
						return ctx.ui.notify(`Session profile: ${name}. Subagents use its routing; ${await applyOrchestrator(ctx, file.profiles[name])}`, "info");
					}
					case "default": {
						if (!requireProfile(ctx, file, a)) return;
						const notes = [`Default profile: ${a}`];
						const orch = file.profiles[a][ORCHESTRATOR_KEY];
						if (orch?.model) {
							const resolved = resolveModelRef(orch.model, modelCatalog(ctx), ctx.model?.provider);
							if ("error" in resolved) notes.push(`Pi default model unchanged: ${resolved.error}`);
							else notes.push(`Pi default model → ${resolved.model.provider}/${resolved.model.id} (${writePiDefaultModel(resolved.model.provider, resolved.model.id, orch.thinking)})`);
						}
						writeProfiles({ ...file, active: a });
						pi.appendEntry(PROFILE_ENTRY, { name: a });
						notes.push(await applyOrchestrator(ctx, file.profiles[a]));
						publishStatus(ctx);
						return ctx.ui.notify(notes.join("\n"), "info");
					}
					case "clear":
						pi.appendEntry(PROFILE_ENTRY, { name: null });
						publishStatus(ctx);
						return ctx.ui.notify(file.active ? `Session profile cleared; using the default "${file.active}". The orchestrator model is unchanged.` : "Session profile cleared.", "info");
					case "set": {
						if (!requireProfile(ctx, file, a)) return;
						if (!b) return ctx.ui.notify(USAGE, "error");
						const route = parseRoute(ctx, c, d);
						if (typeof route === "string") return ctx.ui.notify(route, "error");
						const next = withRoute(file, a, b, route);
						const unknown = b === DEFAULT_KEY || b === ORCHESTRATOR_KEY ? [] : unmatchedKeys({ [b]: {} }, loadAgents(ctx).map((x) => x.name));
						const shown = next.profiles[a][b];
						return save(ctx, next, `${a}: ${b} → ${shown ? `${shown.model ?? "inherit"} · ${shown.thinking ?? "inherit"}` : "inherit"}${unknown.length ? `\n⚠ "${b}" matches no current agent` : ""}`);
					}
					case "fallback": {
						if (!requireProfile(ctx, file, a)) return;
						if (!b || !c) return ctx.ui.notify(USAGE, "error");
						const current = file.profiles[a][b]?.fallbacks ?? [];
						if (c === "clear") return save(ctx, withFallbacks(file, a, b, []), `${a}: ${b} has no fallback chain now`);
						const resolved = resolveModelRef(c, modelCatalog(ctx), ctx.model?.provider);
						if ("error" in resolved) return ctx.ui.notify(resolved.error, "error");
						if (d !== undefined && !isThinkingLevel(d)) return ctx.ui.notify(`thinking must be one of ${THINKING_LEVELS.join(", ")}`, "error");
						const step = { model: `${resolved.model.provider}/${resolved.model.id}`, ...(d ? { thinking: d } : {}) };
						const next = withFallbacks(file, a, b, [...current.filter((f) => f.model !== step.model), step]);
						return save(ctx, next, `${a}: ${b} falls back to ${next.profiles[a][b].fallbacks!.map((f) => f.model).join(" → ")}`);
					}
					case "new": {
						const problem = a ? validateProfileName(a) : USAGE;
						if (problem) return ctx.ui.notify(problem, "error");
						if (file.profiles[a!]) return ctx.ui.notify(`Profile "${a}" already exists`, "error");
						if (b && !requireProfile(ctx, file, b)) return;
						const next = structuredClone(file);
						next.profiles[a!] = b ? structuredClone(file.profiles[b]) : {};
						return save(ctx, next, `Created profile "${a}"${b ? ` from "${b}"` : ""}. Edit it with /brigadev:profile set ${a} …`);
					}
					case "delete": {
						if (!requireProfile(ctx, file, a)) return;
						if (file.active === a) return ctx.ui.notify(`"${a}" is the default profile; make another one default first`, "error");
						const next = structuredClone(file);
						delete next.profiles[a];
						return save(ctx, next, `Deleted profile "${a}"`);
					}
					case "init": {
						const example = parseProfilesFile(JSON.parse(readFileSync(join(ASSETS_ROOT, "profiles.example.json"), "utf8"))).file;
						const catalog = modelCatalog(ctx);
						const next = structuredClone(file);
						const added: string[] = [];
						const dropped: string[] = [];
						for (const [name, profile] of Object.entries(example.profiles)) {
							if (next.profiles[name]) continue;
							const resolved: Profile = {};
							for (const [key, route] of Object.entries(profile)) {
								const next = { ...route };
								if (route.model) {
									const ref = resolveModelRef(route.model, catalog, ctx.model?.provider);
									if ("error" in ref) {
										dropped.push(`${name}.${key}: ${ref.error}`);
										continue;
									}
									next.model = `${ref.model.provider}/${ref.model.id}`;
								}
								if (route.fallbacks) {
									next.fallbacks = route.fallbacks.flatMap((f) => {
										const ref = resolveModelRef(f.model, catalog, ctx.model?.provider);
										if ("error" in ref) {
											dropped.push(`${name}.${key} fallback: ${ref.error}`);
											return [];
										}
										return [{ ...f, model: `${ref.model.provider}/${ref.model.id}` }];
									});
								}
								resolved[key] = next;
							}
							next.profiles[name] = resolved;
							added.push(name);
						}
						if (!next.active && example.active && next.profiles[example.active]) next.active = example.active;
						if (!added.length) return ctx.ui.notify("All example profiles already exist.", "info");
						return save(ctx, next, [`Added profiles: ${added.join(", ")} (default: ${next.active ?? "none"})`, ...dropped.map((x) => `⚠ skipped ${x}`), "Review with /brigadev:profile"].join("\n"));
					}
					case "path":
						return ctx.ui.notify(profilesPath(), "info");
					default:
						return ctx.ui.notify(USAGE, "error");
				}
			} catch (error) {
				ctx.ui.notify(`brigadev:profile failed: ${(error as Error).message}`, "error");
			}
		},
	});
}
