// brigadev-runner CLI.
//   start <feature-doc> [--no-pr] [--cap <dollars>] [--web [--port N] [--web-in-multiplexer]]
//                                   validate the doc, then run its ticket list durably, then the PR loop (push, PR, CI, fixes, merge approval);
//                                   `--no-pr` stops after the tickets. `--cap` sets the loop's cost cap (default $5, stored with the loop: see src/cost.ts). Returns when the loop ends or parks on a person. With `--web` it serves the loop board
//                                   (the web UI) on 127.0.0.1 instead and stays up while the loop waits for a person, on a terminal only: see below
//   status <feature-doc>            read-only: the loop's state, each ticket's status, open decisions with the exact answer command
//   answer <feature-doc> <T#> <1..n|text> [--approve]   answer a parked ticket decision (--approve also approves its command)
//   pause <feature-doc>             pause at the next pick;  resume <feature-doc> [--cap <dollars>]   lift a pause (or a PR loop stop); a stop at the cost cap needs --cap
//   merge <feature-doc>             approve the merge of the PR the PR loop opened (it re-checks the PR before merging)
// Exit codes: 0 loop done / signal delivered; 1 refused, failed, paused, stalled, parked, or a final signal answer (duplicate, closed, not_found);
// 2 usage or an invalid answer.
//
// One process per store (pi-durable's rule: one writer per storage). `answer`, `pause`, and `resume` open a short-lived Harness that delivers one
// signal and closes before anything is scheduled, and they refuse while a `start` holds the store (`runner.sqlite.lock`): a second Harness opening
// the store would mark the first one's running tasks as crashed. `start` therefore returns when the loop parks on a person, instead of waiting in
// the foreground for an answer it could not see; run it again after answering.
//
// `start --web` is the exception: the board answers inside the process that holds the store, through the same Harness (`src/board.ts`), so it does wait in the
// foreground. It prints a one-time link to stdout (and only there), exits when the loop ends, and on SIGINT/SIGTERM closes the board and the runner (the loop
// continues on the next `start`). Enter on the runner's own terminal prints a fresh link; nothing else does (no signal: any process of the user, the worker's bash
// included, could send one). `--web` therefore refuses unless stdin and stdout are both terminals (exit 2, before anything starts), and inside tmux, screen or zellij
// unless `--web-in-multiplexer` says so: a pane can be read (`capture-pane`) and typed into (`send-keys`) by any process of the user. It also refuses in the background of
// its terminal (`start --web &`): reading the terminal from there would stop the process (SIGTTIN) while it holds the store.
// (Ctrl-Z and `bg` later is the shell's own job control: the runner stops when it reads, and `fg` resumes it.)
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { onFeatureBranch, readBranchFacts } from "../../lib/commit-branch.ts";
import { canonicalPath } from "../../lib/paths.ts";
import { repoDocsDir, repoName } from "../../lib/repo-docs.ts";
import { serveBoard } from "./board.ts";
import { hardenGitEnv } from "./contain.ts";
import { dollars } from "./cost.ts";
import { answerDecision, mergeLoop, pauseLoop, resumeLoop, statusText, type ControlResult } from "./control.ts";
import { validateDoc } from "./doc.ts";
import { nodeExec } from "./exec.ts";
import { LoopStartedDifferently } from "./errors.ts";
import type { Runner } from "./runner.ts";
import { answerCommand, mergeCommand } from "./signals.ts";

