/**
 * brigadev guard: destructive-command confirmation, permission modes,
 * project-root boundary, secret-file protection, and allowed-edit-surface
 * enforcement for subagents.
 *
 * Subagents load this file explicitly (`-e`), so it must work standalone.
 */

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isToolCallEventType, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { writesOutsideSurfaces } from "../lib/bash-writes.ts";
import { classifyCommand } from "../lib/command-classifier.ts";
import { readBranchFacts } from "../lib/commit-branch.ts";
import { createBackup, type BackupPlan } from "../lib/dsp-backup.ts";
import { clearCredLocks, DSP_LOCK_ENV, dspShellProblem, lockEnvironment, lockPlaces, lockPrelude, markCredLock, setParentDspLock, type LockPlaces } from "../lib/dsp-credlock.ts";
import { appendDspAudit, dspAuditDir, dspAuditFile, dspAuditRecord, dspStatusLine, noteDspAllowed, resetDspCount } from "../lib/dsp-audit.ts";
import { bashProtectedTargets, isCredentialPath, protectedPathKind, tempRoots, type ProtectedPathContext } from "../lib/dsp-paths.ts";
import { auditKind, decideDspCommand, isAutoAllowedForAudit, readRemoteTarget, remoteDialog, type DspResult } from "../lib/dsp-policy.ts";
import { appendEvidence, commitGateWithForce, evidenceFile, forceRecord, gateDialog, readEvidence, type ForceRecord } from "../lib/evidence.ts";
import { bashWritesEvidence, decideBashCommand, decideFileAccess, EVIDENCE_BLOCK, shellCallOf, type PathVerdict } from "../lib/guard-rules.ts";
import { commandPreview, isPermissionMode, isSensitivePath, MODE_LABEL, MODE_PROMPT, PERMISSION_MODE, type PermissionMode } from "../lib/permission-policy.ts";
import { appendOutsideWrite, bashOutsideTargets, changedSince, formatOutsideWrites, outsideWhy, outsideWritesFile, readOutsideWrites, runYoloDirCommand, secureYoloDirs, trustedTempRoots, type OutsideWriteRecord } from "../lib/outside-writes.ts";
import { canonicalPath, expandHome, isInside } from "../lib/paths.ts";
import { brigadevHome, repoDocsDir } from "../lib/repo-docs.ts";
import { agentDir, appendSystemPromptOnce, CHILD_ENV, childAllowedSurfaces, isChildSession, PACKAGE_ROOT, readSettings, writeSettings } from "../lib/runtime.ts";
import { diffSnapshots, outsideSurfaces, takeSnapshot, type ExecFn, type Snapshot } from "../lib/worktree-snapshot.ts";
import { worktreeTreeResult } from "../lib/worktree-tree.ts";

const MODE_ENTRY = "brigadev-mode";
const STATUS_KEY = "brigadev-mode";

const AUDIT_BLOCK =
	"Blocked by brigadev guard: the DSP audit log is written only by the guard, so the record of what DSP ran without asking cannot be forged. Read it if you need it.";
const DSP_SWITCH_BODY =
	"DSP (dangerously skip permissions) runs local commands without asking: commits on feature branches, dependency installs, deletes inside the project, local history rewrites (backed up first).\n\nEvery remote action (push, PRs, releases, publish, HTTP writes, remote and credential config) and every change to the default branch still asks, each time.\n\nSwitch to DSP?";


