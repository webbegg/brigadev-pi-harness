// The DSP (dangerously skip permissions) decision, as pure functions over classified matches and facts, so every
// row of the table is a unit test: allow, allow after a backup, always ask (remote and default-branch actions),
// ask, or block. Remote and default-branch actions are never allowed on their own and never remembered; the guard
// (extensions/guard.ts) turns each answer into a dialog, a backup, an audit record, or a denial.

import { homedir } from "node:os";
import { classifyCommand, COMMAND_KIND, type CommandMatch } from "./command-classifier.ts";
import { type BranchFacts, decideWithBranchRule, onFeatureBranch, readBranchFacts } from "./commit-branch.ts";
import { type BackupPlan } from "./dsp-backup.ts";
import { analyzeDsp, isTestRunnerFinding, type ScriptRead } from "./dsp-classify.ts";
import { fileTargetWithinScope, tempRoots as systemTempRoots } from "./dsp-paths.ts";
import { commandPreview, type Decision, PERMISSION_MODE } from "./permission-policy.ts";
import type { ExecFn } from "./worktree-snapshot.ts";

export const DSP_REMOTE_TITLE = "brigadev DSP: remote action — needs your OK";
export const DSP_NEVER_LINE = "DSP never runs remote actions on its own.";
/** The audit kind of a test run whose remote findings all came from the files the runner loads. */
export const TEST_RUNNER_AUDIT_KIND = "test-runner-locked";

/** One remote (or default-branch) action a command would take, as the dialog shows it. */
export interface RemoteItem {
	/** What it is: "push", "PR merge", "publish", "commit on main", ... */
	label: string;
	remote?: string;
	branch?: string;
	base?: string;
	pr?: string;
	repo?: string;
	ref?: string;
}

export type DspDecision =
	/** `testRunner`: a test runner whose remote findings come only from the files it loads (test files and their imports, or what a runner segment of a package script loads): it runs without asking, credential-locked, and is audited. */
	| { action: "allow"; testRunner?: true }
	| { action: "allow-with-backup"; backup: BackupPlan; testRunner?: true }
	/** Always asks: remote actions and changes to the default branch. `also`: other reasons the command needs the user's OK. */
	| { action: "confirm-remote"; items: RemoteItem[]; also: string[]; backup?: BackupPlan }
	| { action: "confirm"; reason: string; backup?: BackupPlan }
	| { action: "block"; reason: string };

export interface DspFacts {
	projectRoot: string;
	home: string;
	tempRoots: readonly string[];
	/** HEAD's branch and the default branch; called at most when a rule needs it. */
	readBranch: () => Promise<BranchFacts>;
}

function protectedNames(facts: BranchFacts): Set<string> {
	return new Set([...(facts.protectedBranches ?? []), ...(facts.defaultBranch ? [facts.defaultBranch] : [])]);
}

/** HEAD is on a branch that is not the default branch (or main/master). A detached HEAD, an unreadable branch, or an unknown default branch is not: every doubt asks, as in normal mode. */
function headIsFeature(facts: BranchFacts): boolean {
	return facts.currentBranch !== null && facts.defaultBranch !== null && !protectedNames(facts).has(facts.currentBranch);
}

const unique = <T>(list: T[]): T[] => [...new Map(list.map((item) => [JSON.stringify(item), item])).values()];

function mergePlans(plans: BackupPlan[]): BackupPlan | undefined {
	if (plans.length === 0) return undefined;
	const slugs = [...new Set(plans.map((plan) => plan.slug))];
	return {
		slug: slugs.slice(0, 3).join("-"),
		branches: [...new Set(plans.flatMap((plan) => plan.branches))],
		refs: [...new Set(plans.flatMap((plan) => plan.refs))],
		stashes: [...new Set(plans.flatMap((plan) => plan.stashes))],
	};
}

