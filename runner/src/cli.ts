// brigadev-runner CLI. `start <feature-doc>`: validate the doc, then run its ticket list durably.
// Exit codes: 0 loop done; 1 refused, failed, paused, or stalled; 2 usage.
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { onFeatureBranch, readBranchFacts } from "../../lib/commit-branch.ts";
import { canonicalPath } from "../../lib/paths.ts";
import { repoDocsDir, repoName } from "../../lib/repo-docs.ts";
import { validateDoc } from "./doc.ts";
import { nodeExec } from "./exec.ts";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const USAGE = "usage: brigadev-runner start <feature-doc>";

export interface Io {
	out(text: string): void;
	err(text: string): void;
}

type Env = Record<string, string | undefined>;

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

export async function main(args: string[], env: Env = process.env, io: Io = { out: console.log, err: console.error }, cwd = process.cwd()): Promise<number> {
	const [command, docArg] = args;
	if (command !== "start" || !docArg || args.length > 2) {
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
	// Next to the repo's other harness documents (`<brigadev home>/<repo>/`), so every worktree of the repo shares one store.
	const storePath = join(repoDocsDir(cwd, env), "runner.sqlite");
	if (!existsSync(dirname(storePath))) mkdirSync(dirname(storePath), { recursive: true });
	const runner = await openRunner({
		storage: await openNodeSqliteStorage(storePath),
		models,
		cwd,
		model: { provider: "anthropic", modelId: env.BRIGADEV_RUNNER_MODEL || DEFAULT_MODEL },
		onReport: (report) => io.err(`report: ${report.kind}: ${(report.error as Error | undefined)?.message ?? ""}`),
	});
	try {
		const outcome = await runner.wait(await runner.start(docPath));
		io.out(JSON.stringify(outcome, null, 2));
		return outcome.status === "completed" && outcome.result.status === "done" ? 0 : 1;
	} finally {
		await runner.close();
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
