# brigadev-runner

A headless, durable ticket runner for the brigadev workflow. It takes a feature doc whose `## Tasks` list the user approved and runs the tickets one at a time, each in a fresh worker conversation, on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable). State lives in storage (SQLite by default), so killing the process and starting it again resumes at the last checkpoint instead of redoing finished tickets.

This package is a separate, private package: the Pi extension in the repo root does not depend on it. It reuses the Pi-free modules in `../lib/` (`ticket-list.ts`, `agents.ts`) by relative import.

## Status: experimental

- `pi-durable` is itself marked experimental and its API changes without notice, so the four `@earendil-works/*` dependencies are pinned to exactly `1.6.0` (Pi 1.5.2 ships pi-ai 1.5.2, which is why this is not part of the root package).
- Prototype scope (T3 of `tasks/durable-runner.md`): the ticket loop only. Not there yet: the guard and commit gate (T4), signals for decisions, `pause`/`resume`/`answer` (T5), the PR → CI → merge loop (T6), the board (T7).
- **`BRIGADEV_RUNNER_UNGUARDED=1` is required to run.** The brigadev guard is not wired into the worker yet, so its `bash`, `write`, and `edit` tools run with no guard rules. `start` validates the doc, then refuses to run a valid one unless this variable is set. Use a disposable checkout or worktree. The runner never pushes or merges.

## Run

```sh
export ANTHROPIC_API_KEY=...
export BRIGADEV_RUNNER_UNGUARDED=1
# optional: BRIGADEV_RUNNER_MODEL (default claude-sonnet-5-5)
cd <the repo or worktree the tickets change>
node <path-to>/runner/src/cli.ts start ~/.brigadev/<repo>/tasks/<feature>.md
```

State is stored in `~/.brigadev/<repo>/runner.sqlite`. Running `start` again for the same doc finds the same loop task and continues it. Exit codes: 0 every ticket done, 1 refused, failed, paused, or stalled, 2 usage.

## What the doc must look like

`start` refuses the doc, listing every error, unless it passes `validateForRun` (S7: each unfinished ticket has `done:`, known `deps:`, no cycles) and the runner-only rules:

- `T3 done: is not a command`: the runner can only run commands, so an unfinished ticket's `done:` must be a backticked command.
- the doc has a `## Log` section (every finished ticket appends one line).

## How it works

- `brigadev.ticket-loop`: `pick` (first ready ticket in doc order) → `launch` (mark it `in_progress`, create the child) → `record` (write `done` or `blocked` and one `## Log` line) → `pick`. A ticket that fails its attempts is `blocked` with `needs you: <reason>`; tickets that depend on it wait and independent ones continue. Two failed tickets in a row end the loop `paused`. It ends `done` when every ticket is done or dropped, and `stalled` when only blocked or dependent tickets remain.
- `brigadev.ticket`: per attempt, a worker conversation owned by the task (instructions from `assets/agents/brigadev-worker.md` plus the ticket and, on a retry, the failure output). Then the done command runs in the repo: it passes when it exits 0 **and** HEAD moved since the ticket started (the worker must have committed). Up to 3 attempts.
- The doc is written only after re-reading it. A user edit to the running ticket's line or a finished one's pauses the loop (`doc edited: T#`) and nothing is overwritten; edits to pending tickets are picked up at the next pick; a changed spec reopens its linked done tickets (`reopened: S# changed`). Writes are atomic (temp file + rename).

## Tests

```sh
cd runner
node --test tests/*.test.ts      # or: npm test
```

Tests use pi-ai's scripted faux provider and a temp git repo; no network, no model. They take about a minute because every scripted worker run makes a real `git commit`. The persistence tests close the Harness while ticket 1's done command is running (after the worker answered), reopen the same JSONL / SQLite storage, and check ticket 1 is not run again.