// Node opens an unauthenticated inspector on 127.0.0.1 when the process gets SIGUSR1, unless a listener is installed. Any process of the user, the worker's
// own bash included (`kill -USR1 $PPID`), could then run code in the runner with the environment the containment keeps from the worker (tokens, the gh login).
// So the runner always holds a SIGUSR1 listener, from the moment this module loads; `npm start` also passes `--disable-sigusr1`.
if (process.platform !== "win32") process.on("SIGUSR1", () => {});

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const USAGE = [
	"usage: brigadev-runner start <feature-doc> [--no-pr] [--cap <dollars>] [--web [--port N] [--web-in-multiplexer]]",
	"         --cap <dollars> is the loop's cost cap (a positive number, default 5): at or over it the loop parks needs-you; continue with `resume <feature-doc> --cap <dollars>`",
	"         --web serves the loop board on 127.0.0.1 (port: --port or BRIGADEV_WEB_PORT, default: any free port) and stays up while the loop waits for you;",
	"         it needs stdin and stdout to be a terminal (the one-time link is printed there, a new one on Enter) and refuses inside tmux, screen or zellij",
	"         unless --web-in-multiplexer, and in the foreground of that terminal (not with `&`)",
	"       brigadev-runner status <feature-doc>",
	"       brigadev-runner answer <feature-doc> <T#> <1..n|text> [--approve]",
	"       brigadev-runner pause <feature-doc>",
	"       brigadev-runner resume <feature-doc> [--cap <dollars>]",
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

/** What a refusal says when a `start` holds the store: it may be serving the board, which answers inside that process. */
const boardHint = () =>
	" If that `start` was run with --web, use its board instead: it answers, pauses, resumes, and approves the merge in the running process (press Enter in its terminal for a new link).";

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

/** What `start --web` does besides running the loop: the board, how long it lingers, and how the process reaches it. */
export interface WebStart {
	/** 0 = any free port. */
	port: number;
	/** How long the board stays up after the loop ended, so an open page shows the last state (default 750 ms). */
	lingerMs?: number;
	debounceMs?: number;
	pollMs?: number;
	/** Stops the wait (SIGINT, SIGTERM): the board closes and the call returns 1 while the loop is left to continue from storage. */
	signal?: AbortSignal;
	/** Connects the requests for a fresh link (Enter on the terminal) to `newLink`; returns how to disconnect. */
	wire?: (newLink: () => void) => () => void;
}

/** 0 only for a loop that ended done or merged; stalled, a failed PR loop, a failed or aborted loop are 1. */
export const exitCodeOf = (outcome: Awaited<ReturnType<Runner["wait"]>>): number => (outcome.status === "completed" && (outcome.result.status === "done" || outcome.result.status === "merged") ? 0 : 1);

/**
 * `start --web`: the board first (so its link is printed before anything is scheduled), then the loop, and then wait for the loop to end, not for it to park: while it waits
 * for a person the board is the way to answer, and answering delivers through this process's Harness, so the loop wakes in it.
 */
async function startWithBoard(runner: Runner, docPath: string, io: Io, pr: boolean, web: WebStart, cap?: number): Promise<number> {
	let served: Awaited<ReturnType<typeof serveBoard>>;
	try {
		served = await serveBoard(runner, docPath, { port: web.port, debounceMs: web.debounceMs, pollMs: web.pollMs });
	} catch (error) {
		if ((error as NodeJS.ErrnoException)?.code === "EADDRINUSE") {
			io.err(`cannot start the board: port ${web.port} is already in use. Choose another with --port N (or BRIGADEV_WEB_PORT), or leave it out for any free port.`);
		} else {
			io.err(`cannot start the board: ${error instanceof Error ? error.message : String(error)}`);
		}
		return 1;
	}
	// The link goes to this process's stdout and nowhere else: not the store, a PR comment, the doc, or the Log.
	const newLink = () => io.out(`brigadev board: ${served.server.openUrl()} (one-time link, valid 60 s; press Enter in this terminal for a new one)`);
	newLink();
	const unwire = web.wire?.(newLink);
	try {
		let id: Awaited<ReturnType<Runner["start"]>>;
		try {
			id = await startWithCap(runner, docPath, io, { pr, cap });
		} catch (error) {
			if (!(error instanceof LoopStartedDifferently)) throw error;
			io.err(`Refusing to start: ${error.message}`);
			return 1;
		}
		const ended = runner.wait(id);
		ended.catch(() => {}); // the runner closes under it when the wait is interrupted
		const interrupted = new Promise<"interrupted">((resolve) => {
			if (web.signal?.aborted) resolve("interrupted");
			else web.signal?.addEventListener("abort", () => resolve("interrupted"), { once: true });
		});
		const outcome = await Promise.race([ended, interrupted]);
		if (outcome === "interrupted") {
			io.err(`interrupted: the board is closed and the loop is left where it is. Run \`brigadev-runner start ${docPath}\` to continue it from storage.`);
			return 1;
		}
		await served.board.refresh();
		if ((web.lingerMs ?? 750) > 0) await sleep(web.lingerMs ?? 750);
		io.out(JSON.stringify(outcome, null, 2));
		return exitCodeOf(outcome);
	} finally {
		unwire?.();
		await served.close();
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** `runner.start`, and with `--cap` a line on stdout saying what the loop's cap is now (and what it was, when this changed an existing loop's). */
async function startWithCap(runner: Runner, docPath: string, io: Io, options: { pr: boolean; cap?: number }): Promise<Awaited<ReturnType<Runner["start"]>>> {
	const existing = options.cap === undefined ? undefined : await runner.find(docPath);
	const before = existing === undefined ? undefined : (await runner.status(existing)).cost;
	const id = await runner.start(docPath, { pr: options.pr, ...(options.cap === undefined ? {} : { cap: options.cap }) });
	if (options.cap !== undefined) {
		const now = (await runner.status(id)).cost;
		io.out(before && now && before.cap !== now.cap ? `cost cap changed: ${dollars(before.cap)} → ${dollars(now.cap)} (spent ${dollars(now.spent)})` : `cost cap: ${dollars(options.cap)}${before ? ` (unchanged; spent ${dollars(before.spent)})` : ""}`);
	}
	return id;
}

/** The process as `wireLinkRequests` uses it (tests pass a fake). It has no signals: a fresh link is never asked for by one. */
export interface LinkHost {
	stdin?: { isTTY?: boolean; on(event: "data", listener: () => void): unknown; off(event: "data", listener: () => void): unknown; resume(): unknown; pause(): unknown };
}

/**
 * A fresh one-time link on Enter when stdin is a terminal (a pipe is never read: it may be a script's), and on nothing else. In particular not on SIGUSR1 (H1): any
 * process of the user can send it, the worker's bash included, and it could then read the link where the runner prints it. The module-level SIGUSR1 listener above only
 * keeps the inspector closed. Returns how to release the wiring.
 */
export function wireLinkRequests(newLink: () => void, host: LinkHost = process as unknown as LinkHost): () => void {
	const stdin = host.stdin;
	const onData = () => newLink();
	const reading = stdin?.isTTY === true;
	if (reading) {
		stdin!.on("data", onData);
		stdin!.resume();
	}
	return () => {
		if (reading) {
			stdin!.off("data", onData);
			stdin!.pause();
		}
	};
}

/** The process as `watchInterrupt` uses it. */
export interface SignalHost {
	on(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
	off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
}

/**
 * SIGINT and SIGTERM abort the returned signal, once: the handlers are removed at the first, so a second signal while the runner closes takes the default (the
 * process ends). `dispose` removes them without a signal.
 */
export function watchInterrupt(host: SignalHost = process): { signal: AbortSignal; dispose(): void } {
	const controller = new AbortController();
	const dispose = () => {
		host.off("SIGINT", stop);
		host.off("SIGTERM", stop);
	};
	const stop = () => {
		dispose();
		controller.abort();
	};
	host.on("SIGINT", stop);
	host.on("SIGTERM", stop);
	return { signal: controller.signal, dispose };
}

/**
 * Run the loop for a doc until it ends or parks. Parked (asleep on a decision or a pause, nothing runnable): print where it waits and how to
 * answer, and return 1; the loop continues from storage the next time `start` runs. With `web`, serve the board and wait for the loop to end instead (see `startWithBoard`).
 */
export async function startLoop(runner: Runner, docPath: string, io: Io, options: { pr?: boolean; web?: WebStart; cap?: number } = {}): Promise<number> {
	if (options.web) return startWithBoard(runner, docPath, io, options.pr === true, options.web, options.cap);
	let id: Awaited<ReturnType<Runner["start"]>>;
	try {
		id = await startWithCap(runner, docPath, io, { pr: options.pr === true, cap: options.cap });
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
		if (outcome.paused !== undefined) io.out(`paused: ${outcome.paused}. Resume with: brigadev-runner resume ${docPath}${status.kind === "cost" ? " --cap <dollars>" : ""}`);
		if (status.pr) io.out(`PR loop: ${status.pr.phase}${status.pr.url ? ` ${status.pr.url}` : ""}`);
		if (status.pr?.mergeKey !== undefined) io.out(`Ready to merge. Approve with: ${mergeCommand(docPath)}`);
		if (status.pr?.resumeKey !== undefined) io.out(`needs you: ${status.pr.reason}. Resume with: brigadev-runner resume ${docPath}${status.pr.costCap ? " --cap <dollars>" : ""}`);
		io.out(`Parked, nothing is running. After answering, then run \`brigadev-runner start ${docPath}\` again: the loop continues from storage.`);
		return 1;
	}
	return exitCodeOf(outcome);
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
	// `--cap` is a flag of `resume` only: an answer's words may contain it (as before the cap), and elsewhere it stays positional, a usage error.
	const flagless = args.filter((arg) => arg !== "--approve");
	const capped = command === "resume" ? takeCap(flagless) : { rest: flagless, cap: undefined, bad: false };
	const positional = capped.rest;
	const cap = capped.cap;
	const [docArg, ticketId, ...words] = positional;
	const choice = words.join(" ").trim();
	if (!docArg || (command === "answer" ? !ticketId || !choice : positional.length > 1) || (approve && command !== "answer") || capped.bad || (cap !== undefined && command !== "resume")) {
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
			io.err(`a \`brigadev-runner start\` is running on this store (${holderText(held)}). \`${command}\` opens the store too, which is unsafe beside it: wait until \`start\` parks or ends, or stop it, then run \`${command}\` again.${boardHint()}`);
			return 1;
		}
		release = held;
	}
	try {
		return await runControl(command, { cwd, env, io, storePath, docPath, ticketId, choice, approve, cap });
	} finally {
		release?.();
	}
}

async function runControl(
	command: string,
	{ cwd, env, io, storePath, docPath, ticketId, choice, approve, cap }: { cwd: string; env: Env; io: Io; storePath: string; docPath: string; ticketId: string; choice: string; approve: boolean; cap?: number },
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
		else result = await resumeLoop(runner, docPath, undefined, cap === undefined ? {} : { cap });
		(result.code === 0 ? io.out : io.err)(result.text);
		return result.code;
	} finally {
		await runner.close();
	}
}

/** A dollar amount for `--cap`: a positive number written as digits with an optional fraction (no sign, exponent, or `Infinity`), else undefined. */
const capOf = (text: string | undefined): number | undefined => (text !== undefined && /^(\d+\.?\d*|\.\d+)$/.test(text) && Number(text) > 0 && Number.isFinite(Number(text)) ? Number(text) : undefined);

/** `--cap <dollars>` or `--cap=<dollars>` out of `args`; `bad` when the amount is missing or not a positive number. */
function takeCap(args: string[]): { rest: string[]; cap?: number; bad: boolean } {
	const rest: string[] = [];
	let cap: number | undefined;
	let bad = false;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--cap" || arg.startsWith("--cap=")) {
			cap = capOf(arg === "--cap" ? args[++i] : arg.slice("--cap=".length));
			if (cap === undefined) bad = true;
		} else rest.push(arg);
	}
	return { rest, ...(cap === undefined ? {} : { cap }), bad };
}

