# brigadev-runner

A headless, durable ticket runner for the brigadev workflow. It takes a feature doc whose `## Tasks` list the user approved and runs the tickets one at a time, each in a fresh worker conversation, on [`@earendil-works/pi-durable`](https://www.npmjs.com/package/@earendil-works/pi-durable). State lives in storage (SQLite by default), so killing the process and starting it again resumes at the last checkpoint instead of redoing finished tickets.

This package is a separate, private package: the Pi extension in the repo root does not depend on it. It reuses the Pi-free modules in `../lib/` (`ticket-list.ts`, `agents.ts`, and the guard, evidence, and check modules listed under [The worker obeys the guard](#the-worker-obeys-the-guard)) by relative import.

## Status: experimental

- `pi-durable` is itself marked experimental and its API changes without notice, so the four `@earendil-works/*` dependencies are pinned to exactly `1.6.0` (Pi 1.5.2 ships pi-ai 1.5.2, which is why this is not part of the root package).
- Prototype scope (`tasks/durable-runner.md`): the ticket loop (T3), its guard, check tool, and commit gate (T4), and the human gates as durable signals: ticket decisions, command approvals, pause and resume, and the `status`/`answer`/`pause`/`resume` commands (T5). The PR → CI → merge loop with its merge-approval signal (T6, see [The PR loop](#the-pr-loop-s2b-s3-s4)). Not there yet: the board (T7), cost caps, parallel tickets, releases. The **worker** never pushes, merges, or publishes (its guard blocks them); the **runner** does, in deterministic code, only in the PR loop.

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
node <path-to>/runner/src/cli.ts start ~/.brigadev/<repo>/tasks/<feature>.md            # tickets, then the PR loop
node <path-to>/runner/src/cli.ts start ~/.brigadev/<repo>/tasks/<feature>.md --no-pr    # tickets only
```

State is stored in `<brigadev home>/<repo>/runner.sqlite` (`~/.brigadev/<repo>/` unless `BRIGADEV_HOME` is set; `<repo>` is the main checkout's folder name, shared by every worktree, like the feature documents and the evidence). Running `start` again for the same doc finds the same loop task and continues it. Exit codes: 0 every ticket done (and, with the PR loop, the PR merged), 1 refused, failed, stalled, or parked (waiting for a decision, a resume, or the merge approval), 2 usage.

## Commands

```sh
brigadev-runner start  <feature-doc> [--no-pr]                    # run the loop (and the PR loop); returns when it ends or parks on a person
brigadev-runner status <feature-doc>                              # read-only
brigadev-runner answer <feature-doc> <T#> <1..n|text> [--approve]  # answer a parked decision
brigadev-runner pause  <feature-doc>                              # pause at the next pick
brigadev-runner resume <feature-doc>                              # lift a pause, or a PR loop stop (needs-you)
brigadev-runner merge  <feature-doc>                              # approve the merge of the PR the PR loop opened
```

- `status` prints the loop state (`running`, `sleeping`, `paused: <reason>`, `done`, `stalled`, `failed`), every ticket's status from the doc, and each open decision with its numbered options, the `(recommended)` mark, the deadline, and the exact `brigadev-runner answer <doc> <T#> <1..n|text>` command. It opens the store read-only: nothing is recovered, written, or scheduled, and it creates nothing for a doc that was never started.
- `answer`: the choice is an option number or free text (several words need no quotes). A number outside the options is `invalid` (exit 2) with the reason. `--approve` approves the decision's `command` whatever the option labels say.
- Signal results map to output and exit codes: `delivered` 0; `duplicate` and `closed` are final answers, printed as such, 1 (a second answer, or an answer after the deadline or after the loop ended); `invalid` 2 with the reason; `not_found` 1 (no such loop, or no decision for that ticket). `pause` while paused and `resume` while not paused are refused (1): a stale `resume` would otherwise lift the next pause.
- `merge` delivers the merge approval to the PR loop (see below); like `answer`, it needs no API key, runs nothing, refuses while a `start` holds the store, and maps `duplicate`/`closed`/`not_found` to final answers (exit 1). It is refused (exit 1) unless the PR loop is waiting for the approval, and says where it is instead.
- `answer`, `pause`, `resume`, and `merge` check the doc like `start` does (it must be readable and valid), but not the worktree rule: they touch no checkout. They need no API key and never run a worker.

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

## The PR loop (S2b, S3, S4)

`start` ends the ticket loop with the PR loop unless `--no-pr` is given (the loop task's own default is off, so a loop started through the API with `pr` unset ends `done` as before). It runs when no ticket is left to run: every ticket done or dropped and nothing parked on a decision. `start` is idempotent per doc, so the `--no-pr` choice is the one the loop was first started with.

The PR loop is one child task, `brigadev.pr-loop`, launched in one commit that also records its id (a crash never launches a second). **Every git and GitHub action is deterministic runner code through an injectable seam (`PrDeps` in `src/pr.ts`), never a worker tool**: the worker's guard still blocks push, merge, and `gh pr`/`gh release` (a test checks that a fix worker's `git push` is blocked). Phases:

1. **final-check**: the full suite (`resolveCommand`, as the `check` tool does), recorded as evidence by agent `runner`. A failure goes to fix.
2. **verify**: the tier is `branchRisk` over the risk map; only **T2** (or a tier that cannot be known: no base branch) runs `brigadev-verify`. T0/T1 skip it. The verify conversation is owned by the PR loop, with the prompt of `assets/agents/brigadev-verify.md` and the tools `read`, `bash`, and `verify_verdict`. It ends through that terminating tool (the same pattern as `ask_user_choice`: the tool records the verdict in a conversation document and returns `control: { terminate: true }`; the shape is `assets/agents/brigadev-verify.schema.json`, checked with `lib/structured-output.ts`), not by parsing text. Blockers become one fix ticket per verify round with the blockers (each with its reproduction) as its spec, then verify runs again. A run that ends with no verdict, or that leaves the worktree changed (HEAD or files), stops for a person.
3. **push**: `git push -u origin HEAD:<branch>`, never forced, skipped when `git ls-remote origin` already shows that sha, so a crash never pushes a commit twice.
4. **open**: the branch's PR is looked up first (`lookupPr`); `gh pr create --base <default branch> --head <branch> --title <t> --body-file <tmp>` only when there is none, so a crash between create and the checkpoint finds the PR again. The title is conventional: the branch type (`feat/x` → `feat:`; an unknown prefix is `chore:`) and the doc's first heading, else the Objective's first sentence. The body has the objective, the tickets with their commits, the risk tier line, and `Opened by brigadev-runner.` A branch with no commits ahead of its base stops with needs-you instead.
5. **wait-ci**: the task sleeps until now + 60 s (`POLL_MS`, the Harness clock), then reads `gh pr view <n> --json headRefOid,statusCheckRollup,state,isDraft`. Results for a head other than the pushed sha are ignored; pending sleeps again; no checks reported counts as green; a wait lasts at most 24 h, then needs-you. A failure fetches the filtered log (`gh run view <id> --log-failed`, its tail) and goes to fix. A CI wait is a timer of the `start` process: `start` stays in the foreground for it, and parks (exit 1) only when a person is needed.
6. **fix**: the existing `brigadev.ticket` task with a synthetic ticket `FIX-1`, `FIX-2`, ... The brief's `## Spec` carries the failure tail (or the blockers) and "reproduce it with a failing test first (RED), then fix it, run the suite (GREEN), and commit"; `done` is the suite command. One worker attempt per fix, and **3 fix attempts per PR loop**, shared by final-check, verify, and CI. A passing fix goes to push → wait-ci (for CI) or to verify (for final-check and verify). A fix ticket's decision parks exactly like a ticket's (`status` shows it; `brigadev-runner answer <doc> FIX-1 ...`; 24 h; no attempt is used).
7. **wait-merge**: when CI is green, one PR comment `Ready to merge: run \`brigadev-runner merge <doc>\``, then the task parks on the `brigadev.merge` signal, key `merge-<n>`, deadline 24 h. The runner **never merges without it**. On delivery it re-reads the PR and merges only if the PR is open, not a draft, its head is the pushed sha, and no check is failing or pending; otherwise it goes back to wait-ci (and asks for a new approval, key `merge-<n+1>`, with a new comment). Merge is `gh pr merge <n> --merge --match-head-commit <pushed sha>` (never `--admin`, `--auto`, or `--delete-branch`), after the re-read; GitHub refuses it if the head moved in between, which stops for you, so a crash after the merge finds the PR merged and does not merge again. An approval not given within 24 h stops with `merge approval expired`.

A PR merged by someone else ends the loop `merged` too. The loop's result is `{ status: "merged", url, number, tickets }`; `pr-failed` if the PR loop task itself failed or was aborted.

**Needs you.** Any stop in the PR loop (3 fix attempts used, an expired approval or CI wait, a refused push, a closed PR, a verify without a verdict, no commits to open a PR for, ...) posts **one PR comment** (`gh pr comment <n> --body-file`, once per stop; skipped when no PR exists yet), appends one `## Log` line through the doc's atomic write, and parks on `brigadev.resume` (key `resume-<n>`, no deadline). `status` shows `pr: needs-you` with the reason; `brigadev-runner resume <doc>` continues at the phase that stopped with a fresh fix budget.

**What the runner does on GitHub**: `gh pr view`, `gh pr create`, `gh pr comment` (the ready-to-merge and the needs-you comments), `gh run view --log-failed`, `gh pr merge <n> --merge --match-head-commit <sha>`, and `git push -u origin HEAD:<branch>`. Nothing else: no force push, no delete branch, no release, no admin or auto merge.

**Persistence (S3).** Each phase is safe to rerun: the suite and the reads repeat; the push asks the remote first; the PR is looked up before it is created; the fix budget is charged in the commit that creates the fix ticket (the fix ticket's own conversation is found again by position); a merge re-reads the PR first. A comment is memoized *before* it is posted, so a crash between the two can lose a comment but never duplicates it (`status` still shows the command). `tests/pr-persistence.test.ts` kills the runner at final-check, push, open (between create and the checkpoint), wait-ci, fix, and wait-merge (also right after `gh pr merge`, and with the approval expired meanwhile), on JSONL and SQLite.

`status` shows the PR phase (`final-check`, `verify`, `push`, `open`, `wait-ci`, `fix <n>`, `wait-merge`, `needs-you`), the PR url, and the `merge:` / `resume:` command while the PR loop waits for one.

Not in the PR loop yet: cost caps (the L8 limits), the board (T7).

## The worker obeys the guard

S5: the worker follows the same rules as the brigadev extension, decided by the Pi-free modules in `../lib/` (`guard-rules.ts`, `command-classifier.ts`, `permission-policy.ts`, `commit-branch.ts`, `evidence.ts`, `check.ts`, `repo-docs.ts`, `runtime.ts`), not copies of them.

- **One hook** (`src/guard.ts`): a `beforeTool` hook on pi-durable's `ToolTask`, selected by every worker conversation. It decides each call, including nested calls (`call.parent`, as a code mode script makes). A call it cannot decide is blocked (a throwing hook blocks in pi-durable too).
- **File tools** (`read`, `write`, `edit`) go through `decideFileAccess` with the worktree as the project root, as for an extension subagent: nothing is written outside the worktree, secret-looking files are blocked, and the evidence log is blocked. Also blocked for writes: git config and hooks (`isProtectedPath`) and anything in the repo's harness documents folder (the feature document is the runner's to write).
- **bash** goes through `decideBashCommand` with the permission mode from `~/.pi/agent/brigadev.json` (`defaultMode`, default normal), the evidence-write rule (`bashWritesEvidence`), and the branch rule: a commit is allowed only on a feature branch, in every mode.
- **Nothing asks.** A `confirm` result (`rm -rf`, `git reset --hard`, an install, `sudo`, a commit off a feature branch, ...) is denied with `needs you: <reason>` (Q6). The worker is told not to retry it, and, for a bash command, how to get it approved: a decision with `command` set (see [Decisions, approvals, pause and resume](#decisions-approvals-pause-and-resume-s4-s9)).
- **A commit stands alone**: a bash call that commits may hold only `cd` and `git add`/`status`/`diff`/`log`/`show`/`rev-parse`/`commit`, with no output redirection. The gate reads the working tree before the command runs, so a write in the same call would be committed untested.
- **The runner owns delivery**, whatever the mode: `git push` (also forced), `git pull`, `git merge`, `npm publish` and the other publish commands, `gh pr ...`, `gh release ...`, and `gh api` writes are blocked with `the runner owns PR delivery`.
- **Unknown tools are blocked.** The worker has `read`, `write`, `edit`, `bash`, `check`, and `ask_user_choice`.
- **The verifier is read-only.** The PR loop's verify conversation is marked by a `brigadev.role` document and decided by a read-only guard (`readOnly: true`): its tools are `read`, `bash`, and `verify_verdict`; `write`/`edit` do not exist for it; bash may not commit, may run only read-only git subcommands (`status`, `diff`, `log`, `show`, `rev-parse`, ...), and may not write a file inside the worktree by a literal name (redirections, `tee`, `cp`, ...). Like the extension's rules for bash this is best effort (an interpreter can still write), so the PR loop also compares HEAD and `git status` before and after the run and stops for a person if they changed. A role that cannot be read fails closed (both rule sets apply).
- **Commit gate**: a `git commit` is allowed only when `evaluateCommitGate` allows it for the current tree, against the same evidence file the extension reads (`<docs>/evidence/<branch>.jsonl`): a passing test run on this exact tree (or a docs-only change). A blocked commit returns the gate's reason to the worker. The worker cannot force it.
- **`check` tool** (`src/check-tool.ts`): the extension's `check` over `lib/check.ts`: same parameters (`command`, `focus`, `timeoutSeconds`), the command from `check.test` in `brigadev.json` or detection, the same refusal of commits, pushes, and publishing, a compact `PASS`/`FAIL` result, and the run is appended to the evidence file with agent `runner-worker`. The worker's instructions say to run `check` before committing and to make no edit between `check` and `git commit`. Tests run through `bash` are not recorded.

Differences from the extension's subagent rules, on purpose: the worker must commit (bash is decided like the parent's, files like a child's), the commit gate applies to it, the branch rule holds in yolo too, there is no one to confirm so confirmations are denials, and delivery is always blocked.

## Tests

```sh
cd runner
node --test tests/*.test.ts      # or: npm test
```

Tests use pi-ai's scripted faux provider and a temp git repo on a feature branch; no network, no model. The guard, the evidence log, and `brigadev.json` read the environment, so the tests point `BRIGADEV_HOME` and `PI_CODING_AGENT_DIR` at a temp dir (`isolateEnv()` in `tests/fixture.ts`): the real `~/.brigadev` is never written. They take minutes where `git` is slow to spawn, because every scripted commit runs the commit gate (several git calls) on top of a real `git commit`. The persistence tests close the Harness while ticket 1's done command is running (after the worker answered), reopen the same JSONL / SQLite storage, and check ticket 1 is not run again. `tests/decisions.test.ts` parks a decision, closes, reopens (JSONL and SQLite), delivers the answer without scheduling, and resumes; it drives deadlines with the manual clock `fakeClock()` (the Harness `now`/`setTimer` options). `tests/pause.test.ts` and `tests/control.test.ts` cover pause/resume and the CLI commands.

The PR loop tests (`tests/pr-loop.test.ts`, `pr-persistence.test.ts`, `pr-cli.test.ts`) use a real local bare git remote (`<tmp>/remote.git` as `origin`, real `git push`) and a fake `gh` (`tests/pr-fixture.ts`) that keeps its own PRs, comments, checks, and merges; only `gh` is faked. CI polls are driven with the manual clock (`clock.advance(POLL_MS)`), and a kill is `runner.close()` while an outside call hangs, then a reopen of the same storage with the same clock.
