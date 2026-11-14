// One saved folder per subagent run, under the repo docs folder (never inside
// the project): the task the child received, its transcript, and the result.
// Transcripts can hold anything the child read, so everything is user-only.

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Message } from "@earendil-works/pi-ai";
import type { Tally } from "./cost.ts";

export interface RunRecord {
	runId: string;
	agent: string;
	task: string;
	reason?: string;
	/** The full task text the child was launched with. */
	taskText: string;
	model?: string;
	thinking?: string;
	route?: string;
	exitCode: number;
	stopReason?: string;
	errorMessage?: string;
	startedAt?: number;
	endedAt?: number;
	usage: Tally;
	/** What the parent was told: the final text, structured payload, or error. */
	output: string;
	messages: Message[];
}

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const runsDir = (docsDir: string): string => path.join(docsDir, "runs");

/** `<UTC yyyymmddThhmmssZ>-<agent>-<6 hex>`: sorts by launch time, safe as a folder name. */
export function newRunId(agent: string, now: number = Date.now(), random: () => string = randomUUID): string {
	const stamp = new Date(now).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
	const name = agent.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "agent";
	return `${stamp}-${name}-${random().replace(/-/g, "").slice(0, 6)}`;
}

/** Writes `task.md`, `transcript.json`, and `result.json` to `<docs>/runs/<runId>/`; returns the folder. */
export function writeRunArtifacts(docsDir: string, record: RunRecord): string {
	if (!RUN_ID.test(record.runId)) throw new Error(`invalid run id: ${record.runId}`);
	const dir = path.join(runsDir(docsDir), record.runId);
	fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	fs.chmodSync(dir, 0o700);
	const { messages, taskText, ...result } = record;
	const write = (name: string, text: string) => fs.writeFileSync(path.join(dir, name), text, { encoding: "utf8", mode: 0o600 });
	write("task.md", taskText);
	write("transcript.json", `${JSON.stringify(messages, null, 2)}\n`);
	write("result.json", `${JSON.stringify(result, null, 2)}\n`);
	return dir;
}
