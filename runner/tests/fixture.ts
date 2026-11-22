// Shared test fixtures: a temp git repo, a feature doc, and a faux "worker" model whose scripted bash calls do the work.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Report, Storage } from "@earendil-works/pi-durable";
import { openRunner, type Runner } from "../src/runner.ts";
import type { PrDeps } from "../src/pr.ts";
import { defaultDeps, type TicketDeps } from "../src/tasks.ts";

export const context = BACKGROUND_CONTEXT;

/**
 * Whether `pid` is a live process (a zombie awaiting its parent's wait is not). The signal-0 probe decides existence, so a slim image without `ps` still answers; only
 * a pid that exists is looked at for the zombie state, from /proc where there is one (Linux), else from `ps` (macOS), and without either it counts as live.
 * A pid that is not a positive integer (a marker that was never captured) is never live here, and the callers assert they captured one.
 */
export function live(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EPERM") return false; // ESRCH: no such process
	}
	try {
		// `pid (comm) S ...`: the state follows the last `)`, as the name may hold one.
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return !/^[Zx]/i.test(stat.slice(stat.lastIndexOf(")") + 2));
	} catch {
		// No /proc (macOS) or the process went in between.
	}
	try {
		const stat = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
		return stat !== "" && !stat.startsWith("Z");
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"; // no `ps` at all: it exists (signal 0 said so); ps exits 1 for a process that is gone
	}
}

/** Poll (bounded) until `pid` is gone; true when it is. */
export async function goneWithin(pid: number, ms: number): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (!live(pid)) return true;
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
	return !live(pid);
}

/**
 * A plain commit: the guard blocks `git -c` and `git config` (B1), so the identity comes from the environment (`isolateGitEnv` sets it), signing is off
 * through `GIT_CONFIG_GLOBAL=/dev/null`, and hooks are off through the contained environment of the worker's shell.
 */
export const GIT_COMMIT = "git commit -q";

/** Strip the ambient git environment for the test process (children inherit it) and restore it afterwards. */
export function isolateGitEnv(): () => void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	}
	const identity = { GIT_AUTHOR_NAME: "Runner", GIT_AUTHOR_EMAIL: "runner@example.com", GIT_COMMITTER_NAME: "Runner", GIT_COMMITTER_EMAIL: "runner@example.com" };
	for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", ...identity })) {
		saved[key] ??= undefined;
		process.env[key] = value;
	}
	return () => {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	};
}

export interface Isolation {
	restore(): void;
	/** `BRIGADEV_HOME`: the repo docs and evidence folders live here, never in the real `~/.brigadev`. */
	brigadevHome: string;
	/** `PI_CODING_AGENT_DIR`: where `brigadev.json` (permission mode, `check.test`) is read from. */
	agentDir: string;
	/** Replace the brigadev settings (`brigadev.json`). */
	settings(value: object): void;
}

/**
 * Everything the guard, the check tool, and the evidence log read from the environment, pointed at a temp dir:
 * the ambient git environment is dropped, `BRIGADEV_HOME` (repo docs + evidence) and `PI_CODING_AGENT_DIR` (brigadev.json) are
 * temp dirs, and every other `BRIGADEV_*` variable is removed. `restore()` puts it all back and deletes the temp dir.
 */
export function isolateEnv(): Isolation {
	const restoreGit = isolateGitEnv();
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env)) if (key.startsWith("BRIGADEV_") || key === "PI_CODING_AGENT_DIR") saved[key] = process.env[key];
	for (const key of Object.keys(saved)) delete process.env[key];
	const root = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-runner-env-")));
	const brigadevHome = join(root, "bhome");
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	saved.BRIGADEV_HOME ??= undefined;
	saved.PI_CODING_AGENT_DIR ??= undefined;
	process.env.BRIGADEV_HOME = brigadevHome;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const settings = (value: object) => writeFileSync(join(agentDir, "brigadev.json"), JSON.stringify(value));
	// A passing test command by default, so scripted workers can unlock the commit gate with `check`.
	settings({ check: { test: "true" } });
	return {
		brigadevHome,
		agentDir,
		settings,
		restore() {
			for (const [key, value] of Object.entries(saved)) {
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			restoreGit();
			rmSync(root, { recursive: true, force: true });
		},
	};
}

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Runner", "-c", "user.email=runner@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

