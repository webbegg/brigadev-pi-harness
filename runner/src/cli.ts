// brigadev-runner CLI.
//   start <feature-doc> [--no-pr]   validate the doc, then run its ticket list durably, then the PR loop (push, PR, CI, fixes, merge approval);
//                                   `--no-pr` stops after the tickets. Returns when the loop ends or parks on a person
//   status <feature-doc>            read-only: the loop's state, each ticket's status, open decisions with the exact answer command
//   answer <feature-doc> <T#> <1..n|text> [--approve]   answer a parked ticket decision (--approve also approves its command)
//   pause <feature-doc>             pause at the next pick;  resume <feature-doc>   lift a pause (or a PR loop stop)
//   merge <feature-doc>             approve the merge of the PR the PR loop opened (it re-checks the PR before merging)
// Exit codes: 0 loop done / signal delivered; 1 refused, failed, paused, stalled, parked, or a final signal answer (duplicate, closed, not_found);
// 2 usage or an invalid answer.
//
// One process per store (pi-durable's rule: one writer per storage). `answer`, `pause`, and `resume` open a short-lived Harness that delivers one
// signal and closes before anything is scheduled, and they refuse while a `start` holds the store (`runner.sqlite.lock`): a second Harness opening
// the store would mark the first one's running tasks as crashed. `start` therefore returns when the loop parks on a person, instead of waiting in
// the foreground for an answer it could not see; run it again after answering.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { onFeatureBranch, readBranchFacts } from "../../lib/commit-branch.ts";
import { canonicalPath } from "../../lib/paths.ts";
import { repoDocsDir, repoName } from "../../lib/repo-docs.ts";
import { hardenGitEnv } from "./contain.ts";
import { answerDecision, mergeLoop, pauseLoop, resumeLoop, statusText, type ControlResult } from "./control.ts";
import { validateDoc } from "./doc.ts";
import { nodeExec } from "./exec.ts";
import { LoopStartedDifferently } from "./errors.ts";
import type { Runner } from "./runner.ts";
import { answerCommand, mergeCommand } from "./signals.ts";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const USAGE = [
	"usage: brigadev-runner start <feature-doc> [--no-pr]",
	"       brigadev-runner status <feature-doc>",
	"       brigadev-runner answer <feature-doc> <T#> <1..n|text> [--approve]",
	"       brigadev-runner pause <feature-doc>",
	"       brigadev-runner resume <feature-doc>",
	"       brigadev-runner merge <feature-doc>",
].join("\n");

export interface Io {
	out(text: string): void;
	err(text: string): void;
}

type Env = Record<string, string | undefined>;

/** Next to the repo's other harness documents (`<brigadev home>/<repo>/`), so every worktree of the repo shares one store. */
export const storePathFor = (cwd: string, env: Env = process.env): string => join(repoDocsDir(cwd, env), "runner.sqlite");

// ---------------------------------------------------------------------------------------------------------------------
// The store lock: one `start` per store, and no control command while it runs

// B4: the lock is an OS lock that dies with its process, not a file a stale-removal race can take twice. `<store>.lock` is an SQLite database held in one
// `BEGIN EXCLUSIVE` transaction with `locking_mode=EXCLUSIVE` and no busy timeout, from `acquireStore` until the release (or the process's death, which releases it:
// there is no stale lock to take over). The holder's pid is written to `<store>.lock.pid` after the lock is held, for messages only.
const lockPathOf = (storePath: string) => `${storePath}.lock`;
const pidPathOf = (storePath: string) => `${storePath}.lock.pid`;
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
};

/** Locks this process holds, by store path: not re-entrant (one open of the store per lock). */
const heldHere = new Map<string, DatabaseSync>();

const isBusy = (error: unknown) => /locked|busy/i.test(error instanceof Error ? error.message : String(error));

