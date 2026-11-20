# brigadev-runner

A headless, durable ticket runner for the brigadev workflow. It takes a feature doc whose `## Tasks` list the user approved and runs the tickets one at a time, each in a fresh worker conversation, on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable). State lives in storage (SQLite by default), so killing the process and starting it again resumes at the last checkpoint instead of redoing finished tickets.

This package is a separate, private package: the Pi extension in the repo root does not depend on it. It reuses the Pi-free modules in `../lib/` (`ticket-list.ts`, `agents.ts`, and the guard, evidence, and check modules listed under [The worker obeys the guard](#the-worker-obeys-the-guard)) by relative import.

## Status: experimental

- `pi-durable` is itself marked experimental and its API changes without notice, so the four `@earendil-works/*` dependencies are pinned to exactly `1.6.0` (Pi 1.5.2 ships pi-ai 1.5.2, which is why this is not part of the root package).
- Prototype scope (`tasks/durable-runner.md`): the ticket loop (T3), its guard, check tool, and commit gate (T4), and the human gates as durable signals: ticket decisions, command approvals, pause and resume, and the `status`/`answer`/`pause`/`resume` commands (T5). Not there yet: the PR → CI → merge loop with its merge-approval signal (T6; it reuses `src/signals.ts`), the board (T7). The runner never pushes, merges, or publishes.

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

State is stored in `<brigadev home>/<repo>/runner.sqlite` (`~/.brigadev/<repo>/` unless `BRIGADEV_HOME` is set; `<repo>` is the main checkout's folder name, shared by every worktree, like the feature documents and the evidence). Running `start` again for the same doc finds the same loop task and continues it. Exit codes: 0 every ticket done, 1 refused, failed, stalled, or parked (waiting for a decision or a resume), 2 usage.

## Commands

```sh
brigadev-runner start  <feature-doc>                              # run the loop; returns when it ends or parks on a person
brigadev-runner status <feature-doc>                              # read-only
brigadev-runner answer <feature-doc> <T#> <1..n|text> [--approve]  # answer a parked decision
brigadev-runner pause  <feature-doc>                              # pause at the next pick
brigadev-runner resume <feature-doc>                              # lift a pause
```

- `status` prints the loop state (`running`, `sleeping`, `paused: <reason>`, `done`, `stalled`, `failed`), every ticket's status from the doc, and each open decision with its numbered options, the `(recommended)` mark, the deadline, and the exact `brigadev-runner answer <doc> <T#> <1..n|text>` command. It opens the store read-only: nothing is recovered, written, or scheduled, and it creates nothing for a doc that was never started.
- `answer`: the choice is an option number or free text (several words need no quotes). A number outside the options is `invalid` (exit 2) with the reason. `--approve` approves the decision's `command` whatever the option labels say.
- Signal results map to output and exit codes: `delivered` 0; `duplicate` and `closed` are final answers, printed as such, 1 (a second answer, or an answer after the deadline or after the loop ended); `invalid` 2 with the reason; `not_found` 1 (no such loop, or no decision for that ticket). `pause` while paused and `resume` while not paused are refused (1): a stale `resume` would otherwise lift the next pause.
- `answer`, `pause`, and `resume` check the doc like `start` does (it must be readable and valid), but not the worktree rule: they touch no checkout. They need no API key and never run a worker.

### One process per store (the multi-process limitation)

pi-durable allows one writer per storage. Checked on pi-durable 1.6.0: a second Harness opened on the SQLite file while another process runs a ticket marks that ticket task `pending` with `restarts + 1` (open recovers `running` tasks), and a running Harness does not see a signal another process committed (a `pause` delivered that way was ignored and both tickets still ran). So:

- `answer`, `pause`, and `resume` open a **short-lived Harness that delivers one signal in one commit and closes**, before anything is scheduled (`Harness.signal()` and `wait()` start the scheduler; the runner's `deliver()` commits `tx.signal()` instead). A signal delivered early is kept by the task and consumed the next time the loop looks.
- `start` takes `runner.sqlite.lock` (a pid file; a dead pid is stale) and refuses a second `start`. `answer`, `pause`, and `resume` refuse (exit 1) while it is held; `status` reads regardless.
- `start` therefore does **not** wait in the foreground for an answer it could not see: when the loop is asleep on a decision or a pause and nothing can run, it prints where it waits and the commands to use, and exits 1. Answer, then run `start` again; the loop continues from storage (an answer is read at the loop's next pick).
- Consequence: a user `pause` reaches a loop only through the store, so it takes effect at the first pick after the next `start` (or, in a process that holds the Harness itself, as in the tests, at the next pick of the running loop). There is no remote pause of a running `start`.

## What the doc must look like

`start` refuses the doc, listing every error, unless it passes `validateForRun` (S7: each unfinished ticket has `done:`, known `deps:`, no cycles) and the runner-only rules:

- `T3 done: is not a command`: the runner can only run commands, so an unfinished ticket's `done:` must be a backticked command.
- the doc has a `## Log` section (every finished ticket appends one line).

## How it works

- `brigadev.ticket-loop`: `pick` (first ready ticket in doc order) → `launch` (mark it `in_progress`, create the child) → `record` (write `done` or `blocked` and one `## Log` line) → `pick`. A ticket that fails its attempts is `blocked` with `needs you: <reason>`; tickets that depend on it wait and independent ones continue. Two failed tickets in a row **pause** the loop (below). It ends `done` when every ticket is done or dropped, and `stalled` when only blocked or dependent tickets remain and no decision is open.
- `brigadev.ticket`: per attempt, a worker conversation owned by the task (instructions from `assets/agents/brigadev-worker.md` plus the ticket and, on a retry, the failure output). Then the done command runs in the repo: it passes when it exits 0 **and** HEAD moved since the ticket started (the worker must have committed). Up to 3 attempts.
- The doc is written only after re-reading it. A user edit to the running ticket's line or a finished one's pauses the loop (`doc edited: T#`) and nothing is overwritten; edits to pending tickets are picked up at the next pick; a changed spec reopens its linked done tickets (`reopened: S# changed`). Writes are atomic (temp file + rename).

## Decisions, approvals, pause and resume (S4, S9)

The human gates are pi-durable signals on the loop task, answered from the CLI after any restart. The signal kinds and key helpers are in `src/signals.ts`; T6's merge approval reuses `deliver`, `signalExit`, and `signalLine` with a kind of its own.

**Decisions.** The worker has a runner tool `ask_user_choice` (`src/decision.ts`) with the Pi tool's parameters: `question`, `options` (`{label, description?}`, 2–6), `recommended` (1-based), plus `command`: an exact bash command the worker needs approved. The worker never picks a product or design option; it asks. Calling the tool ends the attempt without a failure: the tool writes the question to a conversation document (`brigadev.decision`) in its own commit and returns `control: { terminate: true }`, which ends the run with no further model request; the ticket's `check` phase reads that document instead of running the done check, and the ticket task completes with `{ decision, attempts }` where `attempts` counts only the attempts before it. (A task can read only its own conversation's history, so a document is how the tool hands the question to the ticket task.) An invalid call (not 2–6 options, bad `recommended`) is an error result the worker sees; nothing parks.

The loop then records the ticket line as `— blocked needs you: decision: <question> (answer: brigadev-runner answer <doc> <T#> <1..n|text>)` (the doc path and ticket filled in) and one `## Log` line, and continues with independent ready tickets; tickets that depend on it wait. When nothing is ready and a decision is open, the loop sleeps on the `brigadev.answer` signal of every open decision, key `decision-<T#>-<round>` (`decision-T1-1`, then `decision-T1-2` for that ticket's next question; a key serves one wait and is never reused), with the earliest deadline. Each question's deadline is 24 h after it was asked and is memoized once. On a wake:

- answered: the ticket goes back to `in_progress` and reruns with a fresh attempt count; its brief has a `## Decision from the user` section (question, numbered options, the answer);
- expired: the line becomes `— blocked needs you: no answer within 24 h` (and a Log line), and the answer key is closed (a late `answer` is `closed`). One sleep has one deadline and expiry marks every unanswered key of that sleep, so when an earlier question expires the others get a new key (`decision-T3-2`) with their own deadline unchanged;
- the user hand-edited the parked line off `blocked` (e.g. back to `pending`) meanwhile: at the next pick it is theirs again, picked as usual, and its decision is dropped. (A sleeping loop is not woken by a doc edit; it reads the doc at its next pick, which an answer, a deadline, or a ticket finishing triggers.)

**Command approval.** The guard still denies confirm-class commands mid-run as `needs you: …` (Q6: nothing parks inside a tool call). The denial now tells the worker: if the ticket cannot be done without the command, call `ask_user_choice` with `command` set to the exact command and an option whose label starts with `Approve`. The rule for what approves it, kept simple: the decision has a `command`, and the answer is `--approve`, or the answer is an option whose label starts with `Approve` (by its number, or by typing the label exactly). Any other answer lifts nothing. When approved, the rerun's **first attempt's** worker conversation is created with a `brigadev.approval` document holding the command, and the guard lifts the permission policy's confirmation for a bash call whose command string is **identical** to it, **once**: the guard counts the conversation's earlier calls of that command from its history (which survives a reopen), so a second run, a different command, and a nested call (`call.parent`) are denied; a retry attempt gets no approval. The ticket is identified by the conversation (`api.conversationId`); only the ticket's own rerun creates a conversation with the document, so another ticket never gets it, and the guard fails closed when anything cannot be read. Nothing else is lifted: delivery blocks, never-allowed commands (`rm -rf /`), the commit gate, the branch rule, and the file rules all still apply.

**Pause and resume.** The loop no longer ends `paused`: it sleeps, with no deadline, on `brigadev.resume` key `resume-<n>`, and `status` shows `paused: <reason>`. Reasons: `two consecutive tickets failed: T1, T2`; `doc edited: T#` (S8: a user edit to a runner-owned line; nothing is overwritten); `paused by user` (`brigadev-runner pause`, a `brigadev.pause` signal `pause-<n>` that is read at the next `pick`, so the running ticket finishes first; the pause is not offered to a sleeping loop, which has nothing to pause). `resume` delivers the signal: after a conflict pause the doc is re-read by the phase that found the conflict, and if it is still there the loop pauses again (restore the runner's line, then `resume` again); after the failure pause the consecutive-failure count is reset. `n` is the loop's pause counter, so every pause and resume key is new.

## The worker obeys the guard

S5: the worker follows the same rules as the brigadev extension, decided by the Pi-free modules in `../lib/` (`guard-rules.ts`, `command-classifier.ts`, `permission-policy.ts`, `commit-branch.ts`, `evidence.ts`, `check.ts`, `repo-docs.ts`, `runtime.ts`), not copies of them.

- **One hook** (`src/guard.ts`): a `beforeTool` hook on pi-durable's `ToolTask`, selected by every worker conversation. It decides each call, including nested calls (`call.parent`, as a code mode script makes). A call it cannot decide is blocked (a throwing hook blocks in pi-durable too).
- **File tools** (`read`, `write`, `edit`) go through `decideFileAccess` with the worktree as the project root, as for an extension subagent: nothing is written outside the worktree, secret-looking files are blocked, and the evidence log is blocked. Also blocked for writes: git config and hooks (`isProtectedPath`) and anything in the repo's harness documents folder (the feature document is the runner's to write).
- **bash** goes through `decideBashCommand` with the permission mode from `~/.pi/agent/brigadev.json` (`defaultMode`, default normal), the evidence-write rule (`bashWritesEvidence`), and the branch rule: a commit is allowed only on a feature branch, in every mode.
- **Nothing asks.** A `confirm` result (`rm -rf`, `git reset --hard`, an install, `sudo`, a commit off a feature branch, ...) is denied with `needs you: <reason>` (Q6). The worker is told not to retry it, and, for a bash command, how to get it approved: a decision with `command` set (see [Decisions, approvals, pause and resume](#decisions-approvals-pause-and-resume-s4-s9)).
- **A commit stands alone**: a bash call that commits may hold only `cd` and `git add`/`status`/`diff`/`log`/`show`/`rev-parse`/`commit`, with no output redirection. The gate reads the working tree before the command runs, so a write in the same call would be committed untested.
- **The runner owns delivery**, whatever the mode: `git push` (also forced), `git pull`, `git merge`, `npm publish` and the other publish commands, `gh pr ...`, `gh release ...`, and `gh api` writes are blocked with `the runner owns PR delivery`.
- **Unknown tools are blocked.** The worker has `read`, `write`, `edit`, `bash`, `check`, and `ask_user_choice`.
- **Commit gate**: a `git commit` is allowed only when `evaluateCommitGate` allows it for the current tree, against the same evidence file the extension reads (`<docs>/evidence/<branch>.jsonl`): a passing test run on this exact tree (or a docs-only change). A blocked commit returns the gate's reason to the worker. The worker cannot force it.
- **`check` tool** (`src/check-tool.ts`): the extension's `check` over `lib/check.ts`: same parameters (`command`, `focus`, `timeoutSeconds`), the command from `check.test` in `brigadev.json` or detection, the same refusal of commits, pushes, and publishing, a compact `PASS`/`FAIL` result, and the run is appended to the evidence file with agent `runner-worker`. The worker's instructions say to run `check` before committing and to make no edit between `check` and `git commit`. Tests run through `bash` are not recorded.

Differences from the extension's subagent rules, on purpose: the worker must commit (bash is decided like the parent's, files like a child's), the commit gate applies to it, the branch rule holds in yolo too, there is no one to confirm so confirmations are denials, and delivery is always blocked.

## Tests

```sh
cd runner
node --test tests/*.test.ts      # or: npm test
```

Tests use pi-ai's scripted faux provider and a temp git repo on a feature branch; no network, no model. The guard, the evidence log, and `brigadev.json` read the environment, so the tests point `BRIGADEV_HOME` and `PI_CODING_AGENT_DIR` at a temp dir (`isolateEnv()` in `tests/fixture.ts`): the real `~/.brigadev` is never written. They take minutes where `git` is slow to spawn, because every scripted commit runs the commit gate (several git calls) on top of a real `git commit`. The persistence tests close the Harness while ticket 1's done command is running (after the worker answered), reopen the same JSONL / SQLite storage, and check ticket 1 is not run again. `tests/decisions.test.ts` parks a decision, closes, reopens (JSONL and SQLite), delivers the answer without scheduling, and resumes; it drives deadlines with the manual clock `fakeClock()` (the Harness `now`/`setTimer` options). `tests/pause.test.ts` and `tests/control.test.ts` cover pause/resume and the CLI commands.