export const FEATURE_BRANCH = "feat/runner-test";

export interface Workspace {
	root: string;
	repo: string;
	docPath: string;
	cleanup(): void;
}

export function makeWorkspace(): Workspace {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "brigadev-runner-")));
	const repo = join(root, "repo");
	execFileSync("mkdir", [repo]);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "README.md"), "fixture\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "initial");
	// The worker commits on a feature branch, as the guard requires (S5).
	git(repo, "checkout", "-q", "-b", FEATURE_BRANCH);
	return { root, repo, docPath: join(root, "feature.md"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export const SPECS = ["- S1: First behavior. Check: t1.", "- S2: Second behavior. Check: t2."];

export function docText(tickets: string[], specs: string[] = SPECS): string {
	return ["# Feature", "Objective: fixture.", "", "## Specs", ...specs, "", "## Tasks", ...tickets, "", "## Log", "- L1 (2026-11-20): start", ""].join("\n");
}

export function readDoc(ws: Workspace): string {
	return readFileSync(ws.docPath, "utf8");
}

export function ticketLine(text: string, id: string): string {
	const line = text.split("\n").find((l) => l.startsWith(`- ${id} `));
	if (!line) throw new Error(`no ${id} line in:\n${text}`);
	return line;
}

/**
 * A worker script for a ticket (per attempt): change a file, run `check` (the fixture's brigadev.json sets `check.test` to `true`),
 * then commit in its own bash call, as the guard requires.
 */
export function commitFile(file: string): Step[] {
	return [bash(`echo "$(date +%s%N)" >> ${file}`), check(), bash(`git add -A && ${GIT_COMMIT} -m "work on ${file}"`)];
}

export interface Prompt {
	ticketId: string;
	system: string;
	/** 1-based number of this worker run for the ticket. */
	run: number;
}

/** One scripted tool call of a worker run. */
export interface Step {
	tool: string;
	input: Record<string, unknown>;
}
export const bash = (command: string): Step => ({ tool: "bash", input: { command } });
export const check = (input: Record<string, unknown> = {}): Step => ({ tool: "check", input });
export const writeFile = (path: string, content: string): Step => ({ tool: "write", input: { path, content } });
/** The worker's `ask_user_choice` call (T5): a decision for the user, with an optional command it needs approved. */
export const askUser = (question: string, options: Array<string | { label: string; description?: string }>, extra: { recommended?: number; command?: string } = {}): Step => ({
	tool: "ask_user_choice",
	input: { question, options: options.map((option) => (typeof option === "string" ? { label: option } : option)), ...extra },
});

/**
 * Ticket deps whose done command calls `hook(command)` first. A user's edit of the doc "meanwhile" lands here, after the worker's run and the integrity check
 * (any change of the doc during a worker's conversation parks the loop: B2) and before the write-back that must not overwrite it (S8).
 */
export function depsWithHook(hook: (command: string) => void): TicketDeps {
	return { head: defaultDeps.head, run: (command, cwd, signal, shell) => (hook(command), defaultDeps.run(command, cwd, signal, shell)) };
}

/** A manual clock for a Harness: `now` and `setTimer` go to the runner; `advance(ms)` moves time and fires the timers that came due. */
// Starts at the real time: a deadline the runner sets on this clock is read with the real clock by a CLI command in another process
// (`merge`, `answer`), so a fixed start date turns into a closed deadline 24 h after it.
export function fakeClock(start = Date.now()) {
	let time = start;
	let timers: Array<{ at: number; callback: () => void }> = [];
	return {
		now: () => time,
		setTimer: (callback: () => void, delayMs: number) => {
			const timer = { at: time + delayMs, callback };
			timers.push(timer);
			return () => {
				timers = timers.filter((other) => other !== timer);
			};
		},
		advance(ms: number) {
			time += ms;
			const due = timers.filter((timer) => timer.at <= time);
			timers = timers.filter((timer) => timer.at > time);
			for (const timer of due) timer.callback();
		},
	};
}

/** A tool result the worker got back (what the guard or a tool said). */
export interface Result {
	ticketId: string;
	text: string;
	isError: boolean;
}

export interface Worker {
	faux: FauxProviderHandle;
	prompts: Prompt[];
	results: Result[];
	/** Runs inside the model call, before the scripted answer: lets a test edit the doc "while the worker runs". */
	onPrompt?: (prompt: Prompt) => void;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
	return "";
}

/**
 * A faux model that, per ticket id found in the prompt, runs `scripts[id]` one tool call per model turn, then answers.
 * A string is one `bash` command; a list is a sequence of steps (a step runs even when the guard blocked the one before);
 * a function gets the 1-based number of this worker run for the ticket (a rerun after a decision, or a retry) and returns the steps.
 */
export function makeWorker(scripts: Record<string, string | Step[] | ((run: number) => Step[])>): Worker {
	const faux = fauxProvider({ models: [{ id: "worker" }] });
	const worker: Worker = { faux, prompts: [], results: [] };
	const runs = new Map<string, number>();
	const stepsOf = (ticketId: string): Step[] => {
		const script = scripts[ticketId];
		return typeof script === "string" ? [bash(script)] : typeof script === "function" ? script(runs.get(ticketId) ?? 1) : (script ?? []);
	};
	const step = (ctx: { messages: Array<{ role: string; content?: unknown; isError?: boolean }> }) => {
		const user = ctx.messages.filter((m) => m.role === "user").map((m) => text(m.content)).join("\n");
		// A ticket (`T3`), a PR loop fix ticket (`FIX-1`), or the PR loop's verify conversation (`VERIFY`).
		const ticketId = /Implement ticket ((?:T|FIX-)\d+[A-Za-z0-9.]*)/.exec(user)?.[1] ?? (/Verify the changes of branch/.test(user) ? "VERIFY" : "?");
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") {
			worker.results.push({ ticketId, text: text(last.content), isError: last.isError === true });
			const steps = stepsOf(ticketId);
			const done = ctx.messages.filter((m) => m.role === "toolResult").length;
			const next = steps[done];
			return next ? fauxAssistantMessage([fauxToolCall(next.tool, next.input as never)], { stopReason: "toolUse" }) : fauxAssistantMessage(fauxText("done"));
		}
		// Instructions render as the `instructions` section of the leading system message.
		const system = ctx.messages
			.filter((m) => m.role === "system")
			.map((m) => [text(m.content), ...Object.values((m as { sections?: Record<string, string | null> }).sections ?? {})].filter(Boolean).join("\n"))
			.join("\n");
		const run = (runs.get(ticketId) ?? 0) + 1;
		runs.set(ticketId, run);
		const prompt = { ticketId, system, run };
		worker.prompts.push(prompt);
		worker.onPrompt?.(prompt);
		const first = stepsOf(ticketId)[0];
		if (first === undefined) return fauxAssistantMessage(fauxText(`nothing scripted for ${ticketId}`));
		return fauxAssistantMessage([fauxToolCall(first.tool, first.input as never)], { stopReason: "toolUse" });
	};
	faux.setResponses(Array.from({ length: 80 }, () => step as never));
	return worker;
}

export function modelsFor(worker: Worker) {
	const models = createModels();
	models.setProvider(worker.faux.provider);
	const model = worker.faux.getModel();
	return { models, model: { provider: model.provider, modelId: model.id } };
}

/** A runner plus every `onReport` the Harness made (faulted tasks, hook errors, storage failures): tests expect none. */
export type FixtureRunner = Runner & { reports: Report[] };

export async function openFixtureRunner(
	ws: Workspace,
	worker: Worker,
	options: { storage?: Storage; deps?: TicketDeps; prDeps?: PrDeps; clock?: ReturnType<typeof fakeClock> } = {},
): Promise<FixtureRunner> {
	const { models, model } = modelsFor(worker);
	const reports: Report[] = [];
	// Progress commits are paced for a UI; tests have none, so store everything at once.
	const runner = await openRunner({
		storage: options.storage ?? new MemoryStorage(),
		models,
		cwd: ws.repo,
		model,
		deps: options.deps,
		prDeps: options.prDeps,
		now: options.clock?.now,
		setTimer: options.clock?.setTimer,
		settings: { progress: { partialIntervalMs: 0, outputIntervalMs: 0, persistWithinMs: 0 } },
		onReport: (report) => reports.push(report),
	});
	return Object.assign(runner, { reports });
}
