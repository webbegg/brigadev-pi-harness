// TEST-ONLY module loader. extensions/subagents.ts imports Pi runtime packages that are peer dependencies and not
// installed in this repo (`@earendil-works/pi-coding-agent`, `-pi-tui`, `-pi-ai`, `-pi-agent-core`, and `typebox`).
// `installPiStubs()` registers a synchronous resolve hook (`module.registerHooks`, Node >= 22.15, package engines
// say >= 22.19) that answers those specifiers with the small stubs in ./pi-stubs. Only modules imported AFTER the call
// are affected, so a test installs the hooks first and then loads the extension with a dynamic `import()`.
// Nothing here is part of the package (tests/ is not published).

import { registerHooks } from "node:module";

const stub = (file: string): string => new URL(`./pi-stubs/${file}`, import.meta.url).href;

const STUBS = new Map<string, string>([
	["@earendil-works/pi-coding-agent", stub("pi-coding-agent.ts")],
	["@earendil-works/pi-tui", stub("pi-tui.ts")],
	["@earendil-works/pi-ai", stub("pi-ai.ts")],
	["@earendil-works/pi-agent-core", stub("pi-agent-core.ts")],
	["typebox", stub("typebox.ts")],
]);

/** Starts answering the Pi package specifiers with the stubs; returns the function that stops it. */
export function installPiStubs(): () => void {
	const hooks = registerHooks({
		resolve(specifier, context, nextResolve) {
			const url = STUBS.get(specifier);
			return url === undefined ? nextResolve(specifier, context) : { url, shortCircuit: true };
		},
	});
	return () => hooks.deregister();
}
