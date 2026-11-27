import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";

export const PERMISSION_MODE = { NORMAL: "normal", YOLO: "yolo" } as const;
export type PermissionMode = (typeof PERMISSION_MODE)[keyof typeof PERMISSION_MODE];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === PERMISSION_MODE.NORMAL || value === PERMISSION_MODE.YOLO;
}

/** One line per mode, sent to the model as a context message when a session starts and when the mode changes (never in the system prompt). */
export const MODE_PROMPT: Record<PermissionMode, string> = {
	normal: "Permission mode NORMAL: the guard asks before default-branch commits, pushes, PR/issue writes, and destructive, publish, privileged, or dependency commands. Run them with a `# why: <reason>` line; don't ask in chat.",
	yolo: "Permission mode YOLO: commits and issue writes run unasked; pushes and PR creation always ask; destructive, publish, privileged, and dependency commands still ask. Give those a `# why: <reason>` line.",
};

/** A confirm carries the matches that need the user's yes, so the dialog explains only those. */
export type Decision = { action: "allow" } | { action: "confirm"; reason: string; matches: CommandMatch[] } | { action: "block"; reason: string };

/**
 * Decides what to do with a classified shell command.
 *
 * - Hard-deny forms are always blocked.
 * - Subagents (no human in the loop) never run destructive, delivery,
 *   publish, privileged, or dependency commands: delivery is parent-owned.
 * - NORMAL asks before every risky kind (commits on feature branches are
 *   waived by `decideWithBranchRule` in commit-branch.ts).
 * - YOLO gives standing permission for ordinary delivery (commits, issue
 *   writes, PR comments) but still asks for destructive, publish, privileged,
 *   and dependency commands, and for every push and PR creation
 *   (`alwaysConfirm`): those leave the machine only with the user's yes.
 */
export function decideCommand(matches: CommandMatch[], mode: PermissionMode, isChild: boolean): Decision {
	if (matches.length === 0) return { action: "allow" };
	const hard = matches.find((m) => m.hardDeny);
	if (hard) return { action: "block", reason: `Blocked by brigadev guard (never allowed): ${hard.reason}` };

	const reasons = [...new Set(matches.map((m) => m.reason))].join("; ");
	if (isChild) {
		return { action: "block", reason: `Blocked by brigadev guard: subagents may not run this (${reasons}). Report it to the parent instead.` };
	}
	const needsConfirmation = matches.filter((m) => mode === PERMISSION_MODE.NORMAL || m.kind !== COMMAND_KIND.DELIVERY || m.alwaysConfirm);
	if (needsConfirmation.length === 0) return { action: "allow" };
	return { action: "confirm", reason: [...new Set(needsConfirmation.map((m) => m.reason))].join("; "), matches: needsConfirmation };
}

/** Families of secret-bearing paths. */
export const SENSITIVE_RULES: ReadonlyArray<{ pattern: RegExp }> = [
	{ pattern: /(^|\/)\.env(\.[^/]*)?$/ },
	{ pattern: /(^|\/)\.ssh\// },
	{ pattern: /(^|\/)\.aws\/credentials$/ },
	{ pattern: /(^|\/)\.npmrc$/ },
	{ pattern: /(^|\/)\.netrc$/ },
	{ pattern: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/ },
	{ pattern: /\.(pem|key|p12|pfx)$/ },
	{ pattern: /(^|\/)credentials\.json$/ },
	{ pattern: /(^|\/)\.pi\/agent\/auth\.json$/ },
];

const SENSITIVE_PATTERNS = SENSITIVE_RULES.map((rule) => rule.pattern);

/** True for paths that commonly hold secrets or credentials. */
export function isSensitivePath(path: string): boolean {
	const normalized = path.replace(/\\/g, "/");
	if (/(^|\/)\.env\.(example|sample|template)$/.test(normalized)) return false;
	return SENSITIVE_PATTERNS.some((p) => p.test(normalized));
}

const PREVIEW_HEAD_LINES = 3;
const PREVIEW_TAIL_LINES = 3;
const PREVIEW_LINE_CHARS = 160;

/**
 * Bounded preview of a command for confirmation dialogs. A dialog taller
 * than the terminal hides its own Yes/No options, so long scripts keep only
 * their first and last lines (the risky step, such as `git commit`, usually
 * comes last).
 */
export function commandPreview(command: string): string {
	const clip = (line: string) => (line.length > PREVIEW_LINE_CHARS ? `${line.slice(0, PREVIEW_LINE_CHARS - 1)}…` : line);
	const lines = command.trim().split("\n");
	if (lines.length <= PREVIEW_HEAD_LINES + PREVIEW_TAIL_LINES + 1) return lines.map(clip).join("\n");
	const hidden = lines.length - PREVIEW_HEAD_LINES - PREVIEW_TAIL_LINES;
	return [...lines.slice(0, PREVIEW_HEAD_LINES), `… ${hidden} more lines …`, ...lines.slice(-PREVIEW_TAIL_LINES)].map(clip).join("\n");
}