/** A port number from 0 to 65535 written as digits, else undefined. */
const portOf = (text: string): number | undefined => (/^\d{1,5}$/.test(text) && Number(text) <= 65535 ? Number(text) : undefined);

/** `start`'s arguments: the doc and anything unknown stay positional (so an unknown flag is a usage error as before); `bad` is a `--port` without a valid number. */
function parseStartArgs(all: string[]): { positional: string[]; noPr: boolean; web: boolean; inMultiplexer: boolean; port?: number; cap?: number; bad: boolean } {
	const { rest, cap, bad: badCap } = takeCap(all);
	const positional: string[] = [];
	let noPr = false;
	let web = false;
	let inMultiplexer = false;
	let port: number | undefined;
	let bad = badCap;
	for (let i = 0; i < rest.length; i += 1) {
		const arg = rest[i];
		if (arg === "--no-pr") noPr = true;
		else if (arg === "--web") web = true;
		else if (arg === "--web-in-multiplexer") inMultiplexer = true;
		else if (arg === "--port" || arg.startsWith("--port=")) {
			const value = arg === "--port" ? rest[++i] : arg.slice("--port=".length);
			port = value === undefined ? undefined : portOf(value);
			if (port === undefined) bad = true;
		} else positional.push(arg);
	}
	return { positional, noPr, web, inMultiplexer, ...(port === undefined ? {} : { port }), ...(cap === undefined ? {} : { cap }), bad };
}