/** The DSP decision for classified matches (`analyzeDsp`). */
export async function decideDsp(matches: CommandMatch[], facts: DspFacts): Promise<DspDecision> {
	const hard = matches.find((match) => match.hardDeny);
	if (hard) return { action: "block", reason: `Blocked by brigadev guard (never allowed): ${hard.reason}` };

	const remoteItems: RemoteItem[] = [];
	/** Items that come only from files a test runner loads: they do not ask when they are all there is. */
	const loadedByRunner = new Set<RemoteItem>();
	const confirmReasons: string[] = [];
	/** How many of `confirmReasons` come only from files a test runner loads. */
	let loadedByRunnerReasons = 0;
	const plans: BackupPlan[] = [];
	const historyLabels: string[] = [];
	const refChecks: Array<{ label: string; names: string[]; current: boolean }> = [];

	for (const match of matches) {
		const tags = match.dsp ?? [];
		if (tags.length === 0) {
			// Nothing DSP-specific is known about it: the normal kinds decide.
			switch (match.kind) {
				case COMMAND_KIND.PRIVILEGED:
				case COMMAND_KIND.DESTRUCTIVE:
					confirmReasons.push(match.reason);
					break;
				case COMMAND_KIND.PUBLISH:
					remoteItems.push({ label: match.reason });
					break;
				case COMMAND_KIND.DELIVERY:
					if (match.commit) historyLabels.push("commit");
					else remoteItems.push({ label: match.reason });
					break;
				default:
					break;
			}
			continue;
		}
		if (match.kind === COMMAND_KIND.PRIVILEGED) confirmReasons.push(match.reason);
		if (match.commit && match.elsewhere) remoteItems.push({ label: "commit (it may land on another branch or in another repository)" });
		for (const tag of tags) {
			switch (tag.type) {
				case "remote": {
					const { type: _type, ...item } = tag;
					remoteItems.push(item);
					if (isTestRunnerFinding(tag)) loadedByRunner.add(item);
					break;
				}
				case "history":
					// After a branch switch (or in another repository) the branch it lands on is unknown: it asks.
					if (match.elsewhere && !match.commit) remoteItems.push({ label: `${tag.label} (it may land on another branch or in another repository)` });
					else if (!(match.commit && match.elsewhere)) historyLabels.push(tag.label);
					break;
				case "default-ref":
					refChecks.push({ label: tag.label, names: tag.names, current: tag.current === true });
					break;
				case "discard":
					plans.push({
						slug: tag.slug,
						branches: tag.branches ?? [],
						refs: tag.refs ?? [],
						stashes: tag.stash === "all" ? ["*"] : tag.stash ? [tag.stash.ref] : [],
					});
					break;
				case "files": {
					const inside = !tag.unknown && tag.targets.length > 0 && tag.targets.every((target) => fileTargetWithinScope(target, tag.dir, facts, tag.rootOk === true));
					if (!inside) confirmReasons.push(`${tag.label} outside the project or the system temp dir (${tag.targets.join(" ") || "target unknown"})`);
					break;
				}
				case "alias":
					confirmReasons.push(`git alias ${tag.name} was not resolved: it may run a remote action`);
					break;
				case "branch-move":
					// Only moves what follows in the same command (`classifyCommand` reads it): nothing to ask here.
					break;
				case "unknown":
					confirmReasons.push(tag.reason);
					// Text in a file the test runner loads that the scan could not read (a fixture that writes a file, a variable).
					if (isTestRunnerFinding(tag)) loadedByRunnerReasons++;
					break;
			}
		}
	}

	if (historyLabels.length > 0 || refChecks.length > 0) {
		let branch: BranchFacts;
		try {
			branch = await facts.readBranch();
		} catch {
			branch = { currentBranch: null, defaultBranch: null, protectedBranches: [] };
		}
		const names = protectedNames(branch);
		const feature = headIsFeature(branch);
		for (const label of unique(historyLabels)) if (!feature) remoteItems.push({ label: `${label} on ${branch.currentBranch ?? "an unverified branch"}`, branch: branch.currentBranch ?? undefined });
		for (const check of refChecks) {
			const hit = check.names.filter((name) => names.has(name));
			if (hit.length > 0) remoteItems.push({ label: `${check.label} ${hit.join(", ")} (the default branch)` });
			else if (check.current && !feature) remoteItems.push({ label: `${check.label} on ${branch.currentBranch ?? "an unverified branch"}` });
		}
	}

	const backup = mergePlans(plans);
	const withBackup = backup ? { backup } : {};
	// Anything the command line itself says asks, with every finding in the dialog; only a run whose findings all came from the test runner's files is let through (locked, audited).
	const typedRemote = remoteItems.some((item) => !loadedByRunner.has(item));
	if (typedRemote) return { action: "confirm-remote", items: unique(remoteItems), also: [...new Set(confirmReasons)], ...withBackup };
	if (confirmReasons.length > loadedByRunnerReasons) return { action: "confirm", reason: [...new Set(confirmReasons)].join("; "), ...withBackup };
	const testRunner = loadedByRunner.size > 0 || loadedByRunnerReasons > 0 ? ({ testRunner: true } as const) : {};
	return backup ? { action: "allow-with-backup", backup, ...testRunner } : { action: "allow", ...testRunner };
}