/** The pid in the side file when that process is alive, else -1 (locked, holder unknown: it has just taken the lock, or the file is stale). */
function pidOnFile(storePath: string): number {
	try {
		const pid = Number(readFileSync(pidPathOf(storePath), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : -1;
	} catch {
		return -1;
	}
}

/** Open the lock database and take its exclusive lock now, or undefined when another process (or this one) holds it. */
function takeLock(storePath: string, legacyChecked = false): DatabaseSync | undefined {
	const db = new DatabaseSync(lockPathOf(storePath));
	try {
		db.exec("PRAGMA busy_timeout=0");
		db.exec("PRAGMA locking_mode=EXCLUSIVE");
		db.exec("BEGIN EXCLUSIVE");
		return db;
	} catch (error) {
		try {
			db.close();
		} catch {
			// Closing a connection that never held the lock cannot release anyone else's.
		}
		if (isBusy(error)) return undefined;
		// A pid file left by the earlier lock (a number, not a database): its process is long gone, or `start` was upgraded under it. Replace it once.
		if (!legacyChecked && /not a database/i.test(error instanceof Error ? error.message : String(error))) {
			rmSync(lockPathOf(storePath), { force: true });
			return takeLock(storePath, true);
		}
		throw error;
	}
}

/** The pid of the process holding the store (-1 when it holds it but its pid is not known yet), or undefined when nobody does. */
export function lockHolder(storePath: string): number | undefined {
	if (heldHere.has(storePath)) return process.pid;
	if (!existsSync(lockPathOf(storePath))) return undefined;
	const probe = takeLock(storePath);
	if (probe) {
		try {
			probe.exec("ROLLBACK");
		} finally {
			probe.close();
		}
		return undefined;
	}
	return pidOnFile(storePath);
}

/** Take the store for this process; returns the holder's pid (-1: unknown) instead when another process has it, else a release function (idempotent). */
export function acquireStore(storePath: string): number | (() => void) {
	mkdirSync(dirname(storePath), { recursive: true });
	// This process holds it already: the lock is not re-entrant.
	if (heldHere.has(storePath)) return process.pid;
	const db = takeLock(storePath);
	if (!db) return pidOnFile(storePath);
	heldHere.set(storePath, db);
	try {
		writeFileSync(pidPathOf(storePath), String(process.pid));
	} catch {
		// The pid is for messages: the lock is held either way.
	}
	let released = false;
	return () => {
		if (released) return;
		released = true;
		heldHere.delete(storePath);
		try {
			db.exec("ROLLBACK");
		} catch {
			// Closing the connection releases the lock all the same.
		}
		db.close();
		try {
			if (readFileSync(pidPathOf(storePath), "utf8").trim() === String(process.pid)) rmSync(pidPathOf(storePath), { force: true });
		} catch {
			// No pid file: nothing to remove.
		}
	};
}

const holderText = (pid: number) => (pid > 0 ? `pid ${pid}` : "another process");

/**
 * Q5: the runner never shares a checkout or a branch with a live Pi session, and never commits on the default branch. It starts only in
 * a linked git worktree (git dir differs from the common dir) on a branch that is not the default or a protected one.
 * Returns the refusal, or undefined when `cwd` qualifies.
 */
export async function worktreeRefusal(cwd: string): Promise<string | undefined> {
	const how = `Create one and run from there:\n  git worktree add ../${repoName(cwd)}-runner -b <branch>`;
	const dirs = await nodeExec("git", ["rev-parse", "--git-dir", "--git-common-dir"], { cwd, timeout: 10_000 });
	const [gitDir, commonDir] = dirs.stdout.trim().split("\n");
	if (dirs.code !== 0 || !gitDir || !commonDir) return `Refusing to run: ${cwd} is not a git repository. The runner works in its own git worktree on a feature branch. ${how}`;
	if (canonicalPath(resolve(cwd, gitDir)) === canonicalPath(resolve(cwd, commonDir))) {
		return `Refusing to run: ${cwd} is not a linked git worktree. The runner needs its own worktree, so it never shares a checkout or a branch with a live Pi session. ${how}`;
	}
	const facts = await readBranchFacts(nodeExec, cwd);
	if (facts.currentBranch === null) return `Refusing to run: ${cwd} is on a detached HEAD. The runner commits on a feature branch. ${how}`;
	if (!onFeatureBranch(facts)) {
		return `Refusing to run: branch ${facts.currentBranch} is the default or a protected branch (or the repository's default branch cannot be determined: see \`git remote set-head origin <branch>\`). The runner never commits there. ${how}`;
	}
	return undefined;
}

/**
 * Run the loop for a doc until it ends or parks. Parked (asleep on a decision or a pause, nothing runnable): print where it waits and how to
 * answer, and return 1; the loop continues from storage the next time `start` runs.
 */
export async function startLoop(runner: Runner, docPath: string, io: Io, options: { pr?: boolean } = {}): Promise<number> {
	let id: Awaited<ReturnType<Runner["start"]>>;
	try {
		id = await runner.start(docPath, { pr: options.pr === true });
	} catch (error) {
		// B5: the loop exists with other options; nothing was started.
		if (!(error instanceof LoopStartedDifferently)) throw error;
		io.err(`Refusing to start: ${error.message}`);
		return 1;
	}
	const outcome = await runner.settle(id);
	io.out(JSON.stringify(outcome, null, 2));
	if (outcome.status === "waiting") {
		const status = await runner.status(id);
		for (const decision of [...status.decisions, ...(status.pr?.decisions ?? [])]) io.out(`${decision.ticketId} needs a decision: ${answerCommand(docPath, decision.ticketId)}`);
		if (outcome.paused !== undefined) io.out(`paused: ${outcome.paused}. Resume with: brigadev-runner resume ${docPath}`);
		if (status.pr) io.out(`PR loop: ${status.pr.phase}${status.pr.url ? ` ${status.pr.url}` : ""}`);
		if (status.pr?.mergeKey !== undefined) io.out(`Ready to merge. Approve with: ${mergeCommand(docPath)}`);
		if (status.pr?.resumeKey !== undefined) io.out(`needs you: ${status.pr.reason}. Resume with: brigadev-runner resume ${docPath}`);
		io.out(`Parked, nothing is running. After answering, then run \`brigadev-runner start ${docPath}\` again: the loop continues from storage.`);
		return 1;
	}
	return outcome.status === "completed" && (outcome.result.status === "done" || outcome.result.status === "merged") ? 0 : 1;
}

async function loadRunnerModules() {
	const [{ createModels }, { openNodeSqliteStorage }, { openRunner }] = await Promise.all([
		import("@earendil-works/pi-ai/models"),
		import("@earendil-works/pi-durable/storage/sqlite/node"),
		import("./runner.ts"),
	]);
	return { createModels, openNodeSqliteStorage, openRunner };
}

/** `status`, `answer`, `pause`, `resume`, `merge`: no worker, no API key, no scheduling. */
async function control(command: string, args: string[], env: Env, io: Io, cwd: string): Promise<number> {
	const approve = args.includes("--approve");
	const positional = args.filter((arg) => arg !== "--approve");
	const [docArg, ticketId, ...words] = positional;
	const choice = words.join(" ").trim();
	if (!docArg || (command === "answer" ? !ticketId || !choice : positional.length > 1) || (approve && command !== "answer")) {
		io.err(USAGE);
		return 2;
	}
	const docPath = resolve(cwd, docArg);
	let text: string;
	try {
		text = readFileSync(docPath, "utf8");
	} catch (error) {
		io.err(`cannot read ${docPath}: ${(error as Error).message}`);
		return 1;
	}
	if (command !== "status") {
		const errors = validateDoc(text);
		if (errors.length > 0) {
			io.err(`${docPath} cannot run unattended:`);
			for (const error of errors) io.err(`- ${error}`);
			return 1;
		}
	}

	const storePath = storePathFor(cwd, env);
	if (!existsSync(storePath)) {
		io.err(`no runner state for ${docPath} (${storePath} does not exist); run \`brigadev-runner start ${docPath}\``);
		return 1;
	}
	// A writing command holds the lock while it has the store open, so a `start` cannot open it meanwhile either.
	let release: (() => void) | undefined;
	if (command !== "status") {
		const held = acquireStore(storePath);
		if (typeof held === "number") {
			io.err(`a \`brigadev-runner start\` is running on this store (${holderText(held)}). \`${command}\` opens the store too, which is unsafe beside it: wait until \`start\` parks or ends, or stop it, then run \`${command}\` again.`);
			return 1;
		}
		release = held;
	}
	try {
		return await runControl(command, { cwd, env, io, storePath, docPath, ticketId, choice, approve });
	} finally {
		release?.();
	}
}

async function runControl(
	command: string,
	{ cwd, env, io, storePath, docPath, ticketId, choice, approve }: { cwd: string; env: Env; io: Io; storePath: string; docPath: string; ticketId: string; choice: string; approve: boolean },
): Promise<number> {

	const { createModels, openNodeSqliteStorage, openRunner } = await loadRunnerModules();
	const runner = await openRunner({
		storage: await openNodeSqliteStorage(storePath),
		models: createModels(), // no provider: these commands never call a model
		cwd,
		model: { provider: "anthropic", modelId: env.BRIGADEV_RUNNER_MODEL || DEFAULT_MODEL },
		readOnly: command === "status",
		onReport: (report) => io.err(`report: ${report.kind}: ${(report.error as Error | undefined)?.message ?? ""}`),
	});
	try {
		let result: ControlResult;
		if (command === "status") result = await statusText(runner, docPath);
		else if (command === "answer") result = await answerDecision(runner, docPath, ticketId, choice, { approve });
		else if (command === "pause") result = await pauseLoop(runner, docPath);
		else if (command === "merge") result = await mergeLoop(runner, docPath);
		else result = await resumeLoop(runner, docPath);
		(result.code === 0 ? io.out : io.err)(result.text);
		return result.code;
	} finally {
		await runner.close();
	}
}

export async function main(args: string[], env: Env = process.env, io: Io = { out: console.log, err: console.error }, cwd = process.cwd()): Promise<number> {
	const [command, ...rest] = args;
	if (command === "status" || command === "answer" || command === "pause" || command === "resume" || command === "merge") return control(command, rest, env, io, cwd);

	const noPr = rest.includes("--no-pr");
	const [docArg, ...extra] = rest.filter((arg) => arg !== "--no-pr");
	if (command !== "start" || !docArg || extra.length > 0) {
		io.err(USAGE);
		return 2;
	}
	const docPath = resolve(cwd, docArg);
	let text: string;
	try {
		text = readFileSync(docPath, "utf8");
	} catch (error) {
		io.err(`cannot read ${docPath}: ${(error as Error).message}`);
		return 1;
	}

	// S1: a doc that is not an approved, runnable ticket list never starts.
	const errors = validateDoc(text);
	if (errors.length > 0) {
		io.err(`${docPath} cannot run unattended:`);
		for (const error of errors) io.err(`- ${error}`);
		return 1;
	}

	const refusal = await worktreeRefusal(cwd);
	if (refusal) {
		io.err(refusal);
		return 1;
	}
	if (!env.ANTHROPIC_API_KEY) {
		io.err("ANTHROPIC_API_KEY is not set.");
		return 1;
	}

	const [{ createModels }, { anthropicProvider }, { openNodeSqliteStorage }, { openRunner }] = await Promise.all([
		import("@earendil-works/pi-ai/models"),
		import("@earendil-works/pi-ai/providers/anthropic"),
		import("@earendil-works/pi-durable/storage/sqlite/node"),
		import("./runner.ts"),
	]);
	const models = createModels();
	models.setProvider(anthropicProvider());
	const storePath = storePathFor(cwd, env);
	if (!existsSync(dirname(storePath))) mkdirSync(dirname(storePath), { recursive: true });
	const held = acquireStore(storePath);
	if (typeof held === "number") {
		io.err(`another \`brigadev-runner start\` is running on this store (${holderText(held)}); one process per store.`);
		return 1;
	}
	try {
		const runner = await openRunner({
			storage: await openNodeSqliteStorage(storePath),
			models,
			cwd,
			model: { provider: "anthropic", modelId: env.BRIGADEV_RUNNER_MODEL || DEFAULT_MODEL },
			onReport: (report) => io.err(`report: ${report.kind}: ${(report.error as Error | undefined)?.message ?? ""}`),
		});
		try {
			return await startLoop(runner, docPath, io, { pr: !noPr });
		} finally {
			await runner.close();
		}
	} finally {
		held();
	}
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	// The runner's own git calls (the guard's branch facts, the commit gate's tree hash, the PR loop's push) read a repository config the agent may have edited:
	// no fsmonitor or hook program of it may run with the runner's credentials in reach.
	hardenGitEnv(process.env);
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		},
	);
}
