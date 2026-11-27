// The guard's permission dialogs: what will happen, why the agent does it, and what could go wrong, in plain words.
// "What" and "Risk" come from the guard (the command's classification), so they hold even when the agent says nothing;
// "Why" is the agent's own `# why: <reason>` comment on the command.

import { COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";
import { commandPreview } from "./permission-policy.ts";

export type RiskLevel = "Low" | "Medium" | "High";

/** One kind of guarded action, in plain words. */
export interface RiskProfile {
	/** Short verb phrase for the title: "push commits to the remote". */
	action: string;
	/** One sentence: what will happen. */
	what: string;
	level: RiskLevel;
	/** What could go wrong, concretely. */
	risk: string;
	/** Can it be undone, and how. */
	undo: string;
	/** Who or what it affects. */
	affects: string;
}

export interface PermissionDialog {
	title: string;
	body: string;
}

const LEVEL_RANK: Record<RiskLevel, number> = { Low: 0, Medium: 1, High: 2 };
const WHY_MAX_CHARS = 300;
/** A `# why:` comment, on its own line or after the command. */
const WHY_PATTERN = /(?:^|[ \t])#[ \t]*why:[ \t]*(\S[^\n]*)/im;
const WHY_LINE = /^[ \t]*#[ \t]*why:/i;

export const WHY_MISSING = "⚠ The agent did not say why. Consider answering No and asking it first.";
export const WHY_NOT_ATTACHED = "⚠ No reason attached: this tool cannot carry a `# why:` note. Check the agent's last message.";

/** The reason a command gives for itself: its first `# why: <reason>` comment, trimmed and clipped; undefined when it has none. */
export function whyNote(command: string): string | undefined {
	const reason = WHY_PATTERN.exec(command)?.[1].trim();
	if (!reason) return undefined;
	return reason.length > WHY_MAX_CHARS ? `${reason.slice(0, WHY_MAX_CHARS - 1)}…` : reason;
}

/**
 * The command without its leading `# why:` lines: the dialog shows the reason under WHY, not twice. Only leading lines go,
 * where the shell surely reads them as comments; a later one may be data (a heredoc), so the preview keeps it.
 */
function withoutLeadingWhy(command: string): string {
	const lines = command.trim().split("\n");
	let start = 0;
	while (start < lines.length && WHY_LINE.test(lines[start])) start++;
	return lines.slice(start).join("\n").trim() || command;
}

const COMMIT: RiskProfile = {
	action: "commit outside a feature branch",
	what: "Saves a commit on a branch that is not a feature branch (such as main).",
	level: "Medium",
	risk: "The change lands without a PR or a review.",
	undo: "Yes, with git revert (or git reset before it is pushed).",
	affects: "Only your machine, until it is pushed.",
};
const PUSH: RiskProfile = {
	action: "push commits to the remote",
	what: "Uploads commits to the remote repository.",
	level: "Medium",
	risk: "The commits become visible to the team and CI runs on them.",
	undo: "Partly: the remote branch can be deleted, but others may already have it.",
	affects: "The remote repository; others will see it.",
};
const OPEN_PR: RiskProfile = {
	action: "open a pull request",
	what: "Opens a pull request on GitHub.",
	level: "Low",
	risk: "It notifies the reviewers; the title and description are public in the repository.",
	undo: "Partly: the PR can be closed, but it stays in the history.",
	affects: "The repository's team.",
};
const GITHUB_WRITE: RiskProfile = {
	action: "write to GitHub",
	what: "Writes to a GitHub pull request or issue (a comment, a review, an edit, a new issue).",
	level: "Low",
	risk: "The text is public in the repository and notifies whoever follows it.",
	undo: "Partly: it can be edited or closed, but the notifications already went out.",
	affects: "Anyone who can see the repository.",
};
const GITHUB_API: RiskProfile = {
	action: "change data through the GitHub API",
	what: "Sends a write request to the GitHub API.",
	level: "Medium",
	risk: "It changes data on GitHub directly, without the checks of the usual commands.",
	undo: "Depends on the endpoint.",
	affects: "The GitHub repository or account.",
};
const MERGE: RiskProfile = {
	action: "merge a pull request",
	what: "Merges a pull request into its base branch.",
	level: "Medium",
	risk: "The change lands in the base branch, and anything that deploys from it may ship.",
	undo: "Partly: with a revert commit.",
	affects: "Everyone working on the base branch.",
};
const PUBLISH: RiskProfile = {
	action: "publish a release or package",
	what: "Publishes a release, package, or image.",
	level: "High",
	risk: "Anyone can get what is published as soon as it is out.",
	undo: "No: a published version usually cannot be taken back cleanly.",
	affects: "Public: every user of the package or repository.",
};
const REMOTE_REWRITE: RiskProfile = {
	action: "rewrite or delete remote branches",
	what: "Force-pushes or deletes refs on the remote repository.",
	level: "High",
	risk: "Commits on the remote can be lost, for you and for everyone who works on that branch.",
	undo: "Hard: only if someone still has the old commits.",
	affects: "The remote repository and everyone using it.",
};
const SUDO: RiskProfile = {
	action: "run with administrator rights",
	what: "Runs a command with administrator rights (sudo).",
	level: "High",
	risk: "With admin rights the command can change any part of the system.",
	undo: "Depends on the command.",
	affects: "The whole system.",
};
const REMOTE_CODE: RiskProfile = {
	action: "run downloaded or generated code",
	what: "Pipes downloaded or generated text into a shell or interpreter, which runs it.",
	level: "High",
	risk: "The code runs unseen, with your user's rights.",
	undo: "Depends on what the code does.",
	affects: "Your machine and your account.",
};
const DEPENDENCY: RiskProfile = {
	action: "change dependencies",
	what: "Installs, upgrades, or removes third-party packages.",
	level: "Medium",
	risk: "It brings third-party code into the project, and install scripts run right away.",
	undo: "Yes: uninstall it, or restore the lockfile.",
	affects: "The project, and your machine while the scripts run.",
};

function destructive(reason: string): RiskProfile {
	return {
		action: "delete or overwrite data",
		what: `Deletes or overwrites data (${reason}).`,
		level: "High",
		risk: "Whatever it deletes or rewrites is gone, including work that was never committed.",
		undo: "No.",
		affects: "The files, history, or data it targets.",
	};
}

/** The plain-words profile of one classified match (a shell command or an MCP tool). */
export function profileFor(match: CommandMatch): RiskProfile {
	const { kind, reason } = match;
	if (kind === COMMAND_KIND.DESTRUCTIVE) return /push rewrites or deletes remote refs/.test(reason) ? REMOTE_REWRITE : destructive(reason);
	if (kind === COMMAND_KIND.PRIVILEGED) return /^piping into/.test(reason) ? REMOTE_CODE : SUDO;
	if (kind === COMMAND_KIND.DEPENDENCY) return DEPENDENCY;
	if (kind === COMMAND_KIND.PUBLISH) return /gh pr merge|merges a PR/.test(reason) ? MERGE : PUBLISH;
	if (match.commit) return COMMIT;
	if (/^git push$|pushes to a remote branch/.test(reason)) return PUSH;
	if (/^gh pr create$|opens a PR/.test(reason)) return OPEN_PR;
	if (/^gh api/.test(reason)) return GITHUB_API;
	return GITHUB_WRITE;
}

/** A path read or written that commonly holds secrets. */
export function sensitiveProfile(isWrite: boolean): RiskProfile {
	return isWrite
		? {
				action: "change a file that may hold secrets",
				what: "Writes to a file that commonly holds secrets or credentials.",
				level: "High",
				risk: "A wrong edit can break or leak keys and tokens; what the file holds also enters the model's context.",
				undo: "Only if the file has a backup or is tracked by git.",
				affects: "Your credentials.",
			}
		: {
				action: "read a file that may hold secrets",
				what: "Reads a file that commonly holds secrets or credentials.",
				level: "High",
				risk: "Its contents (keys, tokens) enter the model's context.",
				undo: "No: once read, it has been seen.",
				affects: "Your credentials.",
			};
}

/** A write outside the project root; the grant covers `target` for the rest of the session. */
export function outsideProfile(projectRoot: string, target: string): RiskProfile {
	return {
		action: "change files outside the project",
		what: `Writes outside the project root (${projectRoot}).`,
		level: "Medium",
		risk: `Files there are not this project's, and git does not track them here. Saying yes allows any write under ${target} for this session.`,
		undo: "Only by editing them back; there is no project history there.",
		affects: `Whatever uses files under ${target}.`,
	};
}

function uniqueProfiles(profiles: readonly RiskProfile[]): RiskProfile[] {
	const seen = new Set<string>();
	return profiles.filter((profile) => (seen.has(profile.what) ? false : (seen.add(profile.what), true)));
}

const indent = (text: string, prefix: string) =>
	text
		.split("\n")
		.map((line) => `${prefix}${line}`)
		.join("\n");

/**
 * The dialog for one guarded action. `subject` is what runs, already bounded (a command preview, `read .env`); `why` is the
 * agent's reason, or a warning line when it gave none; `extra` is appended before the question (the PR gate's reasons).
 */
export function permissionDialog(input: { profiles: readonly RiskProfile[]; subject: string; why: string; question: string; extra?: string }): PermissionDialog {
	const profiles = uniqueProfiles(input.profiles);
	const top = profiles.reduce((max, profile) => (LEVEL_RANK[profile.level] > LEVEL_RANK[max] ? profile.level : max), "Low" as RiskLevel);
	const risk =
		profiles.length === 1
			? [`  ${profiles[0].risk}`, `  Can it be undone?   ${profiles[0].undo}`, `  Who does it affect? ${profiles[0].affects}`]
			: profiles.flatMap((profile) => [`  ${capitalize(profile.action)} (● ${profile.level}): ${profile.risk}`, `    Can it be undone?   ${profile.undo}`, `    Who does it affect? ${profile.affects}`]);
	const body = [
		"WHAT IT WILL DO",
		...profiles.map((profile) => `  ${profile.what}`),
		input.subject,
		"",
		"WHY",
		`  ${input.why}`,
		"",
		`RISK  ● ${top}`,
		...risk,
		...(input.extra ? ["", input.extra] : []),
		"",
		input.question,
	].join("\n");
	return { title: `brigadev · Needs your permission: ${profiles.map((profile) => profile.action).join(" + ")}`, body };
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The dialog for a guarded shell command: the matches that need the user's yes, the command, and its `# why:` note. */
export function commandDialog(command: string, matches: readonly CommandMatch[], extra?: string): PermissionDialog {
	const lines = commandPreview(withoutLeadingWhy(command)).split("\n");
	const subject = lines.map((line, index) => `${index === 0 ? "  $ " : "    "}${line}`).join("\n");
	return permissionDialog({ profiles: matches.map(profileFor), subject, why: whyNote(command) ?? WHY_MISSING, question: "Run it?", extra });
}

/** The dialog for a guarded MCP tool call: `preview` is the tool name and its clipped input. */
export function toolDialog(preview: string, matches: readonly CommandMatch[], extra?: string): PermissionDialog {
	return permissionDialog({ profiles: matches.map(profileFor), subject: indent(preview, "  "), why: WHY_NOT_ATTACHED, question: "Run it?", extra });
}

/** The dialog before a tool touches a path that commonly holds secrets; `why` is the `# why:` note of a shell tool's command. */
export function sensitiveFileDialog(toolName: string, rawPath: string, isWrite: boolean, why?: string): PermissionDialog {
	return permissionDialog({ profiles: [sensitiveProfile(isWrite)], subject: `  ${toolName} ${rawPath}`, why: why ?? WHY_NOT_ATTACHED, question: "Allow?" });
}

/** The dialog before a write outside the project root; a yes grants writes under `target` for the session. */
export function outsideWriteDialog(toolName: string, absolute: string, projectRoot: string, target: string, why?: string): PermissionDialog {
	return permissionDialog({ profiles: [outsideProfile(projectRoot, target)], subject: `  ${toolName} ${absolute}`, why: why ?? WHY_NOT_ATTACHED, question: `Allow writes under ${target} for this session?` });
}