export default function (pi: ExtensionAPI) {
	const isChild = isChildSession();
	// R1-001: a subagent launched while its parent was in DSP carries the marker; it has no remote dialog, so every bash call is locked, never unlocked.
	const lockedChild = isChild && process.env[DSP_LOCK_ENV] === "1";
	let mode: PermissionMode = PERMISSION_MODE.NORMAL;
	// Per-session grants for directories outside the project root.
	const outsideGrants = new Set<string>();
	// Worktree tree the user granted a one-shot commit force for (/brigadev:force-commit). Only that command sets it.
	let forcedTree: string | undefined;
	// S10: the DSP credential lock for this session, computed once from the parent environment (nothing is written to disk).
	let sessionLock: { places: LockPlaces; prelude: string } | undefined;

	const projectRoot = (ctx: ExtensionContext) => canonicalPath(process.env[CHILD_ENV.PROJECT_ROOT] ?? ctx.cwd);
	/** DSP applies to the parent session only: subagents never inherit it. */
	const inDsp = () => !isChild && mode === PERMISSION_MODE.DSP;
	const protectedContext = (ctx: ExtensionContext): ProtectedPathContext => ({
		home: homedir(),
		agentDir: agentDir(),
		installRoot: PACKAGE_ROOT,
		projectRoot: projectRoot(ctx),
		docsDir: () => repoDocsDir(ctx.cwd),
	});

	// Writers only: bash must not change files outside the allowed edit surfaces.
	const writerSurfaces = (): string[] | undefined => (isChild && process.env[CHILD_ENV.READ_ONLY] !== "1" ? childAllowedSurfaces() : undefined);
	const exec: ExecFn = (command, args, options) => pi.exec(command, args, options);
	// Working-tree snapshot taken before each allowed bash call, by tool call id.
	const beforeBash = new Map<string, Snapshot>();
	// Parent write/edit calls allowed outside the project, by tool call id; recorded in the ledger once they succeed.
	const pendingOutside = new Map<string, Omit<OutsideWriteRecord, "ts">>();
	// Allowed bash calls that name files outside the project, by tool call id: the check gives the ones the command created or changed.
	const pendingBash = new Map<string, () => Array<Pick<OutsideWriteRecord, "path" | "why">>>();

	// A secure-yolo folder must not reach the agent folder, every repo's docs (evidence logs), or the harness code.
	const secureGuard = () => ({ home: homedir(), agentDir: agentDir(), protectedDirs: [brigadevHome(), PACKAGE_ROOT] });
	/** The parent's secure-yolo folders from brigadev.json (re-read each call, so /brigadev:yolo-dir applies at once). */
	const secureDirs = (): string[] => secureYoloDirs(readSettings().secureYoloDirs, secureGuard());
	const tempDirs = (): string[] => trustedTempRoots(tempRoots(), homedir());

	/** The launcher (lib/child-launch.ts) reads this at spawn time: children launched while the parent is in DSP carry the marker. */
	const syncParentLock = () => {
		if (!isChild) setParentDspLock(mode === PERMISSION_MODE.DSP);
	};

	const publishStatus = (ctx: ExtensionContext) => {
		syncParentLock();
		if (isChild || !ctx.hasUI) return;
		ctx.ui.setStatus(STATUS_KEY, mode === PERMISSION_MODE.YOLO ? "🚀 brigadev: yolo" : mode === PERMISSION_MODE.DSP ? "⚠ brigadev: DSP" : "brigadev: normal");
	};

	const restoreMode = (ctx: ExtensionContext) => {
		const saved = readSettings().defaultMode;
		mode = isPermissionMode(saved) ? saved : PERMISSION_MODE.NORMAL;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && entry.customType === MODE_ENTRY) {
				const value = (entry.data as { mode?: unknown } | undefined)?.mode;
				if (isPermissionMode(value)) mode = value;
			}
		}
		// The credential lock is a POSIX shell prefix: with another shell DSP would run commands unlocked, so the session starts in normal mode.
		if (mode === PERMISSION_MODE.DSP && !isChild) {
			const problem = dspShellProblem({ cwd: ctx.cwd });
			if (problem) {
				mode = PERMISSION_MODE.NORMAL;
				if (ctx.hasUI) ctx.ui.notify(`brigadev: DSP is off for this session. ${problem}`, "warning");
			}
		}
		outsideGrants.clear();
		publishStatus(ctx);
	};

	const setMode = (next: PermissionMode, ctx: ExtensionContext) => {
		mode = next;
		pi.appendEntry(MODE_ENTRY, { mode });
		publishStatus(ctx);
	};

	/** Asks the user; without a UI (print mode, subagents) the answer is no. */
	const confirm = async (ctx: ExtensionContext, title: string, body: string): Promise<boolean> => {
		if (isChild || !ctx.hasUI) return false;
		return ctx.ui.confirm(title, body);
	};

	/** Top of the repository that holds `dir` (canonical); `dir` itself when git cannot tell (not a repository, a failure). */
	const repoRoot = async (dir: string): Promise<string> => {
		const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: dir, timeout: 15_000 }).catch(() => undefined);
		return top?.code === 0 && top.stdout.trim() ? canonicalPath(top.stdout.trim()) : dir;
	};

	/**
	 * Evidence gate for `git commit` (parent only, every permission mode): blocks a commit with source
	 * changes unless a passing test is recorded for the current tree. Only the user can force it.
	 * Returns a block reason, or a `settle` to call once the remaining rules let the commit run: the
	 * user's force (one-shot or dialog) is spent and logged then, not when a later rule declines.
	 */
	const evidenceGate = async (command: string, ctx: ExtensionContext, startsElsewhere: boolean, offerForce = true): Promise<{ reason?: string; settle: () => void }> => {
		const nothing = { settle: () => {} };
		const commits = classifyCommand(command).filter((match) => match.commit);
		if (commits.length === 0) return nothing;
		// The whole repository, not the session folder: a session in a subdirectory commits files elsewhere too.
		const root = await repoRoot(projectRoot(ctx));
		const treeResult = await worktreeTreeResult(root);
		const tree = treeResult.kind === "tree" ? treeResult.tree : undefined;
		const treeError = treeResult.kind === "error" ? treeResult.reason : undefined;
		const snapshot = tree === undefined ? undefined : await takeSnapshot(exec, root);
		const branch = (await readBranchFacts(exec, ctx.cwd)).currentBranch;
		const file = evidenceFile(repoDocsDir(ctx.cwd), branch);
		const log = (via: ForceRecord["via"]) => {
			try {
				appendEvidence(file, forceRecord({ ts: new Date().toISOString(), branch, tree, via, command }));
			} catch {
				// The force is the user's decision; a failed log write does not undo it.
			}
		};

		const { decision, consumedForce } = commitGateWithForce({
			// Unknown dirty paths count as source: a gate that cannot see the change must not pass it.
			dirtyPaths: snapshot ? [...snapshot.keys()] : ["(unknown)"],
			tree,
			treeError,
			elsewhere: startsElsewhere || commits.some((match) => match.elsewhere),
			records: readEvidence(file),
			forcedTree,
		});
		if (decision.action === "allow") {
			return consumedForce
				? {
						settle: () => {
							forcedTree = undefined;
							log("command");
						},
					}
				: nothing;
		}

		// In DSP the agent runs the tests; the user's own `/brigadev:force-commit` still works.
		if (offerForce && !isChild && ctx.hasUI) {
			const dialog = gateDialog(decision.reason, command);
			if (await ctx.ui.confirm(dialog.title, dialog.body)) return { settle: () => log("dialog") };
		}
		return { reason: decision.reason, settle: () => {} };
	};

	/**
	 * One file-access decision for a path a tool call touches (read, write, edit, or the working directory a background
	 * process starts in): sensitive-path question, outside-project grant. Returns a block, or undefined to let it run.
	 * `isDirectory`: the path is a working directory, so a sensitive folder (`.ssh`) counts as sensitive and an outside
	 * directory is granted as itself, not as its parent (the folder of a file).
	 */
	const checkPath = async (toolName: string, rawPath: string, absolute: string, isWrite: boolean, ctx: ExtensionContext, isDirectory = false): Promise<{ block: true; reason: string } | undefined> => {
		const root = projectRoot(ctx);
		const dsp = inDsp();
		// Protected paths (git hooks and config, shell startup files, harness config) are never trusted folder content: a secure folder
		// that holds other repos or dotfiles must not let the parent plant code that runs later. DSP asks for them below; other modes fall back
		// to the outside-project question.
		const pathKind = isWrite && !isDirectory ? protectedPathKind(absolute, protectedContext(ctx)) : undefined;
		const protectedKind = dsp ? pathKind : undefined;
		if (protectedKind === "audit") return { block: true, reason: AUDIT_BLOCK };
		const decision = decideFileAccess({
			isChild,
			isWrite,
			rawPath,
			absolutePath: absolute,
			projectRoot: root,
			docsDir: () => repoDocsDir(ctx.cwd),
			// In DSP the credential stores the lock hides from the shell (`~/.git-credentials`, `~/.docker/`, `~/.config/gh/`, ...) ask on a read too
			// (a write to one that DSP protects, such as `~/.config/gh/`, already asks as a protected path).
			sensitive: isSensitivePath(isDirectory ? `${absolute}/` : absolute) || (dsp && !isWrite && isCredentialPath(absolute, homedir())),
			readOnly: process.env[CHILD_ENV.READ_ONLY] === "1",
			surfaces: isChild ? childAllowedSurfaces() : undefined,
			agent: process.env[CHILD_ENV.AGENT],
			// The system temp dir and the secure-yolo folders: parent writes there run without asking (subagents stay blocked).
			trustedDirs: isChild || pathKind ? undefined : [...tempDirs(), ...secureDirs()],
		});

		let verdict: PathVerdict;
		if (decision.action === "ask" && decision.kind === "sensitive") {
			const ok = await confirm(ctx, "brigadev: sensitive file", `${toolName} ${rawPath}\n\nThis path commonly holds secrets or credentials. Allow?`);
			if (!ok) return { block: true, reason: `User declined access to sensitive file ${rawPath}` };
			verdict = decision.then;
		} else verdict = decision;

		if (verdict.action === "block") return { block: true, reason: verdict.reason };
		if (protectedKind === "protected") {
			// Asked every time, never granted for the session.
			const ok = await confirm(ctx, "brigadev DSP: protected path", `${toolName} ${absolute}\n\nThis path configures the harness, git, gh, hooks, or your shell, so DSP asks every time. Allow this write?`);
			if (!ok) return { block: true, reason: ctx.hasUI ? `User declined write to protected path: ${absolute}` : `Blocked by brigadev DSP: ${absolute} is a protected path and there is no UI to ask (print mode).` };
		}
		// DSP: writes outside the project run without a grant (protected and sensitive paths were asked above).
		if (verdict.action === "ask" && !dsp) {
			if ([...outsideGrants].some((granted) => isInside(granted, absolute))) return undefined;
			const target = isDirectory ? absolute : verdict.target;
			const ok = await confirm(ctx, "brigadev: write outside project", `${toolName} ${absolute}\n\nOutside the project root ${root}. Allow writes under ${target} for this session?`);
			if (!ok) return { block: true, reason: `User declined write outside the project root: ${absolute}` };
			outsideGrants.add(target);
		}
		return undefined;
	};

	pi.on("session_start", async (_event, ctx) => {
		sessionLock = undefined;
		pendingOutside.clear();
		pendingBash.clear();
		resetDspCount();
		restoreMode(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => restoreMode(ctx));
	pi.on("session_shutdown", async () => {
		clearCredLocks();
		sessionLock = undefined;
		if (!isChild) setParentDspLock(false);
	});

	/**
	 * S10: runs the call in the credential-locked environment. The decision and every dialog were made on the original command; this
	 * is the last step. `bg_start` passes the locked environment through its spawn (background-terminals.ts takes the mark for this
	 * call id); `bash` gets the prelude as its first line (lockPrelude), because Pi's bash tool has no per-call environment: its spawn
	 * hook is per tool object and gets no call id, and replacing the tool would drop the user's shellPath/shellCommandPrefix settings.
	 * The lock depends on no file the agent can write: the prelude is inline static text and every target is read-only.
	 */
	const lockCall = (toolName: string, toolCallId: string, input: unknown): void => {
		if (!sessionLock) {
			const places = lockPlaces();
			sessionLock = { places, prelude: lockPrelude(lockEnvironment(process.env, places)) };
		}
		const { places, prelude } = sessionLock;
		if (toolName === "bg_start") {
			markCredLock(toolCallId, (env) => lockEnvironment(env, places).env);
			return;
		}
		const fields = input as { command?: unknown };
		if (typeof fields.command === "string") fields.command = `${prelude}\n${fields.command}`;
	};

	const kindsOf = (items: Array<{ label: string }>) => [...new Set(items.map((item) => item.label))].join(", ");

	/**
	 * Carries out a DSP decision up to the moment the command may run: the dialogs (a remote action always asks, with no
	 * UI it is denied), then the automatic backup. Returns a block reason, or the backup refs made and whether the command
	 * counts as auto-allowed (it ran without a question although normal mode would have asked).
	 */
	const settleDsp = async (result: DspResult, command: string, cwd: string, ctx: ExtensionContext): Promise<{ block: string } | { backups: string[]; autoAllowed: boolean; remoteApproved: boolean }> => {
		const d = result.decision;
		if (d.action === "block") return { block: d.reason };
		const preview = commandPreview(command);
		let remoteApproved = false;
		if (d.action === "confirm-remote") {
			const kinds = kindsOf(d.items);
			if (isChild || !ctx.hasUI) return { block: `Blocked by brigadev DSP: this is a remote action (${kinds}), remote actions always need your OK, and there is no UI to ask (print mode). Run it yourself.` };
			const dialog = remoteDialog({ command, items: d.items, target: await readRemoteTarget(exec, cwd, d.items), also: d.also });
			if (!(await ctx.ui.confirm(dialog.title, dialog.body))) return { block: `User declined: DSP remote action (${kinds})` };
			remoteApproved = true; // S10: this one call, and only this one, runs without the credential lock
		} else if (d.action === "confirm") {
			if (!(await confirm(ctx, `brigadev: ${d.reason}`, `${preview}\n\nRun it?`))) return { block: `User declined: ${d.reason}` };
		}
		const plan: BackupPlan | undefined = d.action === "allow" ? undefined : d.backup;
		let backups: string[] = [];
		if (plan) {
			const made = await createBackup(exec, cwd, plan);
			if (made.ok) backups = made.refs;
			else {
				// An earlier "yes" (the confirm or remote dialog) was for the command with a backup: ask again, or deny without a UI.
				const ok = await confirm(ctx, "brigadev DSP: backup failed", `${preview}\n\nThe automatic backup failed (${made.error}); run without a backup?`);
				if (!ok) return { block: ctx.hasUI ? `User declined: the automatic backup failed (${made.error})` : `Blocked by brigadev DSP: the automatic backup before this local discard failed (${made.error}) and there is no UI to ask.` };
				return { backups: [], autoAllowed: false, remoteApproved };
			}
		}
		return { backups, autoAllowed: isAutoAllowedForAudit(result), remoteApproved };
	};

	/** One audit line for a command DSP ran without asking (a failed write never stops the command). */
	const recordAudit = async (result: DspResult, command: string, cwd: string, ctx: ExtensionContext, backups: string[]) => {
		noteDspAllowed();
		try {
			const branch = (await readBranchFacts(exec, cwd)).currentBranch;
			appendDspAudit(dspAuditFile(repoDocsDir(ctx.cwd)), dspAuditRecord({ ts: new Date().toISOString(), branch, command, kind: auditKind(result), backups }));
		} catch {
			// The log is a record, not a gate.
		}
	};

	pi.on("before_agent_start", async (event) => {
		if (isChild) return;
		appendSystemPromptOnce(event.systemPromptOptions, MODE_PROMPT[mode]);
	});

	pi.on("tool_call", async (event, ctx) => {
		// `bash` and `bg_start` (a background shell process) are one path: same classification, same permission rules,
		// same evidence-log and commit-gate rules. `bg_start` adds its working directory, decided like a write into it.
		const shell = shellCallOf(event.toolName, event.input);
		if (shell) {
			const { command } = shell;
			// A mark left by an earlier call with this id must not lock (or unlock) this one.
			markCredLock(event.toolCallId, undefined);
			let remoteApproved = false;
			// Where the command starts: a bg_start `cwd` is the same move as `cd <cwd> && <command>`, so relative paths in the
			// rules below resolve against it and a commit there is decided like bash decides the `cd` form.
			const commandCwd = shell.cwd === undefined ? ctx.cwd : canonicalPath(resolve(ctx.cwd, expandHome(shell.cwd)));
			// Nobody forges a recorded test result: the evidence log is written only by the recorder. (Textual rule; reading stays allowed.)
			if ((command.includes("evidence") || commandCwd.includes("evidence")) && bashWritesEvidence(command, [join(repoDocsDir(ctx.cwd), "evidence")], undefined, shell.cwd === undefined ? undefined : commandCwd)) return { block: true, reason: EVIDENCE_BLOCK };
			if (inDsp()) {
				// The audit log is written only by the guard (same textual rule as the evidence log), and protected paths ask every time.
				if ((command.includes("audit") || commandCwd.includes("audit")) && bashWritesEvidence(command, [dspAuditDir(repoDocsDir(ctx.cwd))], undefined, shell.cwd === undefined ? undefined : commandCwd)) return { block: true, reason: AUDIT_BLOCK };
				const touched = bashProtectedTargets(command, commandCwd, protectedContext(ctx));
				if (touched.some((target) => target.kind === "audit")) return { block: true, reason: AUDIT_BLOCK };
				if (touched.length > 0) {
					const paths = touched.map((target) => target.path).join("\n");
					const ok = await confirm(ctx, "brigadev DSP: protected path", `${commandPreview(command)}\n\nThis command writes or deletes:\n${paths}\n\nThese paths configure the harness, git, gh, hooks, or your shell, so DSP asks every time. Run it?`);
					if (!ok) return { block: true, reason: ctx.hasUI ? `User declined write to protected path: ${touched[0].path}` : `Blocked by brigadev DSP: ${touched[0].path} is a protected path and there is no UI to ask (print mode).` };
				}
			}
			if (shell.cwd !== undefined) {
				const blocked = await checkPath(event.toolName, shell.cwd, commandCwd, true, ctx, true);
				if (blocked) return blocked;
			}
			const surfaces = writerSurfaces();
			if (surfaces) {
				const outside = writesOutsideSurfaces(command, commandCwd, projectRoot(ctx), surfaces);
				if (outside.length > 0) {
					return {
						block: true,
						reason: `Blocked by brigadev guard: this command writes ${outside.join(", ")}, outside the allowed edit surfaces (${surfaces.join(", ")}). Use edit or write inside your surfaces, or stop and report status: interaction_required with the path you need.`,
					};
				}
			}

			// A commit whose directory is in another repository than the session's is "elsewhere" for the branch rule and the gate alike.
			const startsElsewhere = shell.cwd !== undefined && classifyCommand(command).some((match) => match.commit) && (await repoRoot(commandCwd)) !== (await repoRoot(projectRoot(ctx)));
			const dsp = inDsp();
			const dspResult = dsp ? await decideDspCommand({ command, cwd: commandCwd, projectRoot: projectRoot(ctx), exec, elsewhere: startsElsewhere }) : undefined;
			const decision = dspResult ? undefined : await decideBashCommand({ command, mode, isChild, cwd: commandCwd, elsewhere: startsElsewhere, readFacts: (cwd) => readBranchFacts(exec, cwd) });
			if (dspResult?.decision.action === "block") return { block: true, reason: dspResult.decision.reason };
			if (decision?.action === "block") return { block: true, reason: decision.reason };
			const gated = isChild ? undefined : await evidenceGate(command, ctx, startsElsewhere, !dsp);
			if (gated?.reason) return { block: true, reason: gated.reason };
			let audit: { backups: string[] } | undefined;
			if (dspResult) {
				const settled = await settleDsp(dspResult, command, commandCwd, ctx);
				if ("block" in settled) return { block: true, reason: settled.block };
				if (settled.autoAllowed) audit = { backups: settled.backups };
				remoteApproved = settled.remoteApproved;
			} else if (decision?.action === "confirm") {
				const ok = await confirm(ctx, `brigadev: ${decision.reason}`, `${commandPreview(command)}\n\nRun it?`);
				if (!ok) return { block: true, reason: `User declined: ${decision.reason}` };
			}
			// Every rule allowed the commit: only now is the user's force spent and logged.
			gated?.settle();
			if (dspResult && audit) await recordAudit(dspResult, command, commandCwd, ctx, audit.backups);

			// The command will run: remember the tree so tool_result can see what it changed.
			if (surfaces) {
				const snapshot = await takeSnapshot(exec, projectRoot(ctx));
				if (snapshot) beforeBash.set(event.toolCallId, snapshot);
			}
			// Files the command writes outside the project by literal name: stamped now, recorded in tool_result if it created or changed them.
			if (event.toolName === "bash") {
				try {
					const targets = bashOutsideTargets(command, commandCwd, { projectRoot: projectRoot(ctx), docsDir: () => repoDocsDir(ctx.cwd), tempRoots: tempDirs(), secureDirs: secureDirs(), dsp, home: homedir() });
					if (targets.length > 0) pendingBash.set(event.toolCallId, changedSince(targets));
				} catch {
					// Tracking never decides whether a command runs.
				}
			}
			// S10, last: every rule above decided allow. Only an exact call the user approved in the remote dialog runs unlocked.
			// A child launched in DSP has no dialog to approve with: its calls are always locked.
			if ((dsp && !remoteApproved) || lockedChild) lockCall(event.toolName, event.toolCallId, event.input);
			return undefined;
		}

		const isWrite = isToolCallEventType("write", event) || isToolCallEventType("edit", event);
		const isRead = isToolCallEventType("read", event);
		if (!isWrite && !isRead) return undefined;

		const rawPath = String((event.input as { path?: unknown }).path ?? "");
		if (!rawPath) return undefined;
		const absolute = canonicalPath(resolve(ctx.cwd, expandHome(rawPath)));
		const blocked = await checkPath(event.toolName, rawPath, absolute, isWrite, ctx);
		if (!blocked && isWrite && !isChild) {
			const why = outsideWhy(absolute, { projectRoot: projectRoot(ctx), docsDir: () => repoDocsDir(ctx.cwd), tempRoots: tempDirs(), secureDirs: secureDirs(), dsp: inDsp() });
			if (why) pendingOutside.set(event.toolCallId, { tool: event.toolName, path: absolute, why });
		}
		return blocked;
	});

	pi.on("tool_result", async (event, ctx) => {
		const outsideWrite = pendingOutside.get(event.toolCallId);
		if (outsideWrite) {
			pendingOutside.delete(event.toolCallId);
			if (!event.isError) {
				try {
					appendOutsideWrite(outsideWritesFile(repoDocsDir(ctx.cwd)), { ts: new Date().toISOString(), ...outsideWrite });
				} catch {
					// The ledger is a record, not a gate.
				}
			}
		}
		const bashWrites = pendingBash.get(event.toolCallId);
		if (bashWrites) {
			pendingBash.delete(event.toolCallId);
			// A failed command can still have written files: the stamps decide, not the exit status.
			try {
				const agent = isChild ? process.env[CHILD_ENV.AGENT] : undefined;
				const file = outsideWritesFile(repoDocsDir(ctx.cwd));
				for (const { path, why } of bashWrites()) appendOutsideWrite(file, { ts: new Date().toISOString(), tool: "bash", path, why, ...(agent ? { agent } : {}) });
			} catch {
				// The ledger is a record, not a gate.
			}
		}
		const before = beforeBash.get(event.toolCallId);
		if (!before) return undefined;
		beforeBash.delete(event.toolCallId);
		const surfaces = writerSurfaces();
		if (!surfaces) return undefined;
		const after = await takeSnapshot(exec, projectRoot(ctx));
		if (!after) return undefined;
		const outside = outsideSurfaces(diffSnapshots(before, after), surfaces);
		if (outside.length === 0) return undefined;
		const notice = `[brigadev guard] This command changed files outside your allowed edit surfaces: ${outside.join(", ")}. Do not change files through bash; report these paths to the parent.`;
		return { content: [...event.content, { type: "text" as const, text: notice }], isError: true };
	});

	if (isChild) return;

	pi.registerCommand("brigadev:outside", {
		description: "List the files this repo's sessions wrote outside the project (temp dir, secure-yolo folders, granted folders, repo docs)",
		handler: async (_args, ctx) => {
			const file = outsideWritesFile(repoDocsDir(ctx.cwd));
			ctx.ui.notify(`${formatOutsideWrites(readOutsideWrites(file))}\nLedger: ${file}`, "info");
		},
	});

	pi.registerCommand("brigadev:yolo-dir", {
		description: "Secure-yolo folders, where write/edit outside the project run without asking: list | add <folder> | remove <folder>",
		getArgumentCompletions: (prefix) => {
			const items = ["list", "add ", "remove "].filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value.trim() }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const message = runYoloDirCommand(args, { read: readSettings, write: writeSettings }, { ...secureGuard(), tempRoots: tempDirs() });
			ctx.ui.notify(message, message.startsWith("brigadev: refused") ? "error" : "info");
		},
	});

	pi.registerCommand("brigadev:force-commit", {
		description: "Let the next git commit on the current working tree pass the evidence gate (one-shot; edits cancel it)",
		handler: async (_args, ctx) => {
			const result = await worktreeTreeResult(projectRoot(ctx));
			if (result.kind === "no-git") return ctx.ui.notify("brigadev: not a git working tree, so the evidence gate does not apply", "error");
			if (result.kind === "error") {
				return ctx.ui.notify(`brigadev: the working tree could not be computed (${result.reason}), so a force cannot be bound to it. Use the dialog the guard shows when the commit is blocked, or fix git and try again.`, "error");
			}
			forcedTree = result.tree;
			ctx.ui.notify("brigadev: the next commit of the current working tree skips the evidence gate. Editing any file first cancels this.", "info");
		},
	});

	pi.registerCommand("brigadev:mode", {
		description: "Permission mode: normal | yolo | dsp | default <normal|yolo|dsp> | status",
		getArgumentCompletions: (prefix) => {
			const items = ["normal", "yolo", "dsp", "status", "default normal", "default yolo", "default dsp"].map((value) => ({ value, label: value }));
			const filtered = items.filter((i) => i.value.startsWith(prefix));
			return filtered.length > 0 ? filtered : null;
		},
		handler: async (args, ctx) => {
			const [first, second] = args.trim().split(/\s+/).filter(Boolean);
			/** DSP takes one confirmation dialog, and needs a UI to show it. */
			const enterDsp = async (): Promise<void> => {
				if (mode === PERMISSION_MODE.DSP) return void ctx.ui.notify("brigadev: already in DSP mode", "info");
				const problem = dspShellProblem({ cwd: ctx.cwd });
				if (problem) return void ctx.ui.notify(`brigadev: DSP refused. ${problem}`, "error");
				if (!ctx.hasUI) return void ctx.ui.notify("brigadev: DSP needs a UI to confirm the switch, so the mode was not changed.", "error");
				if (!(await ctx.ui.confirm(`brigadev: switch to ${MODE_LABEL.dsp}?`, DSP_SWITCH_BODY))) return void ctx.ui.notify("brigadev: mode unchanged", "info");
				setMode(PERMISSION_MODE.DSP, ctx);
				ctx.ui.notify("⚠ DSP on: local commands run without asking; remote actions and default-branch changes still always ask.", "warning");
			};
			if (first === "default") {
				if (!isPermissionMode(second)) return ctx.ui.notify("Usage: /brigadev:mode default <normal|yolo|dsp>", "error");
				writeSettings({ defaultMode: second });
				return ctx.ui.notify(second === PERMISSION_MODE.DSP ? "⚠ brigadev: new sessions start in DSP mode (local commands run without asking; remote actions still ask)" : `brigadev: new sessions start in ${second} mode`, second === PERMISSION_MODE.DSP ? "warning" : "info");
			}
			if (first === PERMISSION_MODE.DSP) return enterDsp();
			if (isPermissionMode(first)) {
				setMode(first, ctx);
				return ctx.ui.notify(first === PERMISSION_MODE.YOLO ? "🚀 YOLO on: commits, pushes, and PRs run without asking; destructive commands still ask." : "brigadev: normal mode", "info");
			}
			if (!first && ctx.hasUI) {
				const choice = await ctx.ui.select(`brigadev permission mode (current: ${mode})`, [PERMISSION_MODE.NORMAL, PERMISSION_MODE.YOLO, MODE_LABEL.dsp]);
				if (choice === MODE_LABEL.dsp) return enterDsp();
				if (isPermissionMode(choice)) setMode(choice, ctx);
				return;
			}
			const saved = readSettings().defaultMode ?? PERMISSION_MODE.NORMAL;
			ctx.ui.notify(`brigadev mode: ${mode} (default for new sessions: ${saved})${mode === PERMISSION_MODE.DSP ? `\n${dspStatusLine()}` : ""}`, "info");
		},
	});
}
