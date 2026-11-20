// brigadev-runner CLI.
//   start <feature-doc>             validate the doc, then run its ticket list durably; returns when the loop ends or parks on a person
//   status <feature-doc>            read-only: the loop's state, each ticket's status, open decisions with the exact answer command
//   answer <feature-doc> <T#> <1..n|text> [--approve]   answer a parked ticket decision (--approve also approves its command)
//   pause <feature-doc>             pause at the next pick;  resume <feature-doc>   lift a pause
// Exit codes: 0 loop done / signal delivered; 1 refused, failed, paused, stalled, parked, or a final signal answer (duplicate, closed, not_found);
// 2 usage or an invalid answer.
//
// One process per store (pi-durable's rule: one writer per storage). `answer`, `pause`, and `resume` open a short-lived Harness that delivers one
// signal and closes before anything is scheduled, and they refuse while a `start` holds the store (`runner.sqlite.lock`): a second Harness opening
// the store would mark the first one's running tasks as crashed. `start` therefore returns when the loop parks on a person, instead of waiting in
// the foreground for an answer it could not see; run it again after answering.
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { onFeatureBranch, readBranchFacts } from "../../lib/commit-branch.ts";
import { canonicalPath } from "../../lib/paths.ts";
import { repoDocsDir, repoName } from "../../lib/repo-docs.ts";
import { answerDecision, pauseLoop, resumeLoop, statusText, type ControlResult } from "./control.ts";
import { validateDoc } from "./doc.ts";
import { nodeExec } from "./exec.ts";
import type { Runner } from "./runner.ts";
import { answerCommand } from "./tasks.ts";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const USAGE = [
	"usage: brigadev-runner start <feature-doc>",
	"       brigadev-runner status <feature-doc>",
	"       brigadev-runner answer <feature-doc> <T#> <1..n|text> [--approve]",
	"       brigadev-runner pause <feature-doc>",
	"       brigadev-runner resume <feature-doc>",
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

const lockPathOf = (storePath: string) => `${storePath}.lock`;
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as { code?: string }).code === "EPERM";
	}
};

/** The pid of a live process holding the store, or undefined. */
export function lockHolder(storePath: string): number | undefined {
	try {
		const pid = Number(readFileSync(lockPathOf(storePath), "utf8").trim());
		return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
	} catch {
		return undefined;
	}
}

/** Take the store for this process; returns the holder's pid instead when another live process has it, else a release function. */
export function acquireStore(storePath: string): number | (() => void) {
	mkdirSync(dirname(storePath), { recursive: true });
	// Exclusive create, so two `start`s racing cannot both take it; a stale lock (dead pid) is removed once and the create retried.
	for (let attempt = 0; ; attempt++) {
		try {
			writeFileSync(lockPathOf(storePath), String(process.pid), { flag: "wx" });
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const holder = lockHolder(storePath);
			// A live holder, this process included: the lock is not re-entrant (one open of the store per lock).
			if (holder !== undefined) return holder;
			if (attempt > 0) return -1;
			rmSync(lockPathOf(storePath), { force: true });
		}
	}
	return () => {
		if (readFileSync(lockPathOf(storePath), "utf8").trim() === String(process.pid)) rmSync(lockPathOf(storePath), { force: true });
	};
}

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
export async function startLoop(runner: Runner, docPath: string, io: Io): Promise<number> {
	const id = await runner.start(docPath);
	const outcome = await runner.settle(id);
	io.out(JSON.stringify(outcome, null, 2));
	if (outcome.status === "waiting") {
		const status = await runner.status(id);
		for (const decision of status.decisions) io.out(`${decision.ticketId} needs a decision: ${answerCommand(docPath, decision.ticketId)}`);
		if (outcome.paused !== undefined) io.out(`paused: ${outcome.paused}. Resume with: brigadev-runner resume ${docPath}`);
		io.out(`Parked, nothing is running. After answering, then run \`brigadev-runner start ${docPath}\` again: the loop continues from storage.`);
		return 1;
	}
	return outcome.status === "completed" && outcome.result.status === "done" ? 0 : 1;
}

async function loadRunnerModules() {
	const [{ createModels }, { openNodeSqliteStorage }, { openRunner }] = await Promise.all([
		import("@earendil-works/pi-ai/models"),
		import("@earendil-works/pi-durable/storage/sqlite/node"),
		import("./runner.ts"),
	]);
	return { createModels, openNodeSqliteStorage, openRunner };
}

/** `status`, `answer`, `pause`, `resume`: no worker, no API key, no scheduling. */
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
			io.err(`a \`brigadev-runner start\` is running on this store (pid ${held}). \`${command}\` opens the store too, which is unsafe beside it: wait until \`start\` parks or ends, or stop it, then run \`${command}\` again.`);
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
		else result = await resumeLoop(runner, docPath);
		(result.code === 0 ? io.out : io.err)(result.text);
		return result.code;
	} finally {
		await runner.close();
	}
}

export async function main(args: string[], env: Env = process.env, io: Io = { out: console.log, err: console.error }, cwd = process.cwd()): Promise<number> {
	const [command, ...rest] = args;
	if (command === "status" || command === "answer" || command === "pause" || command === "resume") return control(command, rest, env, io, cwd);

	const [docArg] = rest;
	if (command !== "start" || !docArg || rest.length > 1) {
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
		io.err(`another \`brigadev-runner start\` is running on this store (pid ${held}); one process per store.`);
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
			return await startLoop(runner, docPath, io);
		} finally {
			await runner.close();
		}
	} finally {
		held();
	}
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(realpathSync(entry)).href) {
	main(process.argv.slice(2)).then(
		(code) => process.exit(code),
		(error) => {
			console.error(error instanceof Error ? error.message : error);
			process.exit(1);
		},
	);
}
