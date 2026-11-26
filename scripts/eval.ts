// Agent eval runner: `npm run eval -- [agent] [--model provider/id]`. Not part of `npm test`: every case is a real
// model call. For each case under ./evals/<agent>/<case>/ it copies the fixture to a temp dir (committed as the base of a
// fresh git repo, so `git diff` and `git status` work), launches the agent exactly as the `subagent` tool launches a child
// (lib/child-run.ts: `pi --mode json` with the agent's prompt, tools, guard, and structured output), and checks the
// structured result and the files left behind (lib/evals.ts). A passing case's temp dir is removed; a failing one's is kept.

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type AgentDefinition, discoverAgents } from "../lib/agents.ts";
import { installParentExitGuard, liveChildren, runChild } from "../lib/child-run.ts";
import { formatCost } from "../lib/cost.ts";
import { admitLaunch, buildChildTask, type LaunchRequest } from "../lib/delegation.ts";
import { evaluate, loadCases, parseEvalArgs, parseFlatFrontmatter, type EvalCase } from "../lib/evals.ts";
import { resolveAgentRoute } from "../lib/model-routing.ts";
import { failed } from "../lib/run-status.ts";
import { PACKAGE_AGENTS_DIR } from "../lib/runtime.ts";
import { type JsonSchema, loadOutputSchema } from "../lib/structured-output.ts";

const USAGE = "Usage: npm run eval -- [agent] [--model provider/id]";

/** The fixture copied into `<root>/work`, committed so the agent starts from a clean tree. */
function prepareWorkdir(root: string, fixture: string | undefined): string {
	const work = join(root, "work");
	// verbatimSymlinks: a relative link stays relative, so it cannot point the agent back into the repository's fixture.
	if (fixture) cpSync(fixture, work, { recursive: true, verbatimSymlinks: true });
	else mkdirSync(work);
	// The user's global git config must not sign, hook, or otherwise act on the throwaway commit.
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "user.name=brigadev-eval", "-c", "user.email=eval@localhost", "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", ...args], { cwd: work, stdio: "ignore" });
	git("init", "-q");
	git("add", "-A");
	git("commit", "-q", "--allow-empty", "-m", "eval fixture");
	return work;
}

async function runCase(c: EvalCase, model: string | undefined): Promise<{ pass: boolean; lines: string[]; cost: number }> {
	// Package agents only: the evals pin the prompts this repository ships, not a user's overrides.
	const agents = discoverAgents({ packageAgentsDir: PACKAGE_AGENTS_DIR, userAgentsDir: "", cwd: process.cwd(), includeProject: false, parse: parseFlatFrontmatter });
	const agent = agents.find((a) => a.name === c.agent);
	const request = { agent: c.agent, task: c.task, reason: c.reason ?? `Eval case ${c.agent}/${c.name}`, allowedEditSurfaces: c.allowedEditSurfaces };
	// The same admission as the `subagent` tool: a writer needs surfaces, the verifier a named risk.
	const problems = admitLaunch(request, agent, agents);
	if (!agent || problems.length) return { pass: false, lines: problems.map((p) => `launch rejected: ${p}`), cost: 0 };
	if (!agent.outputSchema) return { pass: false, lines: [`${c.agent} has no output schema: evals check a structured result`], cost: 0 };
	const loaded = loadOutputSchema(agent.outputSchema);
	if ("error" in loaded) return { pass: false, lines: [loaded.error], cost: 0 };

	const root = mkdtempSync(join(tmpdir(), `brigadev-eval-${c.agent}-`));
	// A failing case keeps its folder for inspection; anything that throws before a verdict removes it.
	let keep = false;
	try {
		const outcome = await runInRoot(c, root, agent, request, loaded.schema, model);
		keep = !outcome.pass;
		return outcome;
	} finally {
		if (!keep) rmSync(root, { recursive: true, force: true });
	}
}

async function runInRoot(c: EvalCase, root: string, agent: AgentDefinition, request: LaunchRequest, schema: JsonSchema, model: string | undefined): Promise<{ pass: boolean; lines: string[]; cost: number }> {
	const work = prepareWorkdir(root, c.fixture);
	const route = resolveAgentRoute({ agent: model ? { ...agent, model } : agent, parent: {} });
	const result = await runChild(
		{ cwd: work, agent, request, taskText: buildChildTask(request, agent, []).text, route, routeLabel: route.modelSource === "none" ? "pi default" : route.modelSource, schema, price: () => undefined, onUpdate: () => {} },
		// The child's evidence log and the run folder go under the temp root, never into ~/.brigadev.
		{ piInvocation: (args) => ({ command: process.env.BRIGADEV_PI ?? "pi", args }), env: { ...process.env, BRIGADEV_HOME: join(root, "home") }, docsDir: () => root },
	);
	const cost = result.usage.cost;
	const header = `${result.model ?? "pi default"} · ${formatCost(cost)}`;
	if (failed(result)) return { pass: false, lines: [header, `run failed: ${result.errorMessage || result.stopReason || `exit ${result.exitCode}`}`, `kept ${root}`], cost };
	const checks = evaluate(c.expect, result.structured, work);
	const pass = checks.every((check) => check.pass);
	return { pass, lines: [header, ...checks.map((check) => `${check.pass ? "ok  " : "FAIL"} ${check.reason}`), ...(pass ? [] : [`kept ${root}`])], cost };
}

async function main(): Promise<number> {
	const parsed = parseEvalArgs(process.argv.slice(2));
	if (!parsed.ok) {
		console.error(`${parsed.error}\n${USAGE}`);
		return 2;
	}
	const { agent, model } = parsed.args;
	const { cases, errors } = loadCases(resolve("evals"), agent);
	for (const error of errors) console.error(`ERROR ${error}`);
	if (cases.length === 0) {
		console.error(agent ? `No eval cases for ${agent}.` : "No eval cases.");
		return 1;
	}
	installParentExitGuard(liveChildren, { signals: ["SIGINT", "SIGTERM", "SIGHUP"] });
	let passed = 0;
	let cost = 0;
	for (const c of cases) {
		const started = Date.now();
		let outcome: { pass: boolean; lines: string[]; cost: number };
		try {
			outcome = await runCase(c, model);
		} catch (err) {
			outcome = { pass: false, lines: [err instanceof Error ? err.message : String(err)], cost: 0 };
		}
		cost += outcome.cost;
		if (outcome.pass) passed++;
		console.log(`${outcome.pass ? "PASS" : "FAIL"} ${c.agent}/${c.name} (${Math.round((Date.now() - started) / 1000)}s)`);
		for (const line of outcome.lines) console.log(`  ${line}`);
	}
	console.log(`\n${passed}/${cases.length} passed · ${errors.length} invalid · ${formatCost(cost)}`);
	return passed === cases.length && errors.length === 0 ? 0 : 1;
}

process.exitCode = await main();
