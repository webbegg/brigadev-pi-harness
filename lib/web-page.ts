// The web UI page as one static file: assets/web-ui/index.html with its scripts inlined at their `<!-- @inline name -->`
// markers, so the server serves a single response and the CSP needs no script source but 'self' and inline.
//
// Two variants share the file. The Pi one (default) is the asset as it is. The runner one (`brigadev-runner start --web`) replaces the three sentences that
// tell a signed-out user how to get a new link, because the page cannot know before it signs in which process serves it: they name the runner's terminal
// instead of Pi's `/brigadev:web open`. The runner makes a fresh link only on Enter in its own terminal (never on a signal another process could send), and what is
// injected is static text: no process id, never a secret.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ASSETS_ROOT } from "./runtime.ts";

const INLINED = ["markdown.js"] as const;

export interface WebPageOptions {
	/** `pi` (default) or `runner`. */
	variant?: "pi" | "runner";
}

/** The sentence a signed-out page ends with in the runner variant. */
const RUNNER_NEW_LINK = "press Enter in the runner's terminal for a new link.";

/** Replace the one line `\tvar <name> = "...";` of the page; a page without it is a drift this refuses to hide. */
function setMessage(html: string, name: string, message: string): string {
	const line = new RegExp(`^(\\tvar ${name} = )".*";$`, "m");
	if (!line.test(html)) throw new Error(`the web page has no ${name} line to replace`);
	// A replacer function, so `$` sequences in the message are not replacement patterns.
	return html.replace(line, (_, head: string) => `${head}${JSON.stringify(message)};`);
}

/** `webPage()`, `webPage(assetsRoot)`, `webPage({ variant: "runner" })`, or both. */
export function webPage(first?: string | WebPageOptions, second: WebPageOptions = {}): string {
	const assetsRoot = typeof first === "string" ? first : ASSETS_ROOT;
	const options = typeof first === "object" ? first : second;
	const dir = join(assetsRoot, "web-ui");
	let html = readFileSync(join(dir, "index.html"), "utf8");
	for (const name of INLINED) {
		const source = readFileSync(join(dir, name), "utf8");
		if (/<\/script/i.test(source)) throw new Error(`${name} cannot be inlined: it contains a closing script tag`);
		// A replacer function, so `$` sequences in the source are not replacement patterns.
		html = html.replace(`<!-- @inline ${name} -->`, () => `<script>\n${source}</script>`);
	}
	if (options.variant === "runner") {
		html = setMessage(html, "LINK_MESSAGE", `This link was already used or expired. Please ${RUNNER_NEW_LINK}`);
		html = setMessage(html, "ENDED_MESSAGE", `This board ended (the runner stopped, or its loop ended). If the runner is still running, ${RUNNER_NEW_LINK}`);
		html = setMessage(html, "SIGNIN_HINT", `If you have no link, ${RUNNER_NEW_LINK}`);
	}
	return html;
}
