# Changelog

## [Unreleased]

## [0.27.0] - 2026-11-27

Permission dialogs say what the action will do, why the agent wants it (its `# why:` comment), and the risk: level, whether it can be undone, and who it affects. The guard also closes a gap where a quote inside a shell comment hid the next lines of a command from it.

### Changed

- The guard's permission dialogs explain the action in plain words: WHAT IT WILL DO (a sentence and the command), WHY (the agent's reason), and RISK (level, what could go wrong, whether it can be undone, who it affects). The agent gives its reason with a `# why: <reason>` comment on the command; without one the dialog warns that no reason was given. The reason's control characters are shown as escapes, so it cannot draw fake lines. Dialog titles change from `brigadev: <reason>` to `brigadev · Needs your permission: <action>` (also on the web prompt); the guard bus keeps the terse `brigadev: <reason>`.

### Fixed

- A quote or `<<` inside a shell comment (`# why: it's stale`) hid the next lines from the guard, so a push, a removal, or a publish after it ran without asking. The guard now judges each command both as written and with its comments blanked, and combines what it finds, so neither reading can hide a command from the other.
- `$'…'` (ANSI-C quoting): `\'` no longer ends the quote for the guard, so `echo $'\' #'; rm -rf build` asks like `rm -rf build`.

## [0.26.0] - 2026-11-26

brigadev runs well inside T3 Code: an optional `brigadev-t3` add-on shows status chips and settles where the two sets of rules overlap, and `ask_user_choice` opens real dialogs in RPC clients. MCP tools that open a PR, merge, or push now go through the guard like their gh/git commands, and subagents no longer inherit MCP server credentials.

### Added

- `t3/`: brigadev-t3, an optional add-on for T3 Code (load it with `-e <path>/t3` in Pi's launch arguments in T3 Code's settings). It adds status chips for the loop phase, todo progress, and the last check, and a prompt section that settles where brigadev's and T3's rules overlap (subagents, PR tools, CI waits). It reads only the `brigadev:*` bus and does nothing outside T3 Code; `tests/t3-contract.test.ts` checks the channels it reads.
- `ask_user_choice` asks with Pi's standard select and input dialogs in an RPC client with a UI (T3 Code, any `pi --mode rpc` front end) instead of telling the model to ask in chat.

### Fixed

