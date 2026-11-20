// brigadev-runner CLI. `start <feature-doc>`: validate the doc, then run its ticket list durably.
// Exit codes: 0 loop done; 1 refused, failed, paused, or stalled; 2 usage.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateDoc } from "./doc.ts";

export const DEFAULT_MODEL = "claude-sonnet-5-5";
const USAGE = "usage: brigadev-runner start <feature-doc>";

export interface Io {
	out(text: string): void;
	err(text: string): void;
}

type Env = Record<string, string | undefined>;

function repoName(cwd: string): string {
	try {
		return basename(execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
	} catch {
		return basename(cwd);
	}
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

	// The brigadev guard (T4) is not wired into the worker yet: without it the worker's bash is unrestricted.
	if (env.BRIGADEV_RUNNER_UNGUARDED !== "1") {
		io.err("Refusing to run: the brigadev guard is not wired into the runner yet, so the worker would run edits and shell commands with no guard rules.");
		io.err("Set BRIGADEV_RUNNER_UNGUARDED=1 to run anyway, in a disposable checkout.");
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
	const storePath = join(env.HOME ?? homedir(), ".brigadev", repoName(cwd), "runner.sqlite");
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
