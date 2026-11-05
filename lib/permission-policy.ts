import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";

export const PERMISSION_MODE = { NORMAL: "normal", YOLO: "yolo" } as const;
export type PermissionMode = (typeof PERMISSION_MODE)[keyof typeof PERMISSION_MODE];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === PERMISSION_MODE.NORMAL || value === PERMISSION_MODE.YOLO;
}

/** One line per mode, appended to the parent's system prompt every turn. */
export const MODE_PROMPT: Record<PermissionMode, string> = {
	normal: "Permission mode NORMAL: the guard asks the user before commits, pushes, PR/issue writes, and destructive, publish, privileged, or dependency-changing commands. Run the command; don't ask in chat first.",
	yolo: "Permission mode YOLO: commits, non-force pushes, and PR/issue creation run without asking; destructive, publish, privileged, and dependency (install) commands still ask.",
};

export type Decision = { action: "allow" } | { action: "confirm"; reason: string } | { action: "block"; reason: string };

/**
 * Decides what to do with a classified shell command.
 *
 * - Hard-deny forms are always blocked.
 * - Subagents (no human in the loop) never run destructive, delivery,
 *   publish, privileged, or dependency commands: delivery is parent-owned.
 * - NORMAL asks before every risky kind.
 * - YOLO gives standing permission for ordinary delivery (commits,
 *   non-force pushes, PR/issue creation) but still asks for destructive,
 *   publish, privileged, and dependency commands.
 */
export function decideCommand(matches: CommandMatch[], mode: PermissionMode, isChild: boolean): Decision {
	if (matches.length === 0) return { action: "allow" };
	const hard = matches.find((m) => m.hardDeny);
	if (hard) return { action: "block", reason: `Blocked by brigadev guard (never allowed): ${hard.reason}` };

	const reasons = [...new Set(matches.map((m) => m.reason))].join("; ");
	if (isChild) {
		return { action: "block", reason: `Blocked by brigadev guard: subagents may not run this (${reasons}). Report it to the parent instead.` };
	}
	const needsConfirmation = matches.filter((m) => mode === PERMISSION_MODE.NORMAL || m.kind !== COMMAND_KIND.DELIVERY);
	if (needsConfirmation.length === 0) return { action: "allow" };
	return { action: "confirm", reason: [...new Set(needsConfirmation.map((m) => m.reason))].join("; ") };
}

const SENSITIVE_PATTERNS = [
	/(^|\/)\.env(\.[^/]*)?$/,
	/(^|\/)\.ssh\//,
	/(^|\/)\.aws\/credentials$/,
	/(^|\/)\.npmrc$/,
	/(^|\/)\.netrc$/,
	/(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/,
	/\.(pem|key|p12|pfx)$/,
	/(^|\/)credentials\.json$/,
	/(^|\/)\.pi\/agent\/auth\.json$/,
];

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
