// DSP audit: every command DSP ran without asking that NORMAL mode would have asked about is appended to
// `<repo docs>/audit/dsp.jsonl`. The model cannot write the file (the guard applies the evidence log's textual
// protection to it, see extensions/guard.ts). Also the per-session count `/brigadev:mode status` shows.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
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

export function dspAuditRecord(fields: { ts: string; branch: string | null; command: string; kind: string; backups: readonly string[] }): DspAuditRecord {
	const preview = commandPreview(fields.command);
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
	mkdirSync(dirname(file), { recursive: true });
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
