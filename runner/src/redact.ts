// R1-003: what the runner publishes (a PR comment, a `## Log` line, a ticket note) is read by other people and indexed: no credential in a URL, no token-looking
// string, and no home directory. The runner's own words are safe; what it quotes (git and gh stderr, suite output, worker text, a path) is not.
import { homedir } from "node:os";

const TOKENS: RegExp[] = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bsk-ant-[A-Za-z0-9_-]{8,}/g,
	/\bsk-[A-Za-z0-9]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAKIA[0-9A-Z]{16}\b/g,
	// Long hex (an old 40-character GitHub token, a key, a digest): 32 or more.
	/\b[a-fA-F0-9]{32,}\b/g,
	// Long base64: 32 or more with a digit, a lower-case and an upper-case letter (an identifier has not all three). It never starts with `/` or inside a word, so an
	// absolute path (`/var/folders/Ab3.../T/x`) is not one.
	/(?<![A-Za-z0-9+/])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*[A-Z])[A-Za-z0-9+][A-Za-z0-9+/]{31,}={0,2}/g,
];

/** `https://user:token@host/` becomes `https://***@host/`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi;

/** `text` with credentials in URLs, token-looking strings, and the home directory removed. */
export function redact(text: string, home: string = homedir()): string {
	let out = text.replace(URL_CREDENTIALS, "$1***@");
	// The home directory first: what is left of a path is short, and a long path is not mistaken for a token.
	if (home.length > 1) out = out.split(home).join("~");
	for (const pattern of TOKENS) out = out.replace(pattern, "***");
	return out;
}
