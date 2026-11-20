# brigadev-runner

A headless, durable ticket runner for the brigadev workflow. It takes a feature doc whose `## Tasks` list the user approved and runs the tickets one at a time, each in a fresh worker conversation, on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable). State lives in storage (SQLite by default), so killing the process and starting it again resumes at the last checkpoint instead of redoing finished tickets.

This package is a separate, private package: the Pi extension in the repo root does not depend on it. It reuses the Pi-free modules in `../lib/` (`ticket-list.ts`, `agents.ts`, and the guard, evidence, and check modules listed under [The worker obeys the guard](#the-worker-obeys-the-guard)) by relative import.

## Status: experimental

- `pi-durable` is itself marked experimental and its API changes without notice, so the four `@earendil-works/*` dependencies are pinned to exactly `1.6.0` (Pi 1.5.2 ships pi-ai 1.5.2, which is why this is not part of the root package).
- Prototype scope (`tasks/durable-runner.md`): the ticket loop (T3) and its guard, check tool, and commit gate (T4). Not there yet: signals for decisions, `pause`/`resume`/`answer` (T5; until then a guard confirmation is denied as `needs you:`), the PR → CI → merge loop (T6), the board (T7). The runner never pushes, merges, or publishes.

## Run

The runner starts only in its own **linked git worktree, on a feature branch** (Q5): it never shares a checkout or a branch with a live Pi session, and never commits on the default branch. Create one from your repo:

```sh
git worktree add ../<repo>-runner -b <branch>
```

`start` refuses (exit 1, after the doc check, before any model call) when the current directory is not a git repository, is not a linked worktree (its git dir equals the common dir), is on a detached HEAD, or is on the default or a protected branch (`main`, `master`, the `origin/HEAD` target, per `lib/commit-branch.ts`; also when the default branch cannot be determined). `BRIGADEV_RUNNER_UNGUARDED` no longer exists: the guard is always on.

```sh
export ANTHROPIC_API_KEY=...
# optional: BRIGADEV_RUNNER_MODEL (default claude-sonnet-5-5)
cd ../<repo>-runner
node <path-to>/runner/src/cli.ts start ~/.brigadev/<repo>/tasks/<feature>.md
```

State is stored in `<brigadev home>/<repo>/runner.sqlite` (`~/.brigadev/<repo>/` unless `BRIGADEV_HOME` is set; `<repo>` is the main checkout's folder name, shared by every worktree, like the feature documents and the evidence). Running `start` again for the same doc finds the same loop task and continues it. Exit codes: 0 every ticket done, 1 refused, failed, paused, or stalled, 2 usage.

## What the doc must look like

`start` refuses the doc, listing every error, unless it passes `validateForRun` (S7: each unfinished ticket has `done:`, known `deps:`, no cycles) and the runner-only rules:

- `T3 done: is not a command`: the runner can only run commands, so an unfinished ticket's `done:` must be a backticked command.
- the doc has a `## Log` section (every finished ticket appends one line).

## How it works

- `brigadev.ticket-loop`: `pick` (first ready ticket in doc order) → `launch` (mark it `in_progress`, create the child) → `record` (write `done` or `blocked` and one `## Log` line) → `pick`. A ticket that fails its attempts is `blocked` with `needs you: <reason>`; tickets that depend on it wait and independent ones continue. Two failed tickets in a row end the loop `paused`. It ends `done` when every ticket is done or dropped, and `stalled` when only blocked or dependent tickets remain.
- `brigadev.ticket`: per attempt, a worker conversation owned by the task (instructions from `assets/agents/brigadev-worker.md` plus the ticket and, on a retry, the failure output). Then the done command runs in the repo: it passes when it exits 0 **and** HEAD moved since the ticket started (the worker must have committed). Up to 3 attempts.
- The doc is written only after re-reading it. A user edit to the running ticket's line or a finished one's pauses the loop (`doc edited: T#`) and nothing is overwritten; edits to pending tickets are picked up at the next pick; a changed spec reopens its linked done tickets (`reopened: S# changed`). Writes are atomic (temp file + rename).

## The worker obeys the guard

S5: the worker follows the same rules as the brigadev extension, decided by the Pi-free modules in `../lib/` (`guard-rules.ts`, `command-classifier.ts`, `permission-policy.ts`, `commit-branch.ts`, `evidence.ts`, `check.ts`, `repo-docs.ts`, `runtime.ts`), not copies of them.

- **One hook** (`src/guard.ts`): a `beforeTool` hook on pi-durable's `ToolTask`, selected by every worker conversation. It decides each call, including nested calls (`call.parent`, as a code mode script makes). A call it cannot decide is blocked (a throwing hook blocks in pi-durable too).
- **File tools** (`read`, `write`, `edit`) go through `decideFileAccess` with the worktree as the project root, as for an extension subagent: nothing is written outside the worktree, secret-looking files are blocked, and the evidence log is blocked. Also blocked for writes: git config and hooks (`isProtectedPath`) and anything in the repo's harness documents folder (the feature document is the runner's to write).
- **bash** goes through `decideBashCommand` with the permission mode from `~/.pi/agent/brigadev.json` (`defaultMode`, default normal), the evidence-write rule (`bashWritesEvidence`), and the branch rule: a commit is allowed only on a feature branch, in every mode.
- **Nothing asks.** A `confirm` result (`rm -rf`, `git reset --hard`, an install, `sudo`, a commit off a feature branch, ...) is denied with `needs you: <reason>` (Q6). The worker is told not to retry it. T5 will turn these denials into durable signals.
- **A commit stands alone**: a bash call that commits may hold only `cd` and `git add`/`status`/`diff`/`log`/`show`/`rev-parse`/`commit`, with no output redirection. The gate reads the working tree before the command runs, so a write in the same call would be committed untested.
- **The runner owns delivery**, whatever the mode: `git push` (also forced), `git pull`, `git merge`, `npm publish` and the other publish commands, `gh pr ...`, `gh release ...`, and `gh api` writes are blocked with `the runner owns PR delivery`.
- **Unknown tools are blocked.** The worker has `read`, `write`, `edit`, `bash`, and `check`.
- **Commit gate**: a `git commit` is allowed only when `evaluateCommitGate` allows it for the current tree, against the same evidence file the extension reads (`<docs>/evidence/<branch>.jsonl`): a passing test run on this exact tree (or a docs-only change). A blocked commit returns the gate's reason to the worker. The worker cannot force it.
- **`check` tool** (`src/check-tool.ts`): the extension's `check` over `lib/check.ts`: same parameters (`command`, `focus`, `timeoutSeconds`), the command from `check.test` in `brigadev.json` or detection, the same refusal of commits, pushes, and publishing, a compact `PASS`/`FAIL` result, and the run is appended to the evidence file with agent `runner-worker`. The worker's instructions say to run `check` before committing and to make no edit between `check` and `git commit`. Tests run through `bash` are not recorded.

Differences from the extension's subagent rules, on purpose: the worker must commit (bash is decided like the parent's, files like a child's), the commit gate applies to it, the branch rule holds in yolo too, there is no one to confirm so confirmations are denials, and delivery is always blocked.

## Tests

```sh
cd runner
node --test tests/*.test.ts      # or: npm test
```

Tests use pi-ai's scripted faux provider and a temp git repo on a feature branch; no network, no model. The guard, the evidence log, and `brigadev.json` read the environment, so the tests point `BRIGADEV_HOME` and `PI_CODING_AGENT_DIR` at a temp dir (`isolateEnv()` in `tests/fixture.ts`): the real `~/.brigadev` is never written. They take minutes where `git` is slow to spawn, because every scripted commit runs the commit gate (several git calls) on top of a real `git commit`. The persistence tests close the Harness while ticket 1's done command is running (after the worker answered), reopen the same JSONL / SQLite storage, and check ticket 1 is not run again.
