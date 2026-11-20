// Shared test fixtures: a temp git repo, a feature doc, and a faux "worker" model whose scripted bash calls do the work.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { MemoryStorage } from "@earendil-works/pi-durable";
import type { Report, Storage } from "@earendil-works/pi-durable";
import { openRunner, type Runner } from "../src/runner.ts";
import type { TicketDeps } from "../src/tasks.ts";

export const context = BACKGROUND_CONTEXT;

/** Commit without hooks, signing, or any ambient identity. */
export const GIT_COMMIT = "git -c commit.gpgsign=false -c core.hooksPath=/dev/null -c user.name=Runner -c user.email=runner@example.com commit -q";

/** Strip the ambient git environment for the test process (children inherit it) and restore it afterwards. */
export function isolateGitEnv(): () => void {
	const saved: Record<string, string | undefined> = {};
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("GIT_")) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
	}
	for (const [key, value] of Object.entries({ GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" })) {
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

export function git(cwd: string, ...args: string[]): string {
	return execFileSync("git", ["-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", "-c", "user.name=Runner", "-c", "user.email=runner@example.com", ...args], { cwd, encoding: "utf8" }).trim();
}

export interface Workspace {
	root: string;
	repo: string;
	docPath: string;
	cleanup(): void;
}

export function makeWorkspace(): Workspace {
	const root = mkdtempSync(join(tmpdir(), "brigadev-runner-"));
	const repo = join(root, "repo");
	execFileSync("mkdir", [repo]);
	git(repo, "init", "-q", "-b", "main");
	writeFileSync(join(repo, "README.md"), "fixture\n");
	git(repo, "add", "-A");
	git(repo, "commit", "-q", "-m", "initial");
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

/** A worker script: the bash command the faux model runs for a ticket (one command per attempt). */
export function commitFile(file: string): string {
	return `echo "$(date +%s%N)" >> ${file} && git add -A && ${GIT_COMMIT} -m "work on ${file}"`;
}

export interface Prompt {
	ticketId: string;
	system: string;
	/** 1-based number of this worker run for the ticket. */
	run: number;
}

export interface Worker {
	faux: FauxProviderHandle;
	prompts: Prompt[];
	/** Runs inside the model call, before the scripted answer: lets a test edit the doc "while the worker runs". */
	onPrompt?: (prompt: Prompt) => void;
}

function text(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) return content.map((part) => (part && typeof part === "object" && "text" in part ? String((part as { text: unknown }).text) : "")).join("\n");
	return "";
}

/** A faux model that, per ticket id found in the prompt, runs `scripts[id]` with `bash`, then answers. */
export function makeWorker(scripts: Record<string, string>): Worker {
	const faux = fauxProvider({ models: [{ id: "worker" }] });
	const worker: Worker = { faux, prompts: [] };
	const runs = new Map<string, number>();
	const step = (ctx: { messages: Array<{ role: string; content?: unknown }> }) => {
		const last = ctx.messages.at(-1);
		if (last?.role === "toolResult") return fauxAssistantMessage(fauxText("done"));
		const user = ctx.messages.filter((m) => m.role === "user").map((m) => text(m.content)).join("\n");
		const ticketId = /Implement ticket (T\d+[A-Za-z0-9.]*)/.exec(user)?.[1] ?? "?";
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
		const command = scripts[ticketId];
		if (command === undefined) return fauxAssistantMessage(fauxText(`nothing scripted for ${ticketId}`));
		return fauxAssistantMessage([fauxToolCall("bash", { command })], { stopReason: "toolUse" });
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

export async function openFixtureRunner(ws: Workspace, worker: Worker, options: { storage?: Storage; deps?: TicketDeps } = {}): Promise<FixtureRunner> {
	const { models, model } = modelsFor(worker);
	const reports: Report[] = [];
	// Progress commits are paced for a UI; tests have none, so store everything at once.
	const runner = await openRunner({
		storage: options.storage ?? new MemoryStorage(),
		models,
		cwd: ws.repo,
		model,
		deps: options.deps,
		settings: { progress: { partialIntervalMs: 0, outputIntervalMs: 0, persistWithinMs: 0 } },
		onReport: (report) => reports.push(report),
	});
	return Object.assign(runner, { reports });
}