/** Whether the process's stdin and stdout are terminals, and whether it is in the background of its terminal (tests pass their own). */
export interface Terminal {
	stdinIsTTY: boolean;
	stdoutIsTTY: boolean;
	/** Asked only by `--web`, once, after the terminal checks. Absent: not in the background. */
	inBackground?: () => boolean;
}

/** A process's own group and the foreground group of its controlling terminal (`tpgid`: 0, -1, or absent when it has none). */
export interface GroupFacts {
	pgid: number;
	tpgid: number;
}

/** R4-003: in the background when both groups are known and the terminal's foreground group is another one. Not knowing is not a reason to refuse. */
export const isBackground = (facts: GroupFacts | undefined): boolean => facts !== undefined && facts.pgid > 0 && facts.tpgid > 0 && facts.pgid !== facts.tpgid;

/** `pgrp` and `tpgid` from the text of /proc/<pid>/stat: `pid (comm) state ppid pgrp session tty_nr tpgid ...`; `comm` may hold spaces and `)`, so the fields start after the last one. */
export function parseProcStat(stat: string): GroupFacts | undefined {
	const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
	const [pgid, tpgid] = [Number(fields[2]), Number(fields[5])];
	return stat.includes(")") && Number.isInteger(pgid) && Number.isInteger(tpgid) ? { pgid, tpgid } : undefined;
}

