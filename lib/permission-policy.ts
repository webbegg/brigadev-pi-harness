import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";

export const PERMISSION_MODE = { NORMAL: "normal", YOLO: "yolo" } as const;
export type PermissionMode = (typeof PERMISSION_MODE)[keyof typeof PERMISSION_MODE];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === PERMISSION_MODE.NORMAL || value === PERMISSION_MODE.YOLO;
}

export type Decision = { action: "allow" } | { action: "confirm"; reason: string } | { action: "block"; reason: string };

/**
 * Decides what to do with a classified shell command.
 *
 * - Hard-deny forms are always blocked.
 * - Subagents (no human in the loop) never run destructive, delivery,
 *   publish, or privileged commands: delivery is parent-owned.
 * - NORMAL asks before every risky kind.
 * - YOLO gives standing permission for ordinary delivery (commits,
 *   non-force pushes, PR/issue creation) but still asks for destructive,
 *   publish, and privileged commands.
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
