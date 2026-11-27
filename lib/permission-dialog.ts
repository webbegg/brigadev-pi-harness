// The guard's permission dialogs: what will happen, why the agent does it, and what could go wrong, in plain words.
// "What" and "Risk" come from the guard (the command's classification), so they hold even when the agent says nothing;
// "Why" is the agent's own `# why: <reason>` comment on the command.

import { blankHeredocs, COMMAND_KIND, shellComments, type CommandMatch } from "./command-classifier.ts";
import { commandPreview } from "./permission-policy.ts";

export type RiskLevel = "Low" | "Medium" | "High";

/** One kind of guarded action, in plain words. */
export interface RiskProfile {
	/** Short verb phrase for the title: "push commits to the remote". */
	action: string;
	/** One sentence: what will happen. The dialog adds the classifier's reasons in parentheses. */
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
/** Risks listed in full; the rest are named in one line, so the dialog stays short enough to show its Yes/No. */
const MAX_LISTED = 3;
// `s`: a `\r` inside the comment is part of the reason (made visible below), not its end.
const WHY_COMMENT = /^#[ \t]*why:[ \t]*(\S.*)$/is;
const WHY_LINE = /^[ \t]*#[ \t]*why:/i;
// C0 and C1 controls but the tab, and the Unicode line and paragraph separators: a terminal or the TUI acts on them.
const CONTROL = new RegExp(`[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f${String.fromCharCode(0x2028, 0x2029)}]`, "g");

export const WHY_MISSING = "⚠ The agent did not say why. Consider answering No and asking it first.";
export const WHY_NOT_ATTACHED = "⚠ No reason attached: this tool cannot carry a `# why:` note. Check the agent's last message.";

/** Control characters as visible escapes (`\r`, `\x1b`, the line separator): text from the agent cannot move the cursor, hide lines, or draw fake ones. */
export function visible(text: string): string {
	return text.replace(CONTROL, (ch) => {
		if (ch === "\r") return "\\r";
		if (ch === "\n") return "\\n";
		const code = ch.charCodeAt(0);
		return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
	});
}

/**
 * The reason a command gives for itself: its first `# why: <reason>` shell comment (its own line or after a command), made
 * visible and clipped; undefined when it has none. Quoted text and heredoc bodies are data, never the reason.
 */
export function whyNote(command: string): string | undefined {
	for (const comment of shellComments(blankHeredocs(command))) {
		const reason = WHY_COMMENT.exec(comment)?.[1].trim();
		if (!reason) continue;
		const chars = Array.from(visible(reason));
		return chars.length > WHY_MAX_CHARS ? `${chars.slice(0, WHY_MAX_CHARS - 1).join("")}…` : chars.join("");
	}
	return undefined;
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
	what: "Saves a commit where the guard asks first: the default branch, another repository, or a branch it could not read.",
	level: "Medium",
	risk: "The change lands without a PR or a review (an amend also replaces the last commit).",
	undo: "Yes, with git revert, or git reset before it is pushed (an amended commit is still in git reflog).",
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
const REPO_PUSH: RiskProfile = {
	action: "create a repository and push to it",
	what: "Creates a GitHub repository and uploads commits to it.",
	level: "Medium",
	risk: "The code leaves your machine; with a public repository, anyone can see it.",
	undo: "Partly: the repository can be deleted, but others may already have a copy.",
	affects: "Your GitHub account, and everyone who can see the new repository.",
};
const PUSH_AND_PR: RiskProfile = {
	action: "push and open a pull request",
	what: "Uploads the branch and opens a pull request on GitHub.",
	level: "Medium",
	risk: "The commits become visible and CI runs; the reviewers are notified.",
	undo: "Partly: the PR can be closed and the branch deleted, but both stay in the history.",
	affects: "The remote repository and its team.",
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
	action: "publish or withdraw a release or package",
	what: "Publishes, changes, or withdraws a release, package, or image.",
	level: "High",
	risk: "Whoever installs or downloads it gets the change as soon as it is out.",
	undo: "Usually not cleanly: a published version cannot be reused, and a withdrawn one may already be in use.",
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
const DESTRUCTIVE: RiskProfile = {
	action: "delete or overwrite data",
	what: "Deletes or overwrites data.",
	level: "High",
	risk: "Whatever it deletes or rewrites can be lost, including work that was never committed.",
	undo: "Usually not; a few forms (an archive, a rename, a rebase) can be reverted with effort.",
	affects: "The files, history, or data it targets.",
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
/** A guarded action this file has no words for yet: never shown as harmless. */
const UNKNOWN: RiskProfile = {
	action: "run an action the guard flags",
	what: "Runs an action the guard asks about.",
	level: "High",
	risk: "The guard has no plain description for this action: read the command and the reason in parentheses carefully.",
	undo: "Unknown.",
	affects: "Unknown.",
};

/** The plain-words profile of one classified match (a shell command or an MCP tool). */
export function profileFor(match: CommandMatch): RiskProfile {
	const { kind, reason } = match;
	switch (kind) {
		case COMMAND_KIND.DESTRUCTIVE:
			return /push rewrites or deletes remote refs/.test(reason) ? REMOTE_REWRITE : DESTRUCTIVE;
		case COMMAND_KIND.PRIVILEGED:
			return /^piping into /.test(reason) ? REMOTE_CODE : /sudo/.test(reason) ? SUDO : UNKNOWN;
		case COMMAND_KIND.DEPENDENCY:
			return DEPENDENCY;
		case COMMAND_KIND.PUBLISH:
			return /^gh pr merge$|merges a PR/.test(reason) ? MERGE : PUBLISH;
		case COMMAND_KIND.DELIVERY:
			if (match.commit) return COMMIT;
			if (/^git (subtree )?push$|pushes to a remote branch/.test(reason)) return PUSH;
			if (/^gh repo create --push$/.test(reason)) return REPO_PUSH;
			if (/pushes and opens a PR/.test(reason)) return PUSH_AND_PR;
			if (/^gh pr create$|^gh api opens a PR$/.test(reason)) return OPEN_PR;
			if (/^gh (pr|issue) [a-z]+$|writes to a PR or issue/.test(reason)) return GITHUB_WRITE;
			if (/^gh api /.test(reason)) return GITHUB_API;
			return UNKNOWN;
		default:
			return UNKNOWN;
	}
}

/** A path read or written that commonly holds secrets; `isDirectory`: the folder a background command starts in. */
export function sensitiveProfile(isWrite: boolean, isDirectory = false): RiskProfile {
	if (isDirectory) {
		return {
			action: "work in a folder that may hold secrets",
			what: "Starts a command in a folder that commonly holds secrets or credentials.",
			level: "High",
			risk: "The command can read or change the keys and tokens there, and its output can bring them into the model's context.",
			undo: "Not for what was read; changed files only if they have a backup.",
			affects: "Your credentials.",
		};
	}
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

/** One profile per action, with the classifier's reasons that led to it; highest level first. */
function group(matches: readonly CommandMatch[]): Array<{ profile: RiskProfile; reasons: string[] }> {
	const byAction = new Map<string, { profile: RiskProfile; reasons: string[] }>();
	for (const match of matches) {
		const profile = profileFor(match);
		const entry = byAction.get(profile.action) ?? { profile, reasons: [] };
		if (!entry.reasons.includes(match.reason)) entry.reasons.push(match.reason);
		byAction.set(profile.action, entry);
	}
	return [...byAction.values()].sort((a, b) => LEVEL_RANK[b.profile.level] - LEVEL_RANK[a.profile.level]);
}

const withReasons = (what: string, reasons: readonly string[]) => (reasons.length === 0 ? what : `${what.replace(/\.$/, "")} (${reasons.map(visible).join("; ")}).`);
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/**
 * The dialog for one guarded action. `subject` is what runs, already bounded and indented (a command preview, `read .env`);
 * `why` is the agent's reason, or a warning line when it gave none; `extra` is appended before the question (the PR gate's reasons).
 */
export function permissionDialog(input: { items: ReadonlyArray<{ profile: RiskProfile; reasons?: readonly string[] }>; subject: string; why: string; question: string; extra?: string }): PermissionDialog {
	const listed = input.items.slice(0, MAX_LISTED);
	const more = input.items.slice(MAX_LISTED);
	const top = input.items.reduce((max, item) => (LEVEL_RANK[item.profile.level] > LEVEL_RANK[max] ? item.profile.level : max), "Low" as RiskLevel);
	const risk =
		listed.length === 1
			? [`  ${listed[0].profile.risk}`, `  Can it be undone?   ${listed[0].profile.undo}`, `  Who does it affect? ${listed[0].profile.affects}`]
			: listed.flatMap(({ profile }) => [`  ${capitalize(profile.action)} (● ${profile.level}): ${profile.risk}`, `    Can it be undone?   ${profile.undo}`, `    Who does it affect? ${profile.affects}`]);
	if (more.length > 0) risk.push(`  +${more.length} more: ${more.map(({ profile }) => `${profile.action} (● ${profile.level})`).join(", ")}`);
	const body = [
		"WHAT IT WILL DO",
		...input.items.map(({ profile, reasons }) => `  ${withReasons(profile.what, reasons ?? [])}`),
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
	const actions = listed.map(({ profile }) => profile.action).join(" + ");
	return { title: `brigadev · Needs your permission: ${actions}${more.length > 0 ? ` +${more.length} more` : ""}`, body };
}

/** The dialog for a guarded shell command: the matches that need the user's yes, the command, and its `# why:` note. */
export function commandDialog(command: string, matches: readonly CommandMatch[], extra?: string, question = "Run it?"): PermissionDialog {
	const lines = commandPreview(withoutLeadingWhy(command)).split("\n");
	const subject = lines.map((line, index) => `${index === 0 ? "  $ " : "    "}${visible(line)}`).join("\n");
	return permissionDialog({ items: group(matches), subject, why: whyNote(command) ?? WHY_MISSING, question, extra });
}

/** The dialog for a guarded MCP tool call: `preview` is the tool name and its clipped input. */
export function toolDialog(preview: string, matches: readonly CommandMatch[], extra?: string, question = "Run it?"): PermissionDialog {
	const subject = preview
		.split("\n")
		.map((line) => `  ${visible(line)}`)
		.join("\n");
	return permissionDialog({ items: group(matches), subject, why: WHY_NOT_ATTACHED, question, extra });
}

/** The dialog before a tool touches a path that commonly holds secrets; `why` is the `# why:` note of a shell tool's command. */
export function sensitiveFileDialog(toolName: string, rawPath: string, isWrite: boolean, why?: string, isDirectory = false): PermissionDialog {
	return permissionDialog({ items: [{ profile: sensitiveProfile(isWrite, isDirectory) }], subject: `  ${toolName} ${visible(rawPath)}`, why: why ?? WHY_NOT_ATTACHED, question: "Allow?" });
}

/** The dialog before a write outside the project root; a yes grants writes under `target` for the session. */
export function outsideWriteDialog(toolName: string, absolute: string, projectRoot: string, target: string, why?: string): PermissionDialog {
	return permissionDialog({ items: [{ profile: outsideProfile(projectRoot, target) }], subject: `  ${toolName} ${visible(absolute)}`, why: why ?? WHY_NOT_ATTACHED, question: `Allow writes under ${target} for this session?` });
}