/** `pgid` and `tpgid` from the output of `ps -o pgid=,tpgid= -p <pid>`. */
export function parsePsGroups(output: string): GroupFacts | undefined {
	const match = /^\s*(-?\d+)\s+(-?\d+)\s*$/.exec(output);
	return match ? { pgid: Number(match[1]), tpgid: Number(match[2]) } : undefined;
}

/** The groups of `pid`, from /proc where there is one (Linux) and from `ps` elsewhere (macOS); undefined when neither tells (then `--web` is not refused for it). Runs once, at start-up. */
export function readGroupFacts(pid: number): GroupFacts | undefined {
	try {
		const facts = parseProcStat(readFileSync(`/proc/${pid}/stat`, "utf8"));
		if (facts) return facts;
	} catch {
		// No /proc.
	}
	try {
		return parsePsGroups(execFileSync("ps", ["-o", "pgid=,tpgid=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 2_000 }));
	} catch {
		return undefined;
	}
}

const processTerminal = (): Terminal => ({
	stdinIsTTY: process.stdin.isTTY === true,
	stdoutIsTTY: process.stdout.isTTY === true,
	inBackground: () => isBackground(readGroupFacts(process.pid)),
});

/** R4-003: why `--web` cannot run in a background job. */
const BACKGROUND_REFUSAL =
	"--web must run in the foreground of its terminal: this process is in a background job (`&`, or sent there). Reading the terminal from a background job stops the process (SIGTTIN), and it would sit suspended with the loop half done and the store held, and the board's link would be gone with it. Run it without `&`, or bring it back with `fg`.";

/** The terminal multiplexers a process can tell it runs in, by the variable each one sets (any non-empty value: zellij sets `ZELLIJ=0`). */
const MULTIPLEXERS: ReadonlyArray<{ variable: string; name: string }> = [
	{ variable: "TMUX", name: "tmux" },
	{ variable: "STY", name: "screen" },
	{ variable: "ZELLIJ", name: "zellij" },
];

const multiplexerOf = (env: Env): { variable: string; name: string } | undefined => MULTIPLEXERS.find(({ variable }) => (env[variable] ?? "") !== "");

/** H2: why `--web` cannot run without a terminal on both ends, or undefined. */
function terminalRefusal(terminal: Terminal): string | undefined {
	if (terminal.stdinIsTTY && terminal.stdoutIsTTY) return undefined;
	const which = !terminal.stdinIsTTY && !terminal.stdoutIsTTY ? "stdin and stdout are not terminals" : !terminal.stdinIsTTY ? "stdin is not a terminal" : "stdout is not a terminal";
	return `--web needs a terminal: ${which}. The board's one-time link is printed only on the runner's own terminal and a new one comes only from Enter there; a pipe, a file, or a service's log can be read by other processes of yours, the worker's bash included, which could then sign in and answer for you. Run it from an interactive terminal, or without --web.`;
}

/** H3: `--web` inside tmux, screen or zellij, without the override. */
function multiplexerRefusal(found: { variable: string; name: string }): string {
	return `--web does not run inside a terminal multiplexer (${found.variable} is set, so this is ${found.name}). A pane can be read (\`capture-pane\`) and typed into (\`send-keys\`) by any process of your user, the worker's bash included, and the board's one-time link and the Enter that asks for a new one are on that pane. Run it in a plain terminal window, or pass --web-in-multiplexer to accept that.`;
}

export async function main(args: string[], env: Env = process.env, io: Io = { out: console.log, err: console.error }, cwd = process.cwd(), terminal: Terminal = processTerminal()): Promise<number> {
	const [command, ...rest] = args;
	if (command === "status" || command === "answer" || command === "pause" || command === "resume" || command === "merge") return control(command, rest, env, io, cwd);

	const parsed = parseStartArgs(rest);
	const [docArg, ...extra] = parsed.positional;
	if (command !== "start" || !docArg || extra.length > 0 || parsed.bad || (parsed.port !== undefined && !parsed.web) || (parsed.inMultiplexer && !parsed.web)) {
		io.err(USAGE);
		return 2;
	}
	const noPr = parsed.noPr;
	let webPort = 0;
	if (parsed.web) {
		const chosen = parsed.port ?? (env.BRIGADEV_WEB_PORT === undefined || env.BRIGADEV_WEB_PORT === "" ? 0 : portOf(env.BRIGADEV_WEB_PORT));
		if (chosen === undefined) {
			io.err("BRIGADEV_WEB_PORT must be a port number from 0 to 65535 (0: any free port).");
			return 2;
		}
		webPort = chosen;
		// H2, H3: before anything is read, opened, or started (no store, no lock, no server).
		const noTerminal = terminalRefusal(terminal);
		if (noTerminal) {
			io.err(noTerminal);
			return 2;
		}
		if (terminal.inBackground?.()) {
			io.err(BACKGROUND_REFUSAL);
			return 2;
		}
		const multiplexer = multiplexerOf(env);
		if (multiplexer) {
			if (!parsed.inMultiplexer) {
				io.err(multiplexerRefusal(multiplexer));
				return 2;
			}
			io.err(`warning: ${multiplexer.variable} is set (${multiplexer.name}) and --web-in-multiplexer was given: a pane can be read (capture-pane) and typed into (send-keys) by any process of yours, the worker's bash included, so the board's link is exposed to them.`);
		}
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
		const interrupt = parsed.web ? watchInterrupt() : undefined;
		try {
			const web: WebStart | undefined = parsed.web ? { port: webPort, signal: interrupt!.signal, wire: (newLink) => wireLinkRequests(newLink) } : undefined;
			return await startLoop(runner, docPath, io, { pr: !noPr, ...(parsed.cap === undefined ? {} : { cap: parsed.cap }), ...(web ? { web } : {}) });
		} finally {
			interrupt?.dispose();
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
