// DSP audit: every command DSP ran without asking that NORMAL mode would have asked about is appended to
// `<repo docs>/audit/dsp.jsonl`. The model cannot write the file (the guard applies the evidence log's textual
// protection to it, see extensions/guard.ts). Also the per-session count `/brigadev:mode status` shows.

import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LOCKED_NAME } from "./dsp-credlock.ts";
import { commandPreview } from "./permission-policy.ts";

const MAX_COMMAND_CHARS = 1_000;

export interface DspAuditRecord {
	v: 1;
	ts: string;
	/** Branch HEAD was on; null when detached or unknown. */
	branch: string | null;
	/** Bounded preview of the command (`commandPreview`). */
	command: string;
	/** What NORMAL mode would have asked about: the kinds of risky matches (dependency, destructive, ...). */
	kind: string;
	/** Backup refs made before the command ran (S3). */
	backups: string[];
}

/** The folder the audit log lives in (`<docs>/audit`); the guard protects it like `evidence/`. */
export function dspAuditDir(docsDir: string): string {
	return join(docsDir, "audit");
}

export function dspAuditFile(docsDir: string): string {
	return join(dspAuditDir(docsDir), "dsp.jsonl");
}

const REDACTED = "[redacted]";
const VALUE = `"[^"]*"|'[^']*'|[^\\s"';&|)]+`;

/**
 * The command with the secrets an audit line must not keep taken out: `Authorization`/`Bearer`/`...token` header values, `user:pass@` in URLs,
 * `--token`/`--password`-style flag values, `_authToken=`/`_password=`, well-known token shapes, and the value of every assignment whose name
 * the credential lock removes (LOCKED_NAME). It is a best-effort text filter, not a guarantee: the log is private (0700/0600) as well.
 */
export function redactSecrets(command: string): string {
	return command
		.replace(new RegExp(`(\\bauthorization\\s*[:=]\\s*)(?:(?:bearer|basic|token|digest)\\s+)?(?:${VALUE})`, "gi"), `$1${REDACTED}`)
		.replace(/\bbearer\s+[^\s"';&|)]+/gi, `Bearer ${REDACTED}`)
		.replace(new RegExp(`(\\b[\\w-]*(?:token|secret|api-?key|passw(?:or)?d)[\\w-]*\\s*:\\s*)(?:${VALUE})`, "gi"), `$1${REDACTED}`)
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/"']+:)[^\s@/"']+@/gi, `$1${REDACTED}@`)
		.replace(new RegExp(`(--?[\\w-]*(?:token|password|passwd|secret|api-?key)[\\w-]*(?:=|\\s+(?=[^-\\s])))(?:${VALUE})`, "gi"), `$1${REDACTED}`)
		.replace(new RegExp(`(_auth(?:Token)?|_password)(\\s*=\\s*)(?:${VALUE})`, "gi"), `$1$2${REDACTED}`)
		.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|glpat-[\w-]{16,}|npm_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9-]{20,}|AKIA[0-9A-Z]{16})\b/g, REDACTED)
		.replace(new RegExp(`(^|[\\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(${VALUE})`, "g"), (whole, lead: string, name: string) => (LOCKED_NAME.test(name) ? `${lead}${name}=${REDACTED}` : whole));
}

export function dspAuditRecord(fields: { ts: string; branch: string | null; command: string; kind: string; backups: readonly string[] }): DspAuditRecord {
	// Redacted first: a clip must not cut a secret in half and keep the front of it.
	const preview = commandPreview(redactSecrets(fields.command));
	return {
		v: 1,
		ts: fields.ts,
		branch: fields.branch,
		command: preview.length > MAX_COMMAND_CHARS ? `${preview.slice(0, MAX_COMMAND_CHARS - 1)}…` : preview,
		kind: fields.kind,
		backups: [...fields.backups],
	};
}

/** One JSON line per record; appends from several processes stay whole lines. */
export function appendDspAudit(file: string, record: DspAuditRecord): void {
	const dir = dirname(file);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	try {
		chmodSync(dir, 0o700);
	} catch {
		// Not ours to change (another owner): the file itself is still 0600.
	}
	appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
}

export function readDspAudit(file: string): DspAuditRecord[] {
	if (!existsSync(file)) return [];
	const records: DspAuditRecord[] = [];
	for (const line of readFileSync(file, "utf8").split("\n")) {
		if (!line.trim()) continue;
		try {
			const parsed = JSON.parse(line);
			if (parsed?.v === 1 && typeof parsed.command === "string") records.push(parsed);
		} catch {
			// A torn or hand-edited line must not hide the rest of the log.
		}
	}
	return records;
}

let autoAllowed = 0;

/** One more command DSP ran without asking, this session. */
export function noteDspAllowed(): void {
	autoAllowed++;
}

export function dspAutoAllowedCount(): number {
	return autoAllowed;
}

export function resetDspCount(): void {
	autoAllowed = 0;
}

/** The line `/brigadev:mode status` (and `/brigadev:status`) shows. */
export function dspStatusLine(): string {
	return `DSP: ${autoAllowed} auto-allowed this session`;
}
