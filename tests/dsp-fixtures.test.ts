// Shared helpers for the DSP tests (the other tests/dsp-*.test.ts files import them).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { CommandMatch } from "../lib/command-classifier.ts";
import type { ExecFn } from "../lib/worktree-snapshot.ts";

export interface FakeGit {
	/** Current branch; null = detached. */
	branch?: string | null;
	/** Local branches that exist besides the current one. */
	branches?: string[];
	/** `origin/HEAD` target, if any. */
	originHead?: string | null;
	aliases?: Record<string, string>;
	/** Make `git config --get alias.*` fail (exit 2). */
	aliasError?: boolean;
	remotes?: Record<string, string>;
}

/** An `exec` that answers only the read-only git questions the guard asks; every call is recorded. */
export function fakeExec(git: FakeGit = {}): ExecFn & { calls: string[] } {
	const branch = git.branch === undefined ? "feat/x" : git.branch;
	const branches = new Set([...(git.branches ?? ["main"]), ...(branch ? [branch] : [])]);
	const calls: string[] = [];
	const fn = (async (command: string, args: string[]) => {
		const line = `${command} ${args.join(" ")}`;
		calls.push(line);
		const ok = (stdout = "") => ({ stdout, stderr: "", code: 0 });
		const no = (code = 1) => ({ stdout: "", stderr: "", code });
		if (command !== "git") return no(127);
		const text = args.join(" ");
		if (text === "symbolic-ref --short -q HEAD") return branch ? ok(`${branch}\n`) : no();
		if (text === "symbolic-ref --short refs/remotes/origin/HEAD") return git.originHead ? ok(`origin/${git.originHead}\n`) : no();
		const verify = /^rev-parse --verify --quiet refs\/heads\/(.+)$/.exec(text);
		if (verify) return branches.has(verify[1]) ? ok("abc\n") : no();
		const alias = /^config --get alias\.(.+)$/.exec(text);
		if (alias) return git.aliasError ? no(2) : git.aliases?.[alias[1]] !== undefined ? ok(`${git.aliases[alias[1]]}\n`) : no();
		const url = /^remote get-url (.+)$/.exec(text);
		if (url) return git.remotes?.[url[1]] ? ok(`${git.remotes[url[1]]}\n`) : no(2);
		return no();
	}) as ExecFn & { calls: string[] };
	fn.calls = calls;
	return fn;
}

/** A real `exec` backed by child_process (for tests against a temp repository). */
export const realExec: ExecFn = async (command, args, options) => {
	try {
		return { stdout: execFileSync(command, args, { cwd: options.cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }), stderr: "", code: 0 };
	} catch (error: any) {
		return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? ""), code: typeof error.status === "number" ? error.status : 1 };
	}
};

export const realTmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

export function writeTree(root: string, files: Record<string, string>) {
	for (const [name, text] of Object.entries(files)) {
		mkdirSync(join(root, name, ".."), { recursive: true });
		writeFileSync(join(root, name), text);
	}
}

/** Labels of every remote-action tag in the matches. */
export const remoteLabels = (matches: CommandMatch[]): string[] =>
	matches.flatMap((m) => (m.dsp ?? []).flatMap((tag) => (tag.type === "remote" ? [tag.label] : [])));

export const unknownReasons = (matches: CommandMatch[]): string[] => matches.flatMap((m) => (m.dsp ?? []).flatMap((tag) => (tag.type === "unknown" ? [tag.reason] : [])));

describe("dsp fixtures", () => {
	it("the fake exec answers the branch questions", async () => {
		const exec = fakeExec({ branch: "feat/a", branches: ["main"] });
		assert.equal((await exec("git", ["symbolic-ref", "--short", "-q", "HEAD"], { cwd: "/", timeout: 1 })).stdout.trim(), "feat/a");
		assert.equal((await exec("git", ["rev-parse", "--verify", "--quiet", "refs/heads/main"], { cwd: "/", timeout: 1 })).code, 0);
		assert.equal((await exec("git", ["rev-parse", "--verify", "--quiet", "refs/heads/master"], { cwd: "/", timeout: 1 })).code, 1);
	});
});
