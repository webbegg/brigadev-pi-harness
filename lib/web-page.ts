// The web UI page as one static file: assets/web-ui/index.html with its scripts inlined at their `<!-- @inline name -->`
// markers, so the server serves a single response and the CSP needs no script source but 'self' and inline.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_ROOT } from "./runtime.ts";

const INLINED = ["markdown.js"] as const;

export function webPage(assetsRoot: string = ASSETS_ROOT): string {
	const dir = join(assetsRoot, "web-ui");
	let html = readFileSync(join(dir, "index.html"), "utf8");
	for (const name of INLINED) {
		const source = readFileSync(join(dir, name), "utf8");
		if (/<\/script/i.test(source)) throw new Error(`${name} cannot be inlined: it contains a closing script tag`);
		// A replacer function, so `$` sequences in the source are not replacement patterns.
		html = html.replace(`<!-- @inline ${name} -->`, () => `<script>\n${source}</script>`);
	}
	return html;
}
