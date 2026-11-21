// Masks credentials in text that leaves the process for a UI or another consumer of the brigadev bus (the web page,
// the dashboard): command lines, guard subjects, phase details, subagent tasks and output. It is a best-effort filter
// for the common shapes, not a guarantee: a secret in an unusual shape still passes. Every pattern is bounded, so a
// long hostile string costs time linear in its length. Idempotent.

const MASK = "***";

/** `scheme://user:secret@host` and `scheme://token@host`. */
const URL_CREDENTIALS = /\b([a-z][a-z0-9+.-]{0,20}:\/\/)[^\s/@?#]{1,256}@/gi;
/** `Authorization: Bearer x`, `authorization=basic x`. */
const AUTH_HEADER = /(authorization["']?\s*[:=]\s*["']?(?:bearer|basic))\s+[^\s"']+/gi;
/** `--password=x`, `--token x`, `--api-key x`. */
const SECRET_FLAG = /(--(?:password|passwd|pass|token|secret|api-?key|auth-?token|access-?key|client-?secret|private-?key)(?:=|\s+(?!-)))("[^"]*"|'[^']*'|\S+)/gi;
/** `curl -u user:password`. */
const USER_PASSWORD_FLAG = /(\s(?:-u|--user)\s+)[^\s:]{1,256}:\S+/g;
/** `mysql -pSECRET`, but not `-p 8080:80` or `-p8080:80`. */
const GLUED_PASSWORD_FLAG = /(^|\s)-p(?!\d[\d:./]*(?:\s|$))(?=\S)\S+/g;
/** `GITHUB_TOKEN=x`, `DB_PASSWORD="two words"`, `aws_secret_access_key=x`. */
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]{0,40}(?:token|secret|password|passwd|pwd|api[-_]?key|access[-_]?key|private[-_]?key|credentials?)[A-Za-z0-9_.-]{0,40}=)("[^"]*"|'[^']*'|\S+)/gi;
/** Well-known token prefixes. */
const KNOWN_TOKENS = [
	/\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
	/\bgithub_pat_[A-Za-z0-9_]{20,}/g,
	/\bsk-ant-[A-Za-z0-9_-]{16,}/g, // Anthropic
	/\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style
	/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
];
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
/** A long run of base64url characters; a hit counts only with all three of lower case, upper case and a digit (so paths and words pass). */
const LONG_BASE64 = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{32,}={0,2}(?![A-Za-z0-9_-])/g;

const looksRandom = (text: string): boolean => /[a-z]/.test(text) && /[A-Z]/.test(text) && /[0-9]/.test(text);

/** `text` with credentials masked as `***`; anything that is not a string is the empty string. */
export function redact(text: string): string {
	if (typeof text !== "string" || !text) return "";
	let out = text;
	out = out.replace(URL_CREDENTIALS, `$1${MASK}@`);
	out = out.replace(AUTH_HEADER, `$1 ${MASK}`);
	out = out.replace(SECRET_FLAG, `$1${MASK}`);
	out = out.replace(USER_PASSWORD_FLAG, `$1${MASK}`);
	out = out.replace(GLUED_PASSWORD_FLAG, `$1-p${MASK}`);
	out = out.replace(SECRET_ASSIGNMENT, `$1${MASK}`);
	for (const pattern of KNOWN_TOKENS) out = out.replace(pattern, MASK);
	out = out.replace(LONG_HEX, MASK);
	out = out.replace(LONG_BASE64, (match) => (looksRandom(match) ? MASK : match));
	return out;
}
