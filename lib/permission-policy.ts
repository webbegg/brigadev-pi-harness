import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";

export const PERMISSION_MODE = { NORMAL: "normal", YOLO: "yolo", DSP: "dsp" } as const;
export type PermissionMode = (typeof PERMISSION_MODE)[keyof typeof PERMISSION_MODE];

export function isPermissionMode(value: unknown): value is PermissionMode {
	return value === PERMISSION_MODE.NORMAL || value === PERMISSION_MODE.YOLO || value === PERMISSION_MODE.DSP;
}

/** Names shown to the user (mode picker, dialogs). */
export const MODE_LABEL: Record<PermissionMode, string> = {
	normal: "Normal",
	yolo: "YOLO",
	dsp: "DSP — dangerously skip permissions",
};

/** One line per mode, appended to the parent's system prompt every turn. */
export const MODE_PROMPT: Record<PermissionMode, string> = {
	normal: "Permission mode NORMAL: the guard asks the user before commits on the default branch, pushes, PR/issue writes, and destructive, publish, privileged, or dependency commands. Run the command; don't ask in chat first.",
	yolo: "Permission mode YOLO: commits, non-force pushes, and PR/issue creation run without asking; destructive, publish, privileged, and dependency (install) commands still ask.",
	dsp: "Permission mode DSP: local work runs unasked (history is backed up first). Remote actions and default-branch changes always need the user's OK in the guard dialog: run them, let it ask, never route around it.",
};

export type Decision = { action: "allow" } | { action: "confirm"; reason: string } | { action: "block"; reason: string };

/**
 * Decides what to do with a classified shell command.
 *
 * - Hard-deny forms are always blocked.
 * - Subagents (no human in the loop) never run destructive, delivery,
 *   publish, privileged, or dependency commands: delivery is parent-owned.
 * - NORMAL asks before every risky kind (commits on feature branches are
 *   waived by `decideWithBranchRule` in commit-branch.ts).
 * - YOLO gives standing permission for ordinary delivery (commits,
 *   non-force pushes, PR/issue creation) but still asks for destructive,
 *   publish, privileged, and dependency commands.
 * - DSP is decided by lib/dsp-policy.ts; called here it is as strict as YOLO.
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

/**
 * Each family of secret-bearing paths with the globs fd (`--exclude`) and rg (`--glob '!…'`) use to skip it, so the
 * search tools' excludes live next to the rule they mirror. The globs are an optimization: the tools also filter every
 * result with `isSensitivePath`, which is the guarantee. The `.env.*` globs leave out names that start with e, s, or t
 * after the dot (`.env.example`/`.sample`/`.template` are allowed by `isSensitivePath`); `.env.staging` and `.env.test`
 * are caught by that result filter instead.
 */
export const SENSITIVE_RULES: ReadonlyArray<{ pattern: RegExp; globs: readonly string[] }> = [
	{ pattern: /(^|\/)\.env(\.[^/]*)?$/, globs: ["**/.env", "**/.env.[!est]*"] },
	{ pattern: /(^|\/)\.ssh\//, globs: ["**/.ssh"] },
	{ pattern: /(^|\/)\.aws\/credentials$/, globs: ["**/.aws/credentials"] },
	{ pattern: /(^|\/)\.npmrc$/, globs: ["**/.npmrc"] },
	{ pattern: /(^|\/)\.netrc$/, globs: ["**/.netrc"] },
	{ pattern: /(^|\/)id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/, globs: ["**/id_rsa*", "**/id_ed25519*", "**/id_ecdsa*", "**/id_dsa*"] },
	{ pattern: /\.(pem|key|p12|pfx)$/, globs: ["**/*.pem", "**/*.key", "**/*.p12", "**/*.pfx"] },
	{ pattern: /(^|\/)credentials\.json$/, globs: ["**/credentials.json"] },
	{ pattern: /(^|\/)\.pi\/agent\/auth\.json$/, globs: ["**/.pi/agent/auth.json"] },
];

const SENSITIVE_PATTERNS = SENSITIVE_RULES.map((rule) => rule.pattern);

/** The globs of every rule, for fd and rg. */
export const SENSITIVE_GLOBS: readonly string[] = SENSITIVE_RULES.flatMap((rule) => rule.globs);

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