- MCP tools that open a PR, merge, or push (T3 Code's `pull_request_create` / `pull_request_merge`, GitHub MCP's `create_pull_request`, `merge_pull_request`, `push_files`, …) ran with no guard decision. They now follow the policy of the gh/git commands they stand for, and opening a PR runs the PR gate. Names Pi cut to 64 characters are read as the strictest tool they could be.
- Subagents no longer inherit environment variables named for an MCP server (`T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, …).

## [0.25.0] - 2026-11-25

The pull request becomes the gate: commits are never blocked on test evidence, `gh pr create` needs a passing full-suite run on the committed HEAD, and every push and PR creation asks you in every mode (YOLO included). Deletes in the temp folders stop asking, and the runner gets a dollar cost cap per loop. Breaking: `/brigadev:force-commit` is gone, and YOLO asks before pushes and PRs.

### Added

- `brigadev-runner` has a dollar cost cap per loop: `start <doc> --cap <dollars>` (default $5, a positive number; stored with the loop, so a reopen keeps it, and a later `start` without `--cap` keeps it). The spend is the sum of the costs `pi.usage` records for every conversation the loop owns (ticket attempts, verify, fix tickets; failed attempts count; usage a provider does not report is not counted). It is checked before each ticket attempt, verify and fix ticket: at or over the cap the loop parks needs-you (`cost cap reached: $5.12 of $5.00 spent`; `status`, the PR comment and the board's Needs you column show it), and inside a running conversation the guard blocks every further tool call. Every worker and verify run also takes at most `runner.maxTurns` tool rounds (brigadev.json, default 60), so a run that keeps calling blocked tools ends there: the overshoot is at most the run in progress. Loops started before this version have no ledger, so their earlier spend is not counted. `brigadev-runner resume <doc> --cap <dollars>` (or the board's cost-cap prompt) continues with a cap above the spend; a cap at or below the spend is refused, and so is a plain `resume` there unless `start --cap` already raised the cap above the spend. `status` prints `spend $X of $Y`, and the board shows it with each ticket's own spend.

### Changed

- **Every `git push` and `gh pr create` (or `gh pr new`) asks the user, in every permission mode.** So do `git subtree push`, `gh repo create --push`, and a PR opened through `gh api` (a POST to `repos/<o>/<r>/pulls`, or the `createPullRequest` mutation). YOLO no longer gives standing permission for them; it still runs commits, issue writes, and PR comments without asking. Without a UI they are blocked. The PR gate's reasons ride the same dialog.
- `gh pr --repo <o/r> create` (and `-R`, before the action) is read as a PR creation: it ran without asking and skipped the PR gate.
- **Breaking: the evidence gate moved from `git commit` to `gh pr create`.** Commits are never gated on test evidence (in the session, subagents, and the runner's worker). Instead `gh pr create` on a branch that commits source asks (in every mode; in normal mode inside the PR confirmation) and blocks without a UI until a passing test run is recorded for the committed HEAD: a run on exactly HEAD's tree, or HEAD's tree without doc paths. When the project's test command is known (`check.test` or detected), only a run of that exact command counts, so a `check` with `focus` does not vouch for the PR, and the latest suite run on HEAD decides (a later failure revokes an earlier pass). Uncommitted edits do not matter; docs-only branches need no run. The PR gate also asks instead of passing when it cannot read the facts (an unreadable evidence log, git failing, a `git diff` of the branch that fails). `worktreeTreeResult` takes `commit` to key a commit's tree, and `branchRisk` reports the `committed` paths.
- Deleting in the temp dirs runs without asking: `rm -r` and `rm -f` of literal paths strictly inside `/tmp`, `/private/tmp`, or `os.tmpdir()`, of `$TMPDIR/<path>` (when the guard's `TMPDIR` is set and the command does not set it), and of a quoted `"$d"` the command's first statement assigned from a default `mktemp` (`d=$(mktemp -d) && … && rm -rf "$d"`, every other mention of `d` a quoted read). Before, only `rm -r` of a literal `os.tmpdir()` path did, so on macOS every `/tmp` cleanup asked. A temp root itself, globs, `..`, `$d/<path>`, a `mktemp` with a template or `-p` folder, and mixed targets still ask, and the variable rules are off in a command that could rebind the variable or replace `mktemp` (`eval`, `source`, functions, `printf -v`, `read`, `declare`, `IFS`, `PATH=`, …).

### Fixed

- A recursive `rm` of a temp path that resolves outside the temp dir through a symlink (`rm -rf $TMPDIR/link/sub`) asks again; it ran without asking before.
- `gh pr new` and `gh issue new` (gh's aliases of `create`) are classified like `gh pr create` and `gh issue create`: they ask in normal mode and go through the PR gate, where before they ran unasked.

### Removed

- `/brigadev:force-commit` and the commit gate's dialog. Older evidence logs keep their `force` records, and `brigadev-branch-pr` still discloses them. The runner's worker no longer needs a passing `check` on the exact tree to commit; the PR loop's final check runs the full suite before any push.

## [0.24.0] - 2026-11-22

The durable runner's own loop board (`start --web`), hardened against the worker it supervises, and a fix that keeps SIGUSR1 from opening Node's inspector in Pi or the runner (in 0.23.0 a child process could get an unauthenticated debugger in its parent: upgrade).

### Added

- `brigadev-runner start <doc> --web [--port N]` serves the web UI's loop board from the runner process (`BRIGADEV_WEB_PORT` also sets the port). The tickets, the PR loop, and what needs you (ticket decisions, the merge approval, a paused loop) show on the board, and answering, approving the merge, resuming, and pausing work from the browser, in the process that holds the store, so the loop continues without another `start`. `--web` needs stdin and stdout to be terminals (exit 2 otherwise, before anything starts) and refuses inside tmux, screen or zellij unless `--web-in-multiplexer` is given (exit 2 with the reason, a warning with the override), and in the background of its terminal (`start --web &`: reading the terminal there would stop the process with SIGTTIN; exit 2, run it in the foreground). The one-time link is written to that terminal only, and a fresh one comes only from Enter there (no signal prints one). The web page has a runner mode (`session` snapshot `kind: "runner"`, optional `doc`): no composer, Pause instead of Abort, no cancel buttons; parked tickets show as `needs-you` or `blocked`; a prompt the loop moved past closes as "no longer current" (an optional `reason` on a dismissed `PromptState`, shown in place of "dismissed"); `webPage({ variant: "runner" })` tells a signed-out user to press Enter in the runner's terminal for a new link. `answer`, `pause`, `resume`, and `merge` refusals while a `start` holds the store now point at the board.

### Security

- The runner's board could be signed into by the worker it supervises: a background script of the worker's bash (`nohup sh steal.sh &`, which outlived the call) sent SIGUSR1 to the runner to make it print a fresh link, read the link from the runner's stdout file or a tmux pane, signed in, and answered its own decision with `Approve: rm -rf build`. Now no signal prints a link, `--web` runs only on a terminal and not in a multiplexer (above), every bash call of a worker, verifier or fix conversation runs in its own session without a controlling terminal and its whole process group is killed when the call returns (a process that makes its own session or group still escapes: documented in `runner/README.md`; a SIGTERM-ignoring one is killed at once when the environment closes or the runner exits, not only after the 1 s grace), an answer from the board acts only on the prompt the page showed (the decision key, the merge key and PR head commit, the resume key) and is refused with 409 when the state moved in between, and the board also masks standard base64 secrets (`runner/src/redact.ts`) and what a refusal says.
- SIGUSR1 no longer opens Node's inspector in Pi (the guard installs a listener when it loads) or in `brigadev-runner` (its CLI holds one, and `npm start` passes `--disable-sigusr1`). Before, the agent's bash could send `kill -USR1` to its parent and get an unauthenticated debugger on 127.0.0.1: in Pi, code running past the guard; in the runner, code running with the credentials the containment keeps from the worker. To debug Pi, start it with `--inspect`; SIGUSR1 no longer opens the inspector once the guard has loaded. Run the runner with `node --disable-sigusr1` rather than `npm start`, whose own npm process is still open to the signal.

## [0.23.0] - 2026-11-21

The 0.23.0 release: everything in the pre-releases rc.1–rc.4 below (the web UI loop board, the brigadev bus, codemode by default, the durable runner, CI), plus these fixes from the pre-release review.

### Security

- Web UI: the long-lived `?token=` URL is gone. `/brigadev:web start` prints a one-time link (a 32-byte `code`, valid 60 s, spent on first use); the page removes the code from the address bar, trades it with `POST /session` for a random session secret, keeps the secret only in a JavaScript variable, and sends it as `Authorization: Bearer` (the event stream is read with `fetch`, resuming with `Last-Event-ID`). A token or secret in a query string is refused; `stop` revokes every secret. Before, the token stayed in the browser's history and was valid for the whole session, so any process of the same user could read it and approve guard prompts. `/brigadev:web open` prints a new link; `status` shows the address without a code.
- Commands and details that go to the web page or the bus are redacted: credentials in URLs, `Authorization` headers, token-like strings, and password flags (`lib/redact.ts`).

### Fixed

- A guard confirm or `ask_user_choice` that is open when the run is aborted (Esc, the web Abort) now closes in the terminal and the browser and counts as not approved, so a late answer cannot resume an aborted call. A web answer to a prompt that is no longer open gets 409, and the page shows why.
- The web UI and the dashboard adapter remove their bus listeners at session shutdown, so a reload no longer doubles events and footer segments.
- The web UI's event replay waits for slow readers instead of cutting the stream at the 4 MB backlog cap; the cap still applies to a live client that stops reading.
- The web log keeps `mode`, `todo`, `session`, `phase` and the live run state however many tool calls pass; per-item types (tools, agents, prompts) have their own caps.
- Codemode is activated only when the host Pi has the tool; `/brigadev:codemode` says so when it does not. A `codemode` call counts as explore for the inferred phase until its nested calls (which Pi reports) move it, and the timeline marks them with their parent.
- `/brigadev:codemode off` also drops `codemode` from the subagents' tool lists at launch.
- The web page's markdown parser is linear on unmatched `*`, `_` and `[` openers (15k characters took 1.7 s).

## [0.23.0-rc.4] - 2026-11-21

Pre-release.

### Added

- The parent session activates Pi's built-in `codemode` tool at start, next to `grep`, `find`, and `ls`. `/brigadev:codemode on|off` turns it on or off now and for new sessions (`codemode` in `brigadev.json`); off leaves a `codemode` enabled by Pi's own `defaultTools` alone. Tool calls made from codemode scripts still pass the guard.
- While `codemode` is active, the parent's prompt gains a short block (`assets/codemode.md`): run an explore batch as one parallel script that returns only the needed lines, and gather git/PR/CI state (`gh pr checks`, `gh run view --log-failed`) into one digest. `diagnosis.md` says the same for CI failures.
- `brigadev-explore`, `review-4r`, and `brigadev-verify` list `codemode` and say when to use it. The worker does not.
- Feature-document tickets carry `deps:` (the tickets they need) and `done:` (the check that proves them), documented in `odd-tracking.md`. `lib/ticket-list.ts` parses the `## Tasks` list, validates it for an unattended run (missing `done:`, unknown deps, duplicates, cycles), picks ready tickets, writes a status or a `## Log` line back without touching other lines, detects edits to lines a runner owns and changed specs, and writes files atomically.
- `runner/`: `brigadev-runner`, a separate package on `@earendil-works/pi-durable` (prototype). It runs a feature doc's ticket list unattended in a linked worktree, one fresh worker conversation per ticket, and survives restarts. Decisions, command approvals, pause and resume are durable signals (`brigadev-runner status | answer | pause | resume | merge`). When every ticket is done, a PR loop runs: final check, read-only verify on T2 branches, push (never forced), open the PR, wait for CI with up to 3 fix tickets, and merge only after `brigadev-runner merge <doc>`. Workers run without the user's credentials, and the doc, settings, git config, hooks and refs are checked around every conversation; any change parks the loop. See `runner/README.md`, including what containment cannot stop.
- CI: `.github/workflows/test.yml` runs `npm test` and the runner suite on Node 22 and 24 for every pull request and push to `main`.

### Fixed

- The `check` tool reads Node's TAP summary (`# pass N`), which Node 22 prints when output is piped; before, Node 22 runs had no counts.
- The guard's trusted temp folders list only folders that exist (`/private/tmp` is macOS only).

### Security

- A subagent may call only its own tools (its active `tools:` list). A codemode script could otherwise reach tools that are callable without being active, such as MCP tools.

## [0.23.0-rc.3] - 2026-11-20

### Changed

- Web UI redesigned as a loop board: one column per loop step plus a red **Needs you** column for open guard and `ask_user_choice` prompts. Subagent runs, checks, commits, your choices and the main agent's tool calls are cards in the step where they happened, with status, verdict, model, tokens, cost and elapsed time. A card opens a side panel (output, activity, task; check details; the conversation; tasks; guard log) that leaves the message box usable.
- `brigadev:agent` snapshots also carry the whole task, the launch reason, the child's last 12 tool calls, and the output once settled. The web UI also receives the session's project and branch.

## [0.23.0-rc.2] - 2026-11-20

Pre-release.

### Fixed

- Web UI: assistant messages render as markdown: headings, emphasis, code, lists and task lists, quotes, tables, and http(s) links. The parser (`assets/web-ui/markdown.js`) returns a tree that the page turns into DOM nodes, so agent text never becomes HTML.
- Web UI: scrollbars follow the dark theme.

## [0.23.0-rc.1] - 2026-11-20

Pre-release.

### Added

- `/brigadev:web [start|stop|status]`: a local web UI for the current session on `127.0.0.1`, ephemeral port or `BRIGADEV_WEB_PORT`. `/events` and `/action` require a random token, which the page removes from the address bar. The page is one static file with no dependencies, and it replays the session history over SSE. It shows:
  - the loop steps and the conversation with tool rows;
  - subagent cards with per-task cancel;
  - guard and `ask_user_choice` prompts that can be answered from the browser;
  - checks, todos and guard decisions;
  - a composer to send, steer and abort.
- The brigadev bus (`lib/bus.ts`): typed `brigadev:*` channels on `pi.events` for the loop phase, todos, checks, subagent tasks, prompts, guard decisions and the permission mode. Publishing never throws, and actions coming back from the browser are validated.
- The inferred loop phase (`lib/phase.ts`, `extensions/workflow-state.ts`): authorize, explore, decide, implement, check, commit or close, guessed from tool activity and labeled as inferred.
- Guard confirmations and `ask_user_choice` can be answered in the terminal or the browser. The first answer wins and the other dialog closes.
- Cancelling one subagent task: a queued task never starts and a running one is stopped, while its siblings and the launch go on. The result reads "Cancelled by the user". A cancel that lands after the child finished keeps its result.
- pi-agent-dashboard adapter: when the dashboard is installed, the bus channels are declared for its event forwarding, and the harness adds a loop breadcrumb and footer segments.

## [0.22.0] - 2026-11-19

### Added

- Review tiers: a path-based risk map (`lib/risk-map.ts`, extra globs under `risk` in `brigadev.json`) sets the branch tier — T0 tests/docs only, T1 one review with the fitting lenses, T2 one `brigadev-verify` plus those lenses before the PR. `check` prints the tier when it changes; `/brigadev:doctor` reports invalid `risk` entries.
- Finished `brigadev-verify` runs are recorded in the evidence log (`type: "verify"`).
- `gh pr create` asks, in every mode, when a T2 branch has no verify run or verify blockers have no repro test that failed and then passed.
- Profile key `brigadev-verify-recheck` routes a recheck to a cheaper model.

### Changed

- Verify runs once per branch before the PR instead of after every unit; a second branch verify on the same source tree is refused and a changed tree asks. A recheck is allowed only for security or data blockers, at most once, with `recheck <ids>` in the launch reason.
- Blocker fixes are proven by a repro test RED→GREEN instead of a re-review; correction batches are the blockers plus at most five defect WARNINGs in the same files.
- R2 Readability runs only for prompt/docs diffs or on request. `review-4r` calibrates severity (CRITICAL is a shipped defect; test gaps and wording cap at WARNING) and has an R1 checklist (git config that runs programs, symlinks, fail-open parsing, ReDoS).
- Compact review results and ledgers list blockers in full, the top five WARNINGs, and a SUGGESTION count.
- Brace alternation (`{a,b}`) in writer edit-surface globs now means alternation, not literal braces.

## [0.21.0] - 2026-11-19

### Breaking

- DSP mode is gone: `/brigadev:mode dsp`, the credential lock, DSP backups and audit log. A stored `dsp` mode falls back to `normal`.
- Subagents are sync-only: no `async`, `subagent_wait`, `subagent_cancel`, idle result delivery, run budget (`budgetMinutes`), steering, or viewer takeover. Children run in `pi --mode json`.
- Model fallback chains are gone: profile `fallbacks`, `/brigadev:profile fallback`, and the orchestrator and subagent retries on another model.
- Judgment Day and the four `review-*` lens agents are replaced by one `review-4r` agent; the `jd-*` agents and schema are removed.
- The `fd`/`rg` tools, the launch dashboard, command palette, side panel, tidy (and the bundled `pi-tidy`), phase label, `/btw`, `/brigadev:copy-all`, `/brigadev:outside` and its outside-writes ledger, and the exploration-budget and context-backstop notices are removed. The `ui.dashboard`, `ui.phase`, and `tidy` settings no longer exist; `ui.compactTools` is now on unless `false` (the `auto` value is gone).
- `/brigadev:usage` is merged into `/brigadev:cost`.
- Skills `brigadev-work-unit-commits` and `brigadev-chained-pr` are merged into `brigadev-branch-pr`; `brigadev-skill-creator` is removed.
- Workflows are down to feature, ticket, bug fix, refactor, my PRs' feedback, and team review; quick change, new feature, and big feature are merged into feature; UI change, dependency upgrade, create issue, and open PR are removed.
- The verifier admission takes `Risk: <category>` (data, security, contract, concurrency, delivery, untested) instead of `Risk: item N`.

### Added

- `check` tool: runs the configured or detected test command (`check.test`, `focus`), returns pass/fail counts and the failing tail, and records a trusted evidence run.
- `/brigadev:stats`: cost by phase, context percentiles, cache rebuilds, and gate blocks and forces from Pi's session logs.
- Context control: automatic compaction at a token threshold or after a long idle gap; configurable under `context` in `brigadev.json`.
- The parent has Pi's built-in `grep`, `find`, and `ls`, with guard path checks on their `path` argument.
- `/brigadev:doctor` warns when another package registers a competing delegation tool or large tool definitions.

### Changed

- The orchestrator prompt is about half the size, with one exploration rule and risk as named categories; tracking is for multi-session work only.
- The permission mode is announced as a context message instead of system prompt text, so switching modes keeps the prompt cache.
- Subagent children start with `--no-skills` and return a compact result to the parent; the full result stays in `runs/<id>/`.
- `brigadev-verify` works without a feature document, checking the task's own numbered acceptance criteria.
- The README is about 8 KB; details moved to `docs/`.
- compact-tools is the only tool-row renderer.
- Tests from one-off `verify-*` and round-named files are folded into their behavior files.

### Fixed

- Evidence gate: a piped test run gets `pipefail` and counts; a commit through `git -C <dir>` or `cd <dir> &&` is checked against that repository, and test runs are recorded against their cwd's repository; docs-only edits after a passing run no longer invalidate it.
- Protected paths (agent folder, `~/.pi`, install root, git and gh config, credential folders, shell rc files, `.git` config and hooks) no longer inherit temp-dir or secure-yolo trust.

### Removed

- Dead code, tests, and docs for everything under Breaking.

## [0.20.2] - 2026-11-18

- Run budget: a child that already made an accepted `structured_output` call with a payload valid against the agent's schema keeps that result when the wrap-up grace expires without it settling. The run succeeds with the structured result (no `over budget` failure) and the child is still stopped: its input is closed and it is terminated if it has not exited after the exit grace. Without a schema, or with no valid accepted call, the run still fails as `over budget`; a user or signal abort still wins. When the wrap-up steer is rejected and the fallback follow-up then gets no answer, the `over budget` failure now says so: `...; the child rejected the wrap-up steer (<error>) and never acknowledged the follow-up`.

## [0.20.1] - 2026-11-18

- Run budget wrap-up: the request is now steered into a running turn. A child that is between turns (before its first turn, or during a retry or compaction) gets it when its next turn starts, instead of as a follow-up it would only read once the whole run ended. A steer the child rejects falls back to one follow-up. When the request never reached the child, the `over budget` failure says why: no turn started, no answer, input closed, or the child's rejection. A run that is already stopping because of its abort signal gets no wrap-up and no second terminate.

## [0.20.0] - 2026-11-18

- Subagent run budget: a new optional agent frontmatter field, `budgetMinutes: <n>`. Once the budget is spent the child is asked once to wrap up (steer during a turn, follow-up between turns) and return what it has. A child still without a result `BRIGADEV_WRAP_UP_GRACE_MS` later (3 min by default) is stopped and fails with `over budget: ...`; that failure never falls back to another model. `BRIGADEV_RUN_BUDGET=off` disables every budget. Agents without the field are unchanged.
- `brigadev-verify` has a 10 min budget and a scoped probe plan: it reads files with the file tools, sets up the scratch copy once and reuses one probe script, writes about one probe per `S#` and per risk item, and returns at once when it is asked to wrap up, listing the checks it did not run as unverified. Recent verify runs took 3.5–38 min with 38–63 `bash` calls.
- Review policy: `brigadev-review` no longer runs on every high-risk work-unit commit; those units still get `brigadev-verify`. The review runs once before the PR, after the work units are done, and only once you pick its scope (full 4R, the lenses that fit, or skip). The Open a PR workflow asks the same question.

## [0.19.0] - 2026-11-17

- DSP: a test runner (`node --test`, `vitest`, `jest`, `mocha`, `ava`, `tap`, `pytest`/`python -m pytest`, `go test`, `cargo test`, as a bare name or `node_modules/.bin/<runner>`) no longer asks when its remote findings come only from the files it loads (test files and their imports that mention `git push`, `gh` or credential files as fixtures); it runs without credentials and is recorded in the audit log as `test-runner-locked`. A package script (`npm test`, ...) is read like a command line: its own text and non-runner segments (`"pretest": "git push"`, `"test": "node deploy.js"`) still ask, and only the files its runner segments load are exempt. A push typed in the command line, a file named like a runner (`./jest`), the runner's own head file, `python deploy.py -m pytest` (the flag belongs to the script), or a script that is not a test runner still asks. Known gap: the text layer does not ask about files a test runner loads, so a loaded file that reads credentials the lock does not hide (`~/.netrc`, an `ssh -i` key, a project `.env`) is not caught.
- The DSP remote-action dialog is bounded: kinds and "Also" reasons are deduplicated and trimmed (at most 6 and 4, each clipped to one line, then "… and N more"), so it never fills the terminal and hides the chat. Presentation only; which commands ask is unchanged.
- Writes outside the project: the parent session's `write`/`edit` into the system temp dir (`/tmp`, `/private/tmp`, `$TMPDIR`) and into secure-yolo folders run without the "write outside project" question; a `bg_start` working directory there starts without it too. A temp root (including `/tmp`) that is your home folder or holds it is not trusted. `/brigadev:yolo-dir list|add|remove` manages the folders (`secureYoloDirs` in `~/.pi/agent/brigadev.json`); the root, the home folder and its ancestors, and folders overlapping `~/.pi/agent`, `~/.brigadev`, the install root, or a credential folder (`~/.ssh`, `~/.aws`, `~/.docker`, `~/.gnupg`, `~/.kube`, `~/.config/gh|git|fish`) are refused. Sensitive files still ask, and protected paths (`.git/config`, `.git/hooks/`, shell startup files, `~/.pi/`, git and gh config) inside a trusted folder still ask in every mode; subagents stay blocked outside the project.
- Every successful parent `write`/`edit` outside the project is recorded in `~/.brigadev/<repo>/outside-writes.jsonl` with its reason (`temp`, `secure`, `granted`, `docs`, `dsp`); `/brigadev:outside` lists them.
- `bash` writes outside the project are tracked too, for the parent and subagents (with the agent's name, reason `shell` outside the trusted folders): every file the command names literally (redirections, `tee`, `cp`/`mv`/`install`/`ln`, `touch`, `mkdir`, `truncate`, `sed -i`) that the call created or changed is recorded, even when the command fails. Best effort: variables, globs, scripts, interpreters, and `bg_start` are not followed.

## [0.18.0] - 2026-11-16

- DSP mode ("dangerously skip permissions"): `/brigadev:mode dsp` (one confirmation dialog; `/brigadev:mode default dsp` is allowed and `/brigadev:doctor` warns about it) skips brigadev's execution questions. Local work runs without asking: feature-branch commits, dependency installs, deletes and overwrites inside the project or the temp dir, writes outside the project. Local discards (`reset --hard`, `rebase`, `branch -D`, `clean -f`, `stash drop`, ...) run after an automatic snapshot under `refs/brigadev/backup/` (pruned after 14 days). Every remote action (push, PR/issue/release writes, publish, HTTP writes, remote and credential config) and every change to the default branch always asks, per command, and is denied without a UI. Wrappers, `$( )`, aliases, scripts, Makefile targets and package scripts are looked through; commands the guard cannot read ask. Protected paths (`~/.pi/`, the install root, git and gh config, hooks, shell rc files) ask; the audit log `audit/dsp.jsonl` records what DSP auto-allowed. Footer shows `⚠ DSP`. `normal` and `yolo` are unchanged. See the README for the table and the residual risk.
- DSP credential lock: in DSP, every `bash` call and `bg_start` of the parent session starts without your push credentials (SSH agent, `GH_TOKEN`/`GITHUB_TOKEN`/`NPM_TOKEN`-style variables, gh config, git credential helpers including the macOS keychain helper, ssh identities, npm/docker/AWS credentials), so a remote action that slips past the text rules fails on its own. Only a call you approve in the remote dialog (that one call) runs with the real credentials. The lock depends on no file the agent could rewrite: `bash` gets one inline prelude line (about 150 tokens) that unsets the secrets and points gh, docker, npm and AWS at `/var/empty/brigadev` or `/dev/null` and askpass at the system `false`; `bg_start` gets the same values through its environment. npm private-registry auth and docker plugins/contexts from your user config are not available in locked commands; public fetches, pulls and installs keep working. `/brigadev:doctor` shows the lock in DSP; the README lists what it does not cover. Subagents started while the parent is in DSP run every bash call behind the same lock (never unlocked). DSP refuses to switch on when Pi's `shellPath` is not a POSIX shell (fish, nu, pwsh, ...). The audit log redacts obvious secrets.

## [0.17.0] - 2026-11-16

- pi-tidy ships with brigadev (bundled dependency, MIT; notice in `NOTICE.md`). `extensions/tidy-bundled.ts` loads it unless pi-tidy is installed separately (a separate install takes precedence) or `tidy.enabled` is `false`; subagent children never load it. If the bundled copy cannot be loaded (for example a checkout without `node_modules`) you get one warning and brigadev keeps working.
- Compact tool rows in `auto` mode step aside for the bundled pi-tidy exactly as they do for a separate install, and `/brigadev:doctor` reports the effective state (separate, bundled, or off). `/brigadev:tidy` is unchanged.

## [0.16.0] - 2026-11-15

- Background terminals: `bg_start` runs a long command without blocking the turn; `bg_status`, `bg_list`, and `bg_kill` manage it, and `/brigadev:ps` lists them with their output. At most 8 running, stdin ignored, a 256 KB output tail each. An exit the model has not seen is delivered to the session once, when it is idle. The guard decides `bg_start` exactly like `bash`, including the cwd. Each process runs in its own process group and is stopped on `bg_kill`, at session shutdown, and if Pi exits. Parent session only.
- `/btw <question>`: a read-only `brigadev-explore` agent answers a side question in the background; the answer is shown to you and never enters the model context or the async result delivery.
- `/brigadev:copy-all`: copies the conversation's user and assistant text to the clipboard.
- `/brigadev:pr` and a `PR #N` footer segment for the current branch's pull request, via `gh` (silent when `gh` is missing, signed out, or offline).
- `fd` and `rg` tools when the binaries are already on PATH; bounded output, secret files excluded, explicit paths decided like `read`.
- The footer's context gauge shows `?%` (with the window size when known) when occupancy is unknown.

## [0.15.0] - 2026-11-15

- Async subagents: `subagent` takes an optional `async: true`. Validation still runs first, then the launch starts in the background and the call returns a launch id. `subagent_wait {"launchId": ...}` blocks for up to 300 s (default 60) and returns the same text a sync call would; `subagent_cancel` stops a launch and returns partial results. A result nobody collected is delivered to the session once, when it is idle; several waiting results arrive as one message in one turn. At most 4 subagents run at once across all launches, sync and async. Without `async`, behavior is unchanged.
- Agents viewer (`alt+a`): lists sync and async runs (queued, running, done, failed, cancelled) with live transcripts, streaming text, and each run's saved folder. On a running run, `Enter` opens an input line that steers it (or queues a follow-up between turns) and reports Pi's answer; `x` twice within 3 s aborts it; `Esc` goes back. The footer shows `agents: N running · M done · alt+a`.
- Run folders: every child attempt saves `task.md`, `transcript.json`, and `result.json` to `~/.brigadev/<repo>/runs/<runId>/` (user-only permissions, never inside the project). At session start, folders older than 14 days are removed, then the oldest beyond 200, at most 50 per session start; only folders named like a run id are touched, symlinks are never followed, and problems show as one warning.
- Child lifecycle: children that finish but do not exit are stopped after 5 s and keep their answer; a run settles on exit even if a grandchild holds its pipes. Session shutdown waits (bounded) for every live child, and a process `exit` guard SIGKILLs tracked child groups if Pi exits or crashes. Forced kills also reach the process groups of a child's bash-tool commands.
- Compact rows: built-in tools (`read`, `grep`, `find`, `ls`, `bash`, `edit`, `write`) draw one line when collapsed (for example `✓ Ran npm test · 3.2s`); Ctrl+O shows the full output. With pi-tidy installed and enabled, pi-tidy draws those rows; `ui.compactTools` (`"auto"`, `true`, `false`) in `brigadev.json` overrides it. Subagent rows always show the model that runs them, the fallback trail, `↑` for an inherited model, `queued`, and `cancelled`.
- `/brigadev:tidy`: with pi-tidy installed, shows the change that adds `subagent` to pi-tidy's `alwaysShowTools` in Pi's `settings.json` and writes it only after you confirm.
- Quieter replies: the orchestrator does not narrate between tool calls and closes with `Done:` / `Tests:` / `Risk:` / `Next:` lines. Collapsed `todo` rows show only what changed. The fallback continuation stays in the model's context but is no longer displayed.
- Changed: subagent children now run as `pi --mode rpc --no-session` with stdin open (needed for steering), each in its own process group, so a terminal Ctrl+C no longer reaches them directly; they are stopped by session shutdown, the abort path, or the exit guard. They still never wait on a person: the guard denies guarded commands for children, and the parent answers every extension dialog a child opens as cancelled. In RPC mode child extensions see `hasUI = true`, so one that branched on `!hasUI` now gets `confirm = false` instead.
- Changed: `subagent_wait` and `subagent_cancel` document `launchId`; the earlier `runId` name is still accepted as an alias.

## [0.14.0] - 2026-11-14

- Evidence log: every check command (tests, lint, typecheck, build) run through bash, in the session or in any subagent, is appended to `~/.brigadev/<repo>/evidence/<branch>.jsonl` with its command, exit code, timestamp, directory, agent, output tail, and the content key of the working tree it ran on. Nothing is written outside git, and recording never changes a tool result. The log stores commands and output tails in plaintext (mode 0600), and `brigadev-branch-pr` redacts secrets as `<REDACTED>` before it quotes them in a PR body. A run counts as a pass only when its exit code is the test's: the command is an `&&` chain whose segment is the runner itself (`npm test`, `node --test`, `vitest`, ...; never an argument of `echo`, `grep`, or `:`), with no `||`, `;`, `&`, `!`, comment, subshell, substitution, or `exit`/`exec`/`eval`/`source` before it, no `|` after it unless a leading `set -o pipefail;` is set, and any `cd` before it staying inside the repository. Anything else is recorded as unknown. A run is keyed to the working tree only if the tree was the same before and after it, so an edit made while the tests ran is not vouched for (recorded as unknown with a `note`).
- Evidence gate: `git commit` with source changes anywhere in the repository (not just the session's folder) is blocked, in every permission mode, unless a passing test run is recorded for the current working tree, so any edit after the last passing run needs a new run. Prose-only changes (`.md`, `.markdown`, `.rst`, `.adoc`, `LICENSE`, ...) pass; `.txt` and `.mdx` count as source. A commit that runs elsewhere (another directory or branch) is blocked. The gate fails closed: when the working tree cannot be computed (git takes longer than 10 seconds, or fails) the commit is blocked with that reason, and only the guard dialog can force it; outside git nothing is gated. Computing the tree has one 10-second budget per call and writes its objects to a scratch quarantine, never to `.git/objects`. Only the user can force it: a guard dialog with a UI, or the new one-shot `/brigadev:force-commit` bound to the current working tree. The force is spent and logged as evidence only when the commit then goes ahead. There is no flag or environment variable that forces the gate, but it is a best-effort guard, not a sandbox: commit forms the classifier does not recognise (aliases, plumbing such as `git commit-tree`, wrappers, scripts) are not gated, and deliberate tricks with runner options or environment can still fake a pass. A package-manager test run (`npm`, `pnpm`, `yarn`, `bun`) counts only as plain `npm test` (optionally `-s`/`--silent`, arguments after `--`) with no `npm_config_*` variable set; any other option before `--` (`-w`, `--workspace`, `--filter`, `--loglevel`, `--color`) is not trusted, so run workspace or filtered tests through the runner directly or as `npm test -- <args>` in that package's directory.
- Evidence log protection: `write` and `edit` tool calls into `~/.brigadev/<repo>/evidence/` are blocked, and so are bash commands that name that folder together with a write (a redirection, `tee`, `cp`, `mv`, `rm`, `sed`, an interpreter, ...); reading stays allowed. This stops a model from casually forging a recorded pass; a deliberately obfuscated command (a path built from variables, `cd` then a relative write) is not prevented.
- Structured subagent results: an agent definition may declare `output: <file>.schema.json`. Its child process gets a `structured_output` tool whose parameters are that schema; an accepted call ends the run, a run that settles without one gets a single reminder, and the parent validates the payload and fails the run when it is missing or does not match. A schema that cannot be read rejects the launch, and an `output` path outside the agent file's directory is ignored. A structured result is never truncated: in parallel runs a payload above 50 KB is shown as compact JSON instead of being cut. Agents without `output` keep their prose results.
- The review lenses (`review-*`), the Judgment Day judges (`jd-judge-a`, `jd-judge-b`), and `brigadev-verify` now return their existing contracts as schema-checked JSON (`assets/agents/*.schema.json`): review findings plus a required `reviewed` line, judge `findings` or `resolutions` (an empty `{}` is rejected), and verifier verdicts per `S#`, blockers, advisories, regression tests, scratch directories, and unverified checks. A lens or judge run that fails validation is never read as clean: `brigadev-review` and Judgment Day relaunch it once, then report it. An agent override without `output` keeps the prose contract.
- Bug fix diagnosis loop: the Bug fix workflow and the Bug path of Work on a ticket now point at a lazily read `assets/diagnosis.md`. It asks for a command that fails because of the bug before any hypothesis (recorded automatically by the evidence log), a minimised repro, 3 to 5 ranked, falsifiable hypotheses shown before testing, temporary debug logs tagged `[DEBUG-xxxx]` and removed with a cleanup grep, and the root-cause hypothesis named in the commit message. The workflow questions are unchanged.
- Evidence-based PR bodies: with no PR template, `brigadev-branch-pr` builds the body from the evidence log (what changed, blast radius with how hard the change is to undo, before/after evidence quoting the failing and the final passing run, and the Risk line) and discloses any forced commit; it never claims a check that is not in the log. `brigadev-chained-pr` gains expand–contract for wide refactors that disjoint surfaces cannot split: expand, migrate in batches that stay green, then contract, with green promised only on the final integrate slice when the batches cannot stand alone.

## [0.13.0] - 2026-11-07

- Launch dashboard layout: the top level is now New feature `n ›`, Work on a ticket `j`, Review a team PR `r`, My PRs: feedback `f`, Other workflows `1 ›`, Tools `2 ›`, then Commands (`k`), Chat (`Enter`), and Quit (`q`).
- Other workflows holds Bug fix, Review my branch, Open a PR, Create an issue, UI change from a design or ticket, Refactor a component, and Upgrade dependencies (keys unchanged except `v` for Review my branch). Tools holds every tool row that was in Inspect and then Settings, with the same letters.
- Navigation is unchanged (`Enter`/`→` in, `←`/`Esc` back with the selection restored, `Esc` on the top level goes to the chat, every key from any level). The `alt+w` list shows each workflow's group label; the workflows on the top level show `[Top level]`.
- New workflows: New feature is a submenu with one row per size, each mapped to its brigadev flow.
- Quick change is a Small task (inline, test first, one work unit and its commit, never a feature document); it stops and says so when it needs more.
- Feature is the normal flow where the agent applies the size rules. Big feature (plan first) is Large: feature document with the request quoted verbatim, the plan shown for your approval before the first source write, resumable, `brigadev-chained-pr` past ~400 lines.
- Work on a ticket (`j`) takes a pasted ticket (key, kind, text, optional design link and size). The agent normalizes the key first (the first `ABC-123`-style key in the answer, uppercased, so a pasted URL or a lowercase key works), then uses it in the branch `feat/<KEY>-<short-slug>` or `fix/<KEY>-<short-slug>`, the `Refs: <KEY>` commit footer, and the PR title ending `(<KEY>)`.
- A Bug ticket always starts with a failing test that reproduces it. Big feature quotes the whole request (key, kind, text, link) as L1. Pasting only: there is no ticket-system API or credential.
- Review a team PR (`r`) reviews read-only and drafts comments tied to `path:line`. It never checks the PR out in your working tree: the diff is frozen with `gh pr diff`, files come from a detached worktree under `.worktrees/`, and the ledger is `reviews/pr-<number>.md`.
- My PRs: feedback (`f`) works through the comments on your PRs with "Fix and draft replies" or "Draft replies only". Fixing switches to the PR's branch only from a clean working tree and stops for a fork.
- With the PR left empty, both PR entries run `gh pr list` and show the list: no PR asks for a number, 1 to 5 get a choice with free text, more than 5 offer the 5 most recently updated. The menu itself still runs local lookups only. Drafts are never posted unasked, and posting goes through the guard.
- Workflow groups: the `group:` field now takes `feature` (a submenu), `main` (rows directly on the top level, after New feature; shown as `[Top level]` in `alt+w`), `other`, and `tools`; new categories take digits `3`–`9` between Other workflows and Tools.
- Existing `group:` names keep working: `build` and `ship` (Review & ship) mean `other`, `inspect` and `settings` mean `tools`, and no `group` now means Other workflows (it was Build).
- Changed: the shipped workflows were renamed: "New feature" is now "Feature", "Answer PR feedback" is "My PRs: feedback", and "Review a PR or branch" is "Review my branch". A workflow file that overrides one by its old name now adds a separate workflow instead.
- Changed: the letter `n` is reserved for New feature (a workflow file that claims it loses the key with the existing warning), `r` moved from Review a PR or branch to Review a team PR (Review my branch is `v`), and `j` and `v` are new workflow keys.

## [0.12.0] - 2026-11-06

- Launch dashboard: submenus. The top level now lists four groups, Build (`1`: `n b u x d`), Review & ship (`2`: `r p f i`), Inspect (`3`: `g a c s t o`), and Settings (`4`: `m e h y`), then Commands (`k`), Chat (`Enter`), and Quit (`q`). `Enter` or `→` opens a group, `←` or `Esc` goes back (selection returns to the group's row), and `Esc` on the top level still goes to the chat. Every key works from any level: letters run their row, digits open their group. New rows: Cost (`/brigadev:cost`), Usage (`/brigadev:usage`), Status (`/brigadev:status`), Panel (`/brigadev:panel`), Doctor (`/brigadev:doctor`), Permission mode (`e`, runs `/brigadev:mode status` only, it never changes the mode), and Launch dashboard on/off (`h`, runs `/brigadev:ui dashboard off` when the automatic start is on, `on` when it is off; when `BRIGADEV_DASHBOARD=0` (or `off`/`false`) is set it sends nothing and says the dashboard is off for this shell).
- Workflows: optional `group:` frontmatter field (`build`, `ship`, `inspect`, `settings`, or any other name for a new category on the top level after Review & ship, with the next digit `5`–`9`); no field means Build, an empty or non-string value makes the file invalid (empty `group:` line = none), and an override without a `group` keeps the shipped one. The shipped workflows are grouped (Build: new feature, bug fix, UI change, refactor, dependencies; Review & ship: review, open PR, PR feedback, issue). The `alt+w` list stays plain and shows each workflow's group in brackets.
- Changed: the letters `c s t o e h y` join `g a m k q` as reserved dashboard tool keys. A workflow file that declares one of them (for example `key: "c"`) now loses its key with the existing "reserved" warning and is started from its group row, `Enter`, or `/brigadev:start`.

## [0.11.0] - 2026-11-06

- Launch dashboard (`/brigadev:dashboard`): a full-screen start menu when Pi opens in the terminal UI, with the nine workflows on their own keys (`n b r p f i u x d`) plus Changes (`g`), Agents history (`a`), Model profile (`m`), Commands (`k`), Chat (`Enter`/`Esc`), and Quit (`q`). It opens only on a fresh start (not on resume or with an initial prompt, never in subagents or RPC/print/JSON mode); `/brigadev:ui dashboard off` or `BRIGADEV_DASHBOARD=0` (also `off`/`false`) turns it off, and a failed automatic open is reported with how to turn it off. Rows start their workflow by name, so workflows that share a file name never start each other. Workflows get an optional `key` frontmatter letter (`g a m k q` are reserved; an empty `key:` means no key; a duplicate goes to the higher layer, repo over global over package, then menu order, and the other workflow loses its key with a warning; an override without a `key` keeps the key it replaces), and `/brigadev:start` accepts a workflow name, file id, or key to skip the list (the name wins). A workflow folder that cannot be read is now a warning instead of an error.
- Workflow menu (`/brigadev:start`, `alt+w`, also in the command palette): pick one of nine day-to-day workflows (New feature, Bug fix, Review a PR or branch, Open a PR, Answer PR feedback, Create an issue, UI change from a design or ticket, Refactor a component, Upgrade dependencies), answer the questions it declares, review the composed request, and start it. Answers the session can find (current and default branch, the repo's test script) are offered as defaults; only local lookups run. The request quotes every answer verbatim and names the skills and commands it needs. Workflows are markdown files: package defaults in `assets/workflows/`, your own in `~/.brigadev/workflows/` and `~/.brigadev/<repo>/workflows/` override by name or add new ones; invalid files are skipped with a warning. Works over RPC; the orchestrator prompt is unchanged.

## [0.10.0] - 2026-11-06

- Guard: a dangling symlink now resolves to its target, so a write through a link that points outside the project (or outside the repo docs folder) asks, or is blocked for subagents, instead of following it silently.
- Repo docs folder: feature documents and review ledgers now live in `~/.brigadev/<repo>/` (`tasks/`, `reviews/`; `BRIGADEV_HOME` overrides the root), never inside the project. `<repo>` is the main worktree's basename, so worktrees share it. The orchestrator prompt names the resolved folder, the parent writes there without a dialog (subagents still cannot write outside the project), and `/brigadev:status` and `/brigadev:doctor` show it. The old `odd/tasks/` location is gone from prompts, skills, and docs.
- Guard: in normal mode, a `git commit` (amend included) in the parent no longer asks when the repository is on a branch other than the default branch. It still asks on the default branch (the `origin/HEAD` target) and on `main`/`master` whenever they exist, on a detached HEAD, an unknown default branch, after `cd`/`-C`/a branch switch in the same command (also inside `{ }`, `then`, and `do` blocks), and when git cannot answer. Chained pushes and other kinds keep their prompts; yolo and subagent rules are unchanged.
- Guard: commands after shell reserved words (`then`, `do`, `else`, `{`, `!`, `while`, ...) are now classified, so `if x; then rm -rf build; fi` and `do git push --force; done` ask like their plain forms. Commands that rewrite refs now ask in every mode: `git symbolic-ref <name> <ref>` (or `-d`), `git remote set-head`, `git update-ref` without `-d` (with `-d` keeps its reason), and `git branch -m`/`-M`/`--move` of `main`, `master`, or the current branch.
- Delivery: authorized changes start a `type/description` branch when on the default branch, and each finished work unit is committed automatically. `brigadev-branch-pr` adds no issue link unless you mention one and uses the repo's PR template (else Summary / Changes / Test plan / Risk); opening a PR first runs `brigadev-review` and saves the ledger to `reviews/`.

## [0.9.0] - 2026-11-06

- Subagents: stall watchdog. A child with no event for 4 minutes (30 while a tool call is in flight) is stopped and its run fails with "stalled for N min after: <last step>"; override with `BRIGADEV_STALL_TIMEOUT_MS` and `BRIGADEV_TOOL_STALL_TIMEOUT_MS`. Stopping a child now really sends SIGKILL 5 s after SIGTERM (the old check never fired).

## [0.8.0] - 2026-11-06

- Side panel (`alt+o`, `/brigadev:panel`): an optional right-anchored overlay with Todos, Agents, Changes, and Session sections, shown on terminals at least 140 columns wide. It is a non-capturing overlay that draws over the right 44 columns of the transcript while open (a docked rail would need private Pi internals), and it repaints only on todo, subagent, and cost updates, a throttled git refresh, and a one-second tick while an agent runs.

## [0.7.0] - 2026-11-05

- Guard: a writer's `bash` can no longer change files outside its allowed edit surfaces unnoticed. Calls that write a literal project path outside the surfaces (redirections, `tee`, `sed -i`, `cp`/`mv`/`install`/`ln`, `touch`, `mkdir`, `truncate`) are blocked; in git repositories a before/after working-tree comparison flags any other change, and the `subagent` result lists files changed outside the writers' surfaces.

## [0.6.0] - 2026-11-05

- Changes viewer: `o` opens the selected file in `$VISUAL` or `$EDITOR` (path passed as a literal argument, no shell), restores the TUI afterwards, and warns when the editor cannot launch.
- Command palette (`alt+k`, `/brigadev:commands`): searchable list of the registered brigadev commands with descriptions; Enter runs the selected one.
- Command palette: Enter now runs the command (`sendUserMessage` returns void and needs `expandPromptTemplates: true`; the old code threw), and the list includes brigadev's `/review` and `/track` prompt templates.
- Guard: new `dependency` command kind (`npm`/`pnpm`/`yarn`/`bun` install, add, remove, update; `pip`, `uv`, `poetry`, `cargo`, `go`, `brew`, `gem` installs) asks in normal and yolo and is blocked in subagents.
- Exploration budget: the first read-only `bash` lookup (`cat`, `sed`, `grep`...) of a request gets a notice to use `read`, `grep`, `find`, or `ls`.
- Orchestrator prompt: never claim the user approved something unless a dialog answer or message says so. `brigadev-review` cleans its scratch directory with the literal `mktemp -d` path so the guard does not ask.

## [0.5.0] - 2026-11-05

- Fallback chains: profile routes take `fallbacks`; orchestrator and subagent runs move to the next model on quota, auth, rate-limit, provider, timeout, or network failures, with shared cooldowns and a price note when the next model costs more. `/brigadev:profile fallback` edits chains.
- Usage windows: Claude 5-hour and weekly utilization from rate-limit headers in the status bar and `/brigadev:usage`; chains skip a provider whose limit is reached.

- Subagents start with `PWD` set to their resolved working directory. Under a symlinked path (macOS `/tmp`) an inherited `PWD` showed the child two directories, and it ran every lookup twice (measured: 4 → 2 tool calls for the same task). Projects outside symlinks were not affected.

## [0.4.0] - 2026-11-05

- Changes viewer (`alt+g`, `/brigadev:changes`): working tree against HEAD in a full-screen two-pane view with per-file line counts and diffs.
- Agents viewer (`alt+a`, `/brigadev:runs`): every subagent run of the session with its thread, route, usage, and cost; live runs follow along.

- Guard: the project-root and edit-surface checks resolve symlinks, so a project reached through a symlink (macOS `/tmp` → `/private/tmp`, a symlinked checkout) is no longer treated as outside itself.
- Stop tracking the generated `.atl/` registry that a Claude Code hook wrote into the repo.

- Prompt trim: brigadev's per-turn prompt went from about 15.1k to 9.7k characters (measured trivial turn: 11,103 → 9,259 prompt tokens). Compact orchestrator prompt with the same rules, tool schemas without duplicated field descriptions, shorter skill descriptions, and Judgment Day and the skill creator hidden from the model's skill list (run them with `/skill:brigadev-judgment-day` and `/skill:brigadev-skill-creator`; the `/judgment-day` prompt is gone). `tests/prompt-budget.test.ts` keeps it from growing back.

- `/brigadev:doctor`: diagnostics (bridge hooks, profiles, settings, model) and `fix-bridge-hooks`, which adds `disableAllHooks: true` to the installed claude-bridge so the user's Claude Code hooks stop running inside Pi turns (measured: about 0.8k prompt and 0.3k output tokens, 7-9 s per turn). Warns once per session while hooks are on. Re-run after bridge updates; an upstream option is drafted in `docs/upstream/`.

## [0.3.0] - 2026-11-05

- UI: one-line status bar replacing Pi's footer (repo, branch, dirty count, yolo mode, model and thinking, context gauge, API-equivalent cost, profile, other extensions' statuses), dropping segments by priority on narrow terminals.
- UI: ODD phase in the working message (exploring, implementing, checking, delegating · agent, delivering), inferred from tool activity.
- UI: todo card with progress, blocked notes, a stale marker after two runs without an update, and a collapse key (ctrl+shift+t).
- UI: agents card above the editor while subagents run: aligned model · thinking, tokens, cost, and elapsed columns; finished rows stay 60 s; collapse key (ctrl+shift+a).
- `ask_user_choice` tool: focused questions as a dialog with a recommended option, number keys, and optional free text; used by the Ask trigger and the chained-PR menu.
- `/brigadev:ui footer|phase on|off`.
- Runtime signals (parent session only): a context backstop notice when context first reaches min(150k tokens, 50% of the window), re-armed after compaction, and an exploration budget notice on the 5th lookup of a request, counting read-only shell commands.
- Guard: recursive rm of literal scratch paths inside the temp dir runs without asking; confirmation dialogs show a bounded command preview.
- Prompts: file tools for file work; a verifier recheck after correcting blockers.
- `formatCost(0)` prints `$0`.

## [0.2.0] - 2026-11-05

- Model routing profiles (`/brigadev:profile`): per-agent and orchestrator model + thinking, prefix globs, session binding, default profile that also sets Pi's default model, example profiles (economy, balanced, deep).
- Subagent launches resolve their route (session profile, default profile, frontmatter, session model), reject unknown models, and show model, thinking, and route source.
- Cost visibility: claude-bridge turns priced at the Anthropic list price (parent and subagents), `brigadev-cost` status, `/brigadev:cost` breakdown with cache hit rate.
- Todo list no longer injected into the system prompt (kept prompt cache stable); re-sent once as a hidden message after compaction.

## [0.1.0] - 2026-11-05

- Initial MVP: orchestrator prompt with ODD workflow, task sizing, and risk line.
- Subagent runner with brigadev-explore, brigadev-worker, and brigadev-verify; delegation admission rules (reason, risk item, allowed edit surfaces, disjoint writers).
- 4R review lenses and Judgment Day agents, with `brigadev-review` and `brigadev-judgment-day` skills.
- Safety guard: destructive-command confirmation, normal/yolo permission modes, project-root boundary, secret-file protection, subagent edit-surface enforcement.
- Todo tool as the visible projection of ODD tasks.
- Delivery skills: work-unit commits, branch/PR, chained PRs, issue creation, comment writer, skill creator.
