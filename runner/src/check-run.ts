// lib/check.ts `runCheck`, with the environment of the test process as a parameter. lib/ is not editable from the runner's change and its `runCommand`
// spawns with `process.env` (the runner's credentials); the runner runs the agent's suite with the contained environment instead (src/contain.ts).
// Same command choice, refusal, evidence record, and result text as `runCheck`; only the spawn differs. Keep it in step with lib/check.ts.
import { spawn } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { checkRefusal, createOutputFile, evidenceOutcome, parseCounts, resolveCommand, shapeResult, type CheckDetails, type CheckEnvironment, type CheckRequest, type CheckResult, type RunOutcome } from "../../lib/check.ts";
import { readCurrentBranch } from "../../lib/commit-branch.ts";
import { appendEvidence, buildRunRecord, checkDirectory, checkKind, evidenceFile, settleRunTree, type CheckOutcome } from "../../lib/evidence.ts";
import { repoDocsDir } from "../../lib/repo-docs.ts";
import { riskNotice } from "../../lib/risk-map.ts";
import { worktreeTreeResult } from "../../lib/worktree-tree.ts";
import { killGroup } from "./shell.ts";

const DEFAULT_TIMEOUT_SECONDS = 600;
const MAX_TIMEOUT_SECONDS = 3600;
const MAX_OUTPUT_CHARS = 256 * 1024;
const CLOSE_GRACE_MS = 500;
const NOT_RECORDED = "Not recorded as test evidence: this is not a recognized test runner or the configured/detected test command, so it does not count as test evidence for the PR gate. Run the tests (omit `command`, or use the project's test command).";

export interface ContainedCheckEnvironment extends CheckEnvironment {
	/** The environment of the test process (the contained one). */
	shellEnv: NodeJS.ProcessEnv;
	/** Upper bound on the timeout, in ms (settings `runner.doneTimeoutMinutes`), default the lib's one hour. */
	maxTimeoutMs?: number;
}

const trees = async (dir: string) => {
	const result = await worktreeTreeResult(dir, { sourceTree: true });
	return result.kind === "tree" ? result : undefined;
};

function timeoutMs(seconds: number | undefined, cap: number): number {
	const value = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_TIMEOUT_SECONDS;
	return Math.min(Math.min(Math.max(value, 1), MAX_TIMEOUT_SECONDS) * 1000, cap);
}

/** `bash -c 'set -o pipefail; <command>'` in its own process group with `env`; a timeout or an abort kills the group. */
function runCommand(options: { command: string; cwd: string; timeoutMs: number; signal?: AbortSignal; outputFile: string; env: NodeJS.ProcessEnv }): Promise<RunOutcome> {
	const started = Date.now();
	return new Promise((resolve) => {
		const fd = openSync(options.outputFile, "w", 0o600);
		let tail = "";
		let timedOut = false;
		let aborted = false;
		let settled = false;
		let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
		let graceTimer: NodeJS.Timeout | undefined;
		// A parent `node --test` run marks its children with NODE_TEST_CONTEXT; a nested runner would skip its files.
		const { NODE_TEST_CONTEXT: _inherited, ...env } = { ...process.env, ...options.env };
		const child = spawn("bash", ["-c", `set -o pipefail; ${options.command}`], {
			cwd: options.cwd,
			detached: true,
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		const kill = () => killGroup(child.pid, () => child.kill("SIGKILL"));
		const timer = setTimeout(() => {
			timedOut = true;
			kill();
		}, options.timeoutMs);
		const onAbort = () => {
			aborted = true;
			kill();
		};
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });

		const finish = () => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (graceTimer) clearTimeout(graceTimer);
			options.signal?.removeEventListener("abort", onAbort);
			try {
				closeSync(fd);
			} catch {
				// The output file is a convenience.
			}
			resolve({ exitCode: exit?.code ?? undefined, signal: exit?.signal ?? undefined, timedOut, aborted, durationMs: Date.now() - started, output: tail });
		};
		const take = (chunk: string) => {
			try {
				writeSync(fd, chunk);
			} catch {
				// Keep running; the summary still has the tail.
			}
			tail += chunk;
			if (tail.length > MAX_OUTPUT_CHARS) tail = tail.slice(-MAX_OUTPUT_CHARS);
		};
		for (const stream of [child.stdout, child.stderr]) {
			stream.setEncoding("utf8");
			stream.on("data", take);
		}
		child.on("error", (error) => {
			take(`could not start bash: ${error.message}\n`);
			finish();
		});
		child.on("exit", (code, signal) => {
			exit = { code, signal };
			graceTimer = setTimeout(finish, CLOSE_GRACE_MS);
		});
		child.on("close", finish);
	});
}

export async function runContainedCheck(request: CheckRequest, env: ContainedCheckEnvironment): Promise<CheckResult> {
	const choice = resolveCommand({ command: request.command, focus: request.focus, cwd: env.cwd, settings: env.settings });
	if ("error" in choice) return { text: `Error: ${choice.error}`, isError: true };
	const { command } = choice;
	const refusal = checkRefusal(command);
	if (refusal) return { text: `Error: ${refusal}`, isError: true };

	const dir = checkDirectory(command, env.cwd);
	let before: Awaited<ReturnType<typeof trees>>;
	try {
		before = await trees(dir);
	} catch {
		before = undefined;
	}
	const outputFile = createOutputFile();
	const run = await runCommand({ command, cwd: env.cwd, timeoutMs: timeoutMs(request.timeoutSeconds, env.maxTimeoutMs ?? Number.POSITIVE_INFINITY), signal: env.signal, outputFile, env: env.shellEnv });

	let outcome: CheckOutcome = run.timedOut || run.aborted ? "unknown" : evidenceOutcome(command, run.exitCode);
	let recorded = false;
	const configured = resolveCommand({ focus: request.focus, cwd: env.cwd, settings: env.settings });
	const vouches = checkKind(command) === "test" || ("command" in configured && command === configured.command);
	if (!vouches) outcome = "unknown";
	try {
		if (vouches) {
			const after = await trees(dir);
			const settled = settleRunTree(before?.tree, after?.tree, before?.sourceTree, after?.sourceTree);
			if (settled.record) {
				const branch = await readCurrentBranch(env.exec, dir);
				const record = buildRunRecord({
					ts: new Date().toISOString(),
					branch,
					tree: settled.tree,
					srcTree: settled.srcTree,
					note: settled.note,
					cwd: env.cwd,
					topLevel: after?.root,
					agent: env.agent,
					command,
					exitCode: run.exitCode,
					output: run.output,
				});
				record.kind = "test";
				record.outcome = settled.note ? "unknown" : outcome;
				outcome = record.outcome;
				appendEvidence(evidenceFile(repoDocsDir(dir), branch), record);
				recorded = true;
			}
		}
	} catch {
		// Evidence is best effort: a failed write must not hide the test result.
	}

	const shaped = shapeResult({ command, exitCode: run.exitCode, signal: run.signal, timedOut: run.timedOut, aborted: run.aborted, durationMs: run.durationMs, output: run.output, outputFile });
	const notice = await riskNotice(env.exec, dir, env.settings);
	const details: CheckDetails = { command, exitCode: run.exitCode, outcome, outputFile, durationMs: run.durationMs, counts: parseCounts(run.output), recorded };
	return { text: `${vouches ? shaped : `${shaped}\n${NOT_RECORDED}`}${notice ? `\n${notice}` : ""}`, details };
}