export interface DspCommandInput {
	command: string;
	/** Where the command starts. */
	cwd: string;
	projectRoot: string;
	home?: string;
	tempRoots?: string[];
	exec: ExecFn;
	/** `cwd` is in another repository than the session's: a commit counts as run elsewhere. */
	elsewhere?: boolean;
	readFile?: (path: string) => ScriptRead;
}

export interface DspResult {
	decision: DspDecision;
	/** What NORMAL mode would have done with the same command. */
	normal: Decision;
	/** The normal classification, for the audit kind. */
	legacy: CommandMatch[];
	matches: CommandMatch[];
}

const GIT_TIMEOUT_MS = 10_000;

/** Classifies the command (wrappers, scripts, aliases), reads the facts it needs, and decides. */
export async function decideDspCommand(input: DspCommandInput): Promise<DspResult> {
	const home = input.home ?? homedir();
	const gitAlias = async (name: string): Promise<string | null | undefined> => {
		const result = await input.exec("git", ["config", "--get", `alias.${name}`], { cwd: input.cwd, timeout: GIT_TIMEOUT_MS }).catch(() => undefined);
		if (!result) return undefined;
		return result.code === 0 ? result.stdout.trim() : result.code === 1 ? null : undefined;
	};
	const matches = await analyzeDsp(input.command, { cwd: input.cwd, home, readFile: input.readFile, gitAlias });
	if (input.elsewhere) for (const match of matches) if (match.commit) match.elsewhere = true;

	let branch: Promise<BranchFacts> | undefined;
	const readBranch = () => (branch ??= readBranchFacts(input.exec, input.cwd));
	const decision = await decideDsp(matches, { projectRoot: input.projectRoot, home, tempRoots: input.tempRoots ?? systemTempRoots(), readBranch });

	const legacy = classifyCommand(input.command);
	if (input.elsewhere) for (const match of legacy) if (match.commit) match.elsewhere = true;
	const normal = await decideWithBranchRule(legacy, PERMISSION_MODE.NORMAL, false, readBranch);
	return { decision, normal, legacy, matches };
}

const testRunnerLocked = (result: DspResult): boolean => (result.decision.action === "allow" || result.decision.action === "allow-with-backup") && result.decision.testRunner === true;

/** DSP ran the command without asking although NORMAL mode would have asked: it goes in the audit log. */
export function isAutoAllowedForAudit(result: DspResult): boolean {
	if (testRunnerLocked(result)) return true;
	return (result.decision.action === "allow" || result.decision.action === "allow-with-backup") && result.normal.action !== "allow";
}

/** The kinds of risk NORMAL mode would have asked about (dependency, destructive, ...), for the audit record. */
export function auditKind(result: DspResult): string {
	if (testRunnerLocked(result)) return TEST_RUNNER_AUDIT_KIND;
	const kinds = [...new Set(result.legacy.filter((match) => !match.hardDeny).map((match) => match.kind))];
	return kinds.join(", ") || "other";
}

// ── the remote dialog ───────────────────────────────────────────────────────────────────────────────────────

export interface RemoteTarget {
	remoteName?: string;
	url?: string;
	branch?: string | null;
}

const GIT_REMOTE_ITEM = /push|^PR |^issue |^release |^repo |^workflow |^run |^api |commit|merge|rebase|cherry|reset|pull|revert|^am /;

/** The remote name and URL a git-based remote action will use (`git remote get-url`), and HEAD's branch. */
export async function readRemoteTarget(exec: ExecFn, cwd: string, items: RemoteItem[]): Promise<RemoteTarget> {
	const gitish = items.filter((item) => item.remote !== undefined || GIT_REMOTE_ITEM.test(item.label));
	if (gitish.length === 0) return { remoteName: undefined, url: undefined };
	const git = async (args: string[]) => exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS }).catch(() => undefined);
	const remoteName = gitish.find((item) => item.remote)?.remote ?? "origin";
	const url = await git(["remote", "get-url", remoteName]);
	const head = await git(["symbolic-ref", "--short", "-q", "HEAD"]);
	return {
		remoteName,
		url: url?.code === 0 && url.stdout.trim() ? url.stdout.trim() : undefined,
		branch: head?.code === 0 && head.stdout.trim() ? head.stdout.trim() : undefined,
	};
}

