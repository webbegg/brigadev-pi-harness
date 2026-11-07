# Changelog

## [Unreleased]

- Launch dashboard: restructured around the daily work. The top level is now New feature `n ›`, Work on a ticket `j`, Review a team PR `r`, My PRs: feedback `f`, Other workflows `1 ›`, Tools `2 ›`, then Commands (`k`), Chat (`Enter`), and Quit (`q`). Other workflows holds Bug fix, Review my branch, Open a PR, Create an issue, UI change, Refactor, and Upgrade dependencies (keys unchanged except `v` for Review my branch). Tools holds every tool row that was in Inspect and then Settings, with the same letters. Navigation is unchanged (`Enter`/`→` in, `←`/`Esc` back with the selection restored, `Esc` on the top level goes to the chat, every key from any level). The `alt+w` list shows each workflow's new group label.
- Workflows: New feature is a submenu with one row per size, each mapped to its brigadev flow. Quick change is a Small task (inline, test first, one commit, never a feature document), Feature is the normal flow where the agent applies the size rules, and Big feature (plan first) is Large (feature document with the request quoted verbatim, the plan shown for your approval before the first source write, resumable, `brigadev-chained-pr` past ~400 lines).
- Workflows: Work on a ticket (`j`) takes a pasted ticket (key, kind, text, optional design link and size); the text is the requirement, the branch is `feat/<KEY>-<short-slug>` or `fix/<KEY>-<short-slug>`, every commit has a `Refs: <KEY>` footer, and the PR title ends with `(<KEY>)`; a Bug starts from a failing test. Pasting only: there is no Jira API or credential yet. Review a team PR (`r`) reviews read-only and drafts comments tied to `path:line`; My PRs: feedback (`f`) works through the comments on your PRs. With the PR left empty, the agent runs `gh pr list` (`--search "review-requested:@me"` or `--author @me`), shows the list, and asks which one; the menu itself still runs local lookups only. Drafts are never posted unasked, and posting goes through the guard.
- Workflows: the `group:` field now takes `feature` (a submenu), `main` (rows directly on the top level, after New feature), `other`, and `tools`; new categories take digits `3`–`9` between Other workflows and Tools. Existing `group:` names keep working: `build` and `ship` (Review & ship) mean `other`, `inspect` and `settings` mean `tools`, and no `group` now means Other workflows (it was Build).
- Changed: the shipped workflows were renamed: "New feature" is now "Feature", "Answer PR feedback" is "My PRs: feedback", and "Review a PR or branch" is "Review my branch". A workflow file that overrides one by its old name now adds a separate workflow instead. The letter `n` is reserved for New feature (a workflow file that claims it loses the key with the existing warning), `r` moved from Review a PR or branch to Review a team PR (Review my branch is `v`), and `j` and `v` are new workflow keys.

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
