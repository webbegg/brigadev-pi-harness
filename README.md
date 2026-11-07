# brigadev-harness

An opinionated [Pi](https://pi.dev) package that turns a Pi session into a disciplined development harness: one accountable orchestrator, the ODD workflow, focused subagents, proportionate review, and a safety guard.

## Install

```bash
# Try it for one session
pi -e /path/to/brigadev-harness

# Install for every session (local path, loaded in place)
pi install /path/to/brigadev-harness

# Project-only
pi install -l /path/to/brigadev-harness
```

Check it loaded: `/brigadev:status`.

## What it does

| Feature | Where | What |
| --- | --- | --- |
| Orchestrator | `extensions/orchestrator.ts`, `assets/orchestrator.md` | Injects the ODD contract into the parent session: task sizing, high-risk list, Risk line, delegation triggers. Re-read on every prompt, so edits apply immediately. |
| ODD tracking | `assets/odd-tracking.md`, `/track` | Large work gets one feature document at `<repo docs>/tasks/<name>.md` (Specs quoted verbatim, Tasks, Log) and a `todo` projection. Small work stays inline with no artifacts. See [Repo docs folder](#repo-docs-folder). |
| Subagents | `extensions/subagents.ts`, `assets/agents/` | `subagent` tool runs each agent in its own `pi` process. Every launch needs a `reason`; the verifier needs `Risk: item N`; writers need narrow `allowedEditSurfaces`, and parallel writers must be disjoint. Specs travel by reference (`featureDoc`), skills by exact path. |
| Review | `skills/brigadev-review`, `/review` | 4R lenses (Risk, Readability, Reliability, Resilience) on one frozen candidate; only the lenses that fit. |
| Judgment Day | `skills/brigadev-judgment-day`, `/skill:brigadev-judgment-day` | Two blind judges, frozen ledger, at most two scoped fix and re-judgment rounds. |
| Safety guard | `extensions/guard.ts` | Confirms destructive, delivery, publish, and privileged commands (a commit on a feature branch runs without asking in normal mode); hard-denies catastrophic ones; asks before writes outside the project (the repo docs folder excepted) or touching secret files. In subagents: blocks all of those and enforces allowed edit surfaces. |
| Todo | `extensions/todo.ts` | Visible task list with `pending / in_progress / done / blocked / dropped`. Kept out of the system prompt so updates never break the prompt cache. |
| Status bar | `extensions/shell-bar.ts` | One-line footer: repo, branch ±dirty, yolo, model · thinking, context gauge, cost, profile. |
| Phase label | `extensions/odd-phase.ts` | The working message shows the ODD phase (exploring, implementing, checking, delegating · agent). |
| Agents card | `extensions/subagents.ts` | Live rows above the editor while subagents run (model · thinking, tokens, cost, elapsed). |
| Ask dialog | `extensions/ask-user.ts` | `ask_user_choice`: focused questions as a dialog with a recommended option. |
| Model routing | `extensions/profiles.ts` | Named profiles route the orchestrator and every agent to a model and thinking level. |
| Workflow menu | `extensions/workflow-menu.ts`, `assets/workflows/` | `/brigadev:start` (`alt+w`): pick a day-to-day workflow, answer its questions, review the composed request, and start it. See [Workflows](#workflows). |
| Launch dashboard | `extensions/dashboard.ts` | Full-screen start menu when Pi opens, built around the daily work: New feature (by size), work on a ticket, review a team PR, feedback on your PRs, then Other workflows and Tools, one key each. `/brigadev:dashboard` reopens it. See [Launch dashboard](#launch-dashboard). |
| Cost | `extensions/cost.ts` | API-equivalent pricing for `claude-bridge` turns, session tally, `/brigadev:cost` breakdown. |
| Delivery skills | `skills/` | work-unit commits, branch/PR, chained PRs, issue creation, comment writer, skill creator. |

## Commands

| Command | Purpose |
| --- | --- |
| `/brigadev:status` | Version, prompt on/off, paths, repo docs folder |
| `alt+w` or `/brigadev:start` | Workflow menu: Quick change, Feature, Big feature (plan first), Work on a ticket, Review a team PR, My PRs: feedback, Bug fix, Review my branch, Open a PR, Create an issue, UI change from a design or ticket, Refactor a component, Upgrade dependencies. Asks what each needs, then sends one complete request |
| `/brigadev:start <workflow>` | Starts that workflow directly: its name, file id, or key (`/brigadev:start bug-fix`, `/brigadev:start b`) |
| `/brigadev:dashboard` | Launch dashboard: workflows and tools in groups, one key each |
| `/brigadev:doctor [fix-bridge-hooks]` | Diagnostics, including the repo docs folder; turn off your Claude Code hooks inside claude-bridge turns |
| `/brigadev:profile …` | Model routing profiles (see below) |
| `/brigadev:cost` | Session cost: orchestrator per model, subagents per agent, cache hit rate |
| `/brigadev:usage` | Subscription usage windows (5h, weekly) and their resets |
| `/brigadev:ui footer\|phase\|dashboard on\|off` | Turn the status bar, the phase label, or the launch dashboard off and on |
| `ctrl+shift+t` / `ctrl+shift+a` | Collapse the todo card / the agents card |
| `alt+g` or `/brigadev:changes` | Changes viewer: uncommitted files and their diffs (`o` opens the file in `$VISUAL` / `$EDITOR`) |
| `alt+k` or `/brigadev:commands` | Command palette: search the brigadev commands, Enter runs one |
| `alt+a` or `/brigadev:runs` | Agents viewer: subagent runs with their threads |
| `alt+o` or `/brigadev:panel` | Side panel: todos, agents, changes, and session at a glance. Needs a terminal at least 140 columns wide. It draws over the right 44 columns of the transcript while open; a docked rail would need private Pi internals. (`alt+p` is Pi's own "previous model" key on Windows and WSL, so the panel uses `alt+o`.) |
| `/brigadev:mode [normal\|yolo\|default <mode>]` | Permission mode for this session, or the default for new sessions |
| `/brigadev:agents` | Effective agent list (package, user, trusted project) |
| `/brigadev:harness on\|off` | Toggle the orchestrator prompt for this session (A/B testing) |
| `/review [base or focus]` | 4R review |
| `/skill:brigadev-judgment-day [target]` | Judgment Day (hidden from the model's skill list; run it explicitly) |
| `/track <request>` | Force ODD tracking for a request |

## Model routing profiles

A profile maps the orchestrator and each agent to a model and thinking level. Keys are agent names, prefix globs (`review-*`, `jd-*`), `*` for every other agent, and `orchestrator`.

```bash
/brigadev:profile init                 # add economy / balanced / deep (balanced becomes the default)
/brigadev:profile                      # effective routing for this session, with the source of each value
/brigadev:profile use economy          # this session only: subagents + the live orchestrator
/brigadev:profile default balanced     # default for new sessions; also sets Pi's default model
/brigadev:profile clear                # drop the session profile
/brigadev:profile set economy brigadev-worker claude-sonnet-5-5 high
/brigadev:profile set economy review-* inherit       # remove a route
/brigadev:profile new mine balanced    # copy a profile, then edit it
```

Precedence for each subagent launch, per field: **session profile → default profile → agent frontmatter → the session's model**. Thinking is inherited from the session only together with its model. A route to an unknown model rejects the launch with the fix. Bare model ids resolve against the session's provider first.

Stored at `~/.pi/agent/brigadev-profiles.json`:

```json
{
  "version": 1,
  "active": "balanced",
  "profiles": {
    "balanced": {
      "orchestrator": { "model": "claude-bridge/claude-opus-5-5", "thinking": "high" },
      "brigadev-explore": { "model": "claude-bridge/claude-haiku-5-5", "thinking": "low" },
      "review-*": { "model": "claude-bridge/claude-sonnet-5-5", "thinking": "medium" }
    }
  }
}
```

## Fallback chains and usage limits

Each profile route can list fallback models. When a run fails on quota, auth, a rate limit, provider trouble, a timeout, or the network (after Pi's own retries), the run moves to the next model; context-length and invalid-request failures never fall back.

```bash
/brigadev:profile fallback balanced orchestrator claude-sonnet-5-5 high
/brigadev:profile fallback balanced brigadev-worker claude-haiku-5-5
/brigadev:profile fallback balanced brigadev-worker clear
```

- **Orchestrator:** switches the session's model and continues the same conversation, with a note quoting your latest request.
- **Subagents:** the run is retried on the next model from the start (`-p` children cannot switch mid-conversation).
- **Cooldowns:** a model that failed is skipped by every agent of the session for 30 minutes after a limit or auth error, 2 minutes after a transient one; a launch whose primary is cooling starts on the first usable fallback.
- **Usage windows:** `/brigadev:usage` and the status bar (`◷ week 56%`) show your Claude 5-hour and weekly windows from each response's rate-limit headers. When a provider's limit is reached (and Extra Usage is off), chains skip that provider until its reset.
- All `claude-bridge` models share one subscription: within the bridge, a chain helps with model-specific failures (overload, a per-model limit); for a spent subscription, add a model from another provider.

## Cost visibility

`pi-claude-bridge` runs Claude Code on your subscription and records every turn at $0. brigadev prices those turns at the Anthropic list price of the same model when they end, so Pi's footer, session files, the `brigadev-cost` status, and `/brigadev:cost` show what the tokens would cost on the API. Subagent turns are priced the same way. This is a comparison number, not your subscription bill. Turn it off with `{"bridgePricing": false}` in `~/.pi/agent/brigadev.json`.

## Permission modes

| Command kind | normal | yolo | subagent |
| --- | --- | --- | --- |
| ordinary (`npm test`, `git status`) | run | run | run |
| delivery (`git push`, `gh pr create`) | ask | run | block |
| `git commit` on a feature branch | run | run | block |
| `git commit` on the default branch, on a detached HEAD, or when the default branch is unknown | ask | run | block |
| destructive (`rm -rf dir`, `git reset --hard`, `git push --force`, `DROP TABLE`; ref rewrites: `git symbolic-ref HEAD <ref>`, `git remote set-head`, `git update-ref`, `git branch -m main …`) | ask | ask | block |
| publish (`npm publish`, `gh pr merge`, `gh release`) | ask | ask | block |
| privileged (`sudo`, `curl … \| sh`) | ask | ask | block |
| dependency (`npm install`, `pip install`) | ask | ask | block |
| catastrophic (`rm -rf ~`, `rm -rf /`, `mkfs`, `dd of=/dev/…`) | block | block | block |

A commit runs without asking only when it targets the session's repository on a branch other than the default branch (the one `origin/HEAD` points to, else a lone local `main` or `master`). `main` and `master` stay protected whenever they exist, even if `origin/HEAD` is repointed. It still asks after a `cd`, a branch switch, or `git -C`/`--git-dir`/`--work-tree` earlier in the same command (inside `{ }`, `then`, and `do` blocks too), and a chained `git push` keeps its own prompt. If git cannot answer, it asks. Commands after `then`, `do`, `else`, `{`, `!`, and similar words are classified like their plain forms.

Without a UI (print mode), "ask" means block. The guard recognizes executable forms; it is not a sandbox.

## Repo docs folder

Harness documents live outside the project, in `~/.brigadev/<repo>/` (`BRIGADEV_HOME` overrides `~/.brigadev`): feature documents in `tasks/`, review ledgers in `reviews/`. `<repo>` is the basename of the main worktree root, so every worktree of a repository shares one folder; outside git it is the directory name. The parent session writes there without asking; subagents still cannot write outside the project. `/brigadev:status` and `/brigadev:doctor` print the resolved folder.

## Workflows

`/brigadev:start` (or `alt+w`, also listed in the `alt+k` palette) opens a plain list of workflows, each followed by its dashboard group in brackets (`[Other workflows]`; the workflows that sit directly on the dashboard's top level, without a submenu, show `[Top level]`); Esc at any step cancels and sends nothing. Thirteen ship with the package:

- New feature (three sizes): Quick change (a Small task: inline, test first, one work unit and its commit, never a feature document), Feature (the normal ODD flow; the agent applies the size rules), and Big feature (plan first) (a Large task: feature document with the request quoted verbatim as L1 and the tasks, the plan shown for your approval before the first source write, resumable, `brigadev-chained-pr` when it passes ~400 lines).
- Work on a ticket: paste the ticket key (a pasted ticket URL or a lowercase key also works: the agent takes the first `ABC-123`-style key and uppercases it), its kind (Story or task, Bug), and its text; the ticket is the requirement (quoted verbatim), a Bug always starts with a failing test that reproduces it, the branch is `feat/<KEY>-<short-slug>` or `fix/<KEY>-<short-slug>`, every commit ends with a `Refs: <KEY>` footer, and the PR title ends with `(<KEY>)`. Override the workflow file to change those conventions. There is no Jira API or credential: you paste the ticket.
- Review a team PR: review someone else's PR read-only with `brigadev-review`, then draft the review comments (each tied to `path:line`) with `brigadev-comment-writer`. It never checks the PR out in your working tree: the diff is frozen with `gh pr diff`, and when the reviewers need the files they get a detached worktree under `.worktrees/review-pr-<number>`, removed afterwards. The ledger is saved as `reviews/pr-<number>.md`. Leave the PR empty and the agent runs `gh pr list --search "review-requested:@me" --state open` and asks which one.
- My PRs: feedback: work through the comments on one of your PRs, either fixing them and drafting the replies ("Fix and draft replies") or only drafting the replies ("Draft replies only"). Fixing switches to the PR's branch only from a clean working tree, and stops for a PR from a fork. Leave the PR empty and the agent runs `gh pr list --author @me --state open` and asks which one.
- With the PR left empty, both PR entries show the list and ask with a choice of up to five PRs (the most recently updated) and free text for another; with none, the agent asks for a PR number in its reply.
- Other workflows: Bug fix, Review my branch, Open a PR, Create an issue, UI change from a design or ticket, Refactor a component, Upgrade dependencies.

The menu itself only runs local lookups, by design; for the two PR entries the agent runs `gh`, shows you the list, and asks which one. Team-review comments and feedback replies are drafts: posting goes through the guard, which asks you first.

Each workflow asks its own questions (one line, multi-line editor, or a choice; required or optional). Required answers cannot be empty (asked again once, then the workflow is cancelled). When you choose Edit answers, an optional text answer is cleared by entering `-` (the title says so), and an optional choice offers a final `(no answer)` option. Answers the session can find are offered as defaults instead of asked blind: the current and default branch (git) and the repo's `package.json` test script. Only local lookups run; nothing touches the network. Before anything is sent you see the composed request and choose Start, Edit answers, or Cancel. The request quotes every answer verbatim, names the skills and commands the workflow needs, and is sent as a normal message, so the ODD flow and the guard apply. The questions use plain select, input, and editor dialogs, so the menu also works over RPC.

Workflows are markdown files. Add or override them by name in `~/.brigadev/workflows/` (all repos) or `~/.brigadev/<repo>/workflows/` (one repo; wins over the global folder); `BRIGADEV_HOME` moves the root. Invalid files are skipped with a warning. Format (see `assets/workflows/` for the defaults):

```markdown
---
name: "Add endpoint"
description: "One line shown in the menu"
order: 100          # optional; lower comes first
key: "w"           # optional; one lowercase letter that runs it from the dashboard
group: "Other"     # optional; the dashboard category (default Other workflows)
questions:
  - id: route
    label: "Which route?"
    kind: text      # text | long | choice
    required: true
  - id: auth
    label: "Authentication"
    kind: choice
    options: ["Public", "Signed in"]
    default: "Signed in"
  - id: base
    label: "Base branch"
    kind: text
    default: "{{defaultBranch}}"   # facts: currentBranch, defaultBranch, testScript
---
Add an endpoint, following the normal ODD flow.

- Route: {{route}}
- Authentication: {{auth}}
- Base branch: {{base}}
```

In the body, `{{id}}` is replaced by the answer (a multi-line answer becomes a block quote), and a line is left out only when all of its answers were skipped (a skipped answer on a line with others renders as empty). A multi-line answer sits on its own quoted lines, with any text after the placeholder on the line below. A placeholder that names no question makes the file invalid.

`key` must be one lowercase letter (an empty `key:` line means no key). The letters `a c e g h k m n o q s t y` belong to the dashboard tools and the New feature submenu (a workflow file that asks for one of them has no key and gets a warning). When two workflows claim the same letter, the higher layer keeps it (repo, then your global folder, then the package), and within a layer the first in menu order; the other workflow loses its key (a warning says so) but still works. An override replaces the whole file, but one without a `key` keeps the key of the workflow it overrides (set `key` to give it another). A workflow without a key is still listed on the dashboard and starts with Enter.

`group` is a non-empty name (an empty `group:` line means no group; anything else that is not a name is an invalid file). It picks the dashboard category the workflow sits in: `feature` (New feature, a submenu), `main` (no submenu: its workflows are rows on the top level, after New feature; the `alt+w` list shows it as `[Top level]`), `other` (Other workflows), or `tools` (Tools), written as the id or the label in any case. The names of earlier versions still work: `build` and `ship` (Review & ship) mean `other`, `inspect` and `settings` mean `tools`. No `group` means Other workflows, and any other name becomes a new category of its own (labelled as you wrote it, same name in any case is one category). Like `key`, an override without a `group` keeps the group of the workflow it overrides. A workflow folder Pi cannot read (not a folder, or no permission) is reported as a warning and skipped.

## Launch dashboard

When Pi starts in the terminal UI, a full-screen start menu opens first: a centered list with an icon, a label, and the row's key at the end of the row. The top level lists the groups; `Enter` or `→` opens one, `←` or `Esc` goes back, and `Esc` on the top level goes straight to the chat. Move with `↑`/`↓`. `/brigadev:dashboard` opens it again at any time.

```
✦  New feature         n ›   Quick change · Feature · Big feature (plan first)
◆  Work on a ticket    j     paste key + text → branch/commits/PR carry the key
◎  Review a team PR    r     PRs awaiting your review → drafts comments
✎  My PRs: feedback    f     your PRs with comments → fixes + draft replies
⋯  Other workflows     1 ›   Bug fix (b) · Review my branch (v) · Open a PR (p) · Create an issue (i) · UI change (u) · Refactor (x) · Upgrade deps (d)
⚙  Tools               2 ›   g changes · a agents history · c cost · s usage · t status · o panel · m model profile · e mode · h dashboard on/off · y doctor
⌘  Commands k   ❯ Chat ↵   ✕ Quit q
```

Every key works from any level: a letter runs its row, `n` or a digit opens its group. Going back puts the selection on the group you left; opening a group starts on its first row.

| Key | Group | Row | Runs |
| --- | --- | --- | --- |
| `n` | | New feature | opens the submenu |
| | New feature | Quick change | the workflow's questions (a Small task: no plan) |
| | New feature | Feature | the workflow's questions (the agent decides the size) |
| | New feature | Big feature (plan first) | the workflow's questions (always a plan, shown for your approval before any code) |
| `j` | | Work on a ticket | the workflow's questions |
| `r` | | Review a team PR | the workflow's questions |
| `f` | | My PRs: feedback | the workflow's questions |
| `1` | | Other workflows | opens the group |
| `b` | Other workflows | Bug fix | the workflow's questions |
| `v` | Other workflows | Review my branch | the workflow's questions |
| `p` | Other workflows | Open a PR | the workflow's questions |
| `i` | Other workflows | Create an issue | the workflow's questions |
| `u` | Other workflows | UI change from a design or ticket | the workflow's questions |
| `x` | Other workflows | Refactor a component | the workflow's questions |
| `d` | Other workflows | Upgrade dependencies | the workflow's questions |
| `2` | | Tools | opens the group |
| `g` | Tools | Changes | `/brigadev:changes` |
| `a` | Tools | Agents history | `/brigadev:runs` |
| `c` | Tools | Cost | `/brigadev:cost` |
| `s` | Tools | Usage | `/brigadev:usage` |
| `t` | Tools | Status | `/brigadev:status` |
| `o` | Tools | Panel | `/brigadev:panel` |
| `m` | Tools | Model profile | `/brigadev:profile use` (pick a profile) |
| `e` | Tools | Permission mode | `/brigadev:mode status` (shows the mode; it never changes it, switching stays a typed `/brigadev:mode` command) |
| `h` | Tools | Launch dashboard on/off | `/brigadev:ui dashboard off` when the automatic start is on, `on` when it is off; with `BRIGADEV_DASHBOARD=0` set it sends nothing and says the dashboard is off for this shell |
| `y` | Tools | Doctor | `/brigadev:doctor` |
| `k` | | Commands | `/brigadev:commands` |
| `Enter` on Chat, or `Esc` on the top level | | Chat | closes the dashboard |
| `q` | | Quit | exits Pi |

A workflow row opens that workflow's questions directly (it runs `/brigadev:start <workflow name>`; the name is unique, so a keyless workflow that shares a file name with another still starts itself). Your own workflows from `~/.brigadev/workflows/` and `~/.brigadev/<repo>/workflows/` are listed in their group, after the shipped ones, with a key if they declare one; with no `group:` they go to Other workflows. A `group:` name that is not one of the shipped four becomes a new category: a row on the top level after Other workflows and before Tools, with the next digit (`3`, `4`, … up to `9`; later ones have no digit and open with `Enter`). `n` belongs to New feature, so a workflow cannot take it. Workflow files are unchanged by this layout: their `group:` names stay valid. The workflows renamed in this version ("New feature" is now "Feature", "Answer PR feedback" is "My PRs: feedback", "Review a PR or branch" is "Review my branch") are overridden by their new names; a file that still uses an old name adds a separate workflow.

It opens by itself only on a fresh start: not on `/reload`, `/new`, `--continue`, or `--resume` into a session that has messages, not when you launch Pi with a message or an `@file` (`pi "fix the login bug"`), not in print, JSON, or RPC mode, and never inside subagents. Turn the automatic start off with `/brigadev:ui dashboard off` (it writes `"ui": { "dashboard": false }` to `~/.pi/agent/brigadev.json`); `/brigadev:ui dashboard on` brings it back, and `/brigadev:dashboard` keeps working either way. Setting the environment variable `BRIGADEV_DASHBOARD=0` (or `off`/`false`) skips the automatic start whatever the setting says, e.g. `BRIGADEV_DASHBOARD=0 pi` if the dashboard ever fails to draw. If the automatic start fails, a message says why and how to turn it off.

## Delivery flow

An authorized change on the default branch starts a `type/description` branch, and each finished work unit is committed automatically (Conventional Commits, with its tests and docs). Push, PR, and merge stay your decisions. Opening a PR first runs `brigadev-review` on the branch and saves the ledger to `reviews/`; the PR body follows the repository template (else Summary / Changes / Test plan / Risk), and no issue link is added unless you mention one.

## Customize

- **Agents**: override any package agent by name in `~/.pi/agent/agents/<name>.md` or `.pi/agents/<name>.md` (trusted projects). Frontmatter: `name`, `description`, `tools`, `model`, `thinking`, `writer: true`, `admission: risk`.
- **Orchestrator rules**: edit `assets/orchestrator.md` and the lazy files next to it.
- **Skills**: edit `skills/*/SKILL.md`, then `/reload`.
- **Default mode**: `/brigadev:mode default yolo` writes `~/.pi/agent/brigadev.json`.

## Development

```bash
npm test   # node --test, no build step (Node ≥ 22.19 runs TypeScript directly)
```

Pure logic lives in `lib/` and is covered by `tests/`. Extensions are thin adapters over the Pi API.

## claude-bridge and Claude Code hooks

`pi-claude-bridge` starts Claude Code with your user settings on every turn, so your Claude Code hooks and plugin hooks run inside Pi turns and inject their output. `/brigadev:doctor` detects it; `/brigadev:doctor fix-bridge-hooks` adds one line (`disableAllHooks: true`) to the installed bridge. Normal Claude Code sessions keep their hooks. A bridge update undoes the line: the doctor warns at the next session start; run the fix again.

## Known limits (MVP)

- Edit surfaces and `bash`: `write` and `edit` are blocked outside a writer's surfaces. For `bash`, the guard blocks calls that write a literal project path outside the surfaces (`>`, `>>`, `&>`, `tee`, `sed -i`, `cp`/`mv`/`install`/`ln` destinations, `touch`, `mkdir`, `truncate`). This is best effort: variables, globs, substitutions, and scripts run by an interpreter (`python3 - <<EOF`) are not parsed. In a git repository the guard also compares the working tree before and after each writer `bash` call and flags any file changed outside the surfaces, after the fact: it reports the paths and marks the result as an error, and never reverts anything. Ignored files and repositories without git are not covered by that check. After a launch with writers, the `subagent` result also lists files changed outside the writers' surfaces. Writes outside the project root (such as the system temp dir) are not restricted by these checks.
- Subagents run in the foreground (parallel within one call). No background jobs, agent dashboard, or model fallback chains yet.
- Profiles have no per-repository pin and are not frozen at session start: a session without its own profile follows the default as it changes.
- No "auto" permission mode (classifier-based approvals).
- Memory mirroring of feature documents is used only when a memory tool such as `mem_save` is available.

## License

MIT © 2026 Marcos Juan (see `LICENSE`). brigadev-harness builds on ideas and adapted material from [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) and Pi's subagent example; credits and their license notices are in `NOTICE.md`.