/** A dialog taller than the terminal hides the chat and its own options, so the body has a fixed line budget. */
export const DSP_DIALOG_MAX_LINES = 24;
/** Every line of the dialog body after the command preview is clipped to this width. */
export const DSP_DIALOG_LINE_CHARS = 160;

const DIALOG_MAX_KINDS = 6;
const DIALOG_MAX_ALSO = 4;
const DIALOG_ALSO_INDENT = "      ";

const clipLine = (text: string) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > DSP_DIALOG_LINE_CHARS ? `${line.slice(0, DSP_DIALOG_LINE_CHARS - 1)}…` : line;
};
const uniqueLines = (values: string[]) => [...new Set(values.map((value) => value.replace(/\s+/g, " ").trim()).filter(Boolean))];

/** `Kind: a, b, c, … and N more`: each kind once, at most DIALOG_MAX_KINDS, on one line within the width. */
function kindLine(labels: string[]): string {
	const kinds = uniqueLines(labels);
	const prefix = "Kind: ";
	let shown = Math.min(kinds.length, DIALOG_MAX_KINDS);
	const render = (count: number) => {
		const more = kinds.length - count;
		return `${prefix}${[...kinds.slice(0, count), ...(more > 0 ? [`… and ${more} more`] : [])].join(", ")}`;
	};
	while (shown > 1 && render(shown).length > DSP_DIALOG_LINE_CHARS) shown--;
	return clipLine(render(shown));
}

/** `Also: a; b` when it fits on one line as before, otherwise one reason per line, at most DIALOG_MAX_ALSO, then `… and N more`. */
function alsoLines(reasons: string[]): string[] {
	const unique = uniqueLines(reasons);
	if (unique.length === 0) return [];
	const joined = `Also: ${unique.join("; ")}`;
	if (unique.length <= DIALOG_MAX_ALSO && joined.length <= DSP_DIALOG_LINE_CHARS) return [joined];
	const shown = unique.slice(0, DIALOG_MAX_ALSO);
	const lines = shown.map((reason, i) => (i === 0 ? clipLine(`Also: ${reason}`) : `${DIALOG_ALSO_INDENT}${clipLine(reason)}`));
	if (unique.length > shown.length) lines.push(`${DIALOG_ALSO_INDENT}… and ${unique.length - shown.length} more`);
	return lines;
}

/** Title and body of the dialog that asks the user to approve a remote action. The body is bounded (DSP_DIALOG_MAX_LINES) whatever the input. */
export function remoteDialog(input: { command: string; items: RemoteItem[]; target?: RemoteTarget; also?: string[] }): { title: string; body: string } {
	const { items, target = {} } = input;
	const lines = [commandPreview(input.command), ""];
	lines.push(kindLine(items.map((item) => item.label)));
	if (target.remoteName) lines.push(clipLine(`Remote: ${target.remoteName}${target.url ? ` (${target.url})` : ""}`));
	const branch = target.branch ?? items.find((item) => item.branch)?.branch;
	if (branch) lines.push(clipLine(`Branch: ${branch}`));
	const base = items.find((item) => item.base)?.base;
	if (base) lines.push(clipLine(`Base: ${base}`));
	const pr = items.find((item) => item.pr)?.pr;
	if (pr) lines.push(clipLine(`PR: #${pr}`));
	const repo = items.find((item) => item.repo)?.repo;
	if (repo) lines.push(clipLine(`Repo: ${repo}`));
	const ref = items.find((item) => item.ref)?.ref;
	if (ref) lines.push(clipLine(`Target: ${ref}`));
	lines.push(...alsoLines(input.also ?? []));
	lines.push("", DSP_NEVER_LINE, "Allow it this once?");
	return { title: DSP_REMOTE_TITLE, body: lines.join("\n") };
}

/** The doctor's warning when DSP is the saved default mode. */
export function defaultModeWarning(mode: unknown): string | undefined {
	return mode === PERMISSION_MODE.DSP ? "default mode is DSP: new sessions skip brigadev's execution questions; remote actions and default-branch changes still always ask" : undefined;
}
