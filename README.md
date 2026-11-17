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
| Subagents | `extensions/subagents.ts`, `assets/agents/` | `subagent` tool runs each agent in its own `pi --mode rpc` process, at most 4 at a time across all launches. With `async: true` it returns a launch id at once: `subagent_wait` collects the result, `subagent_cancel` stops it, and a result nobody collected is delivered to the session once, when it is idle. Children never wait on a person: the guard denies what would need confirmation and every dialog a child extension opens is answered as cancelled. Every launch needs a `reason`; the verifier needs `Risk: item N`; writers need narrow `allowedEditSurfaces`, and parallel writers must be disjoint. Specs travel by reference (`featureDoc`), skills by exact path. |
| Review | `skills/brigadev-review`, `/review` | 4R lenses (Risk, Readability, Reliability, Resilience) on one frozen candidate; only the lenses that fit. |
| Judgment Day | `skills/brigadev-judgment-day`, `/skill:brigadev-judgment-day` | Two blind judges, frozen ledger, at most two scoped fix and re-judgment rounds. |
| Safety guard | `extensions/guard.ts` | Confirms destructive, delivery, publish, and privileged commands (a commit on a feature branch runs without asking in normal mode); hard-denies catastrophic ones; asks before writes outside the project (the repo docs folder excepted) or touching secret files. In subagents: blocks all of those and enforces allowed edit surfaces. |
| Todo | `extensions/todo.ts` | Visible task list with `pending / in_progress / done / blocked / dropped`. Kept out of the system prompt so updates never break the prompt cache. |
| Compact tool rows | `extensions/compact-tools.ts` | `read`, `grep`, `find`, `ls`, `bash`, `edit`, `write` show one line when collapsed (live timer, then `✓ Ran npm test · 3.2s`; errors keep the header plus 1–3 lines). Ctrl+O expands to the full output. Presentation only: tool results are unchanged. [pi-tidy](https://github.com/Andy8647/pi-tidy) ships with brigadev (`extensions/tidy-bundled.ts`), so with the defaults these rows step aside and pi-tidy draws built-in tools. A pi-tidy you install yourself (`npm:pi-tidy` in `packages`, a `pi-tidy` entry in the settings `extensions` array or passed with `-e`/`--extension`, or in the agent `extensions/` folder) takes precedence and brigadev's copy does not load. To turn pi-tidy off, set `tidy.enabled` to `false` in Pi's `settings.json` and run `/reload`: brigadev still starts its bundled pi-tidy so it can switch its own patches off (it registers no `/tidy`), and brigadev's own rows come back. `ui.compactTools` in `brigadev.json` (`"auto"` default, `true`, `false`) overrides the choice, and `/brigadev:doctor` shows the effective state (separate, bundled, or off). |
| Status bar | `extensions/shell-bar.ts`, `extensions/pr-info.ts` | One-line footer: repo, branch ±dirty, `PR #N` for the branch's pull request (via `gh`; silent without it), yolo or `⚠ DSP`, model · thinking, context gauge (`?%` when occupancy is unknown, e.g. after compaction), cost, profile. |
| Background terminals | `extensions/background-terminals.ts` | `bg_start` runs a long command (dev server, watcher, slow build) without blocking the turn; `bg_status`, `bg_list`, `bg_kill` manage it. At most 8 running, stdin ignored, a 256 KB output tail each. When one exits and the model has not looked, the exit is delivered to the session once, when it is idle. The guard decides `bg_start` exactly like `bash`. Each runs in its own process group and is stopped on `bg_kill`, at session shutdown, and if Pi exits. Parent session only. |
| Search tools | `extensions/file-search.ts` | `fd` (files) and `rg` (content) tools, registered only when the binaries are already on your PATH (never downloaded). Bounded output; secret files are excluded and explicit paths follow the same rule as `read`. |
| Phase label | `extensions/odd-phase.ts` | The working message shows the ODD phase (exploring, implementing, checking, delegating · agent). |
| Agents card | `extensions/subagents.ts` | Live rows above the editor while subagents run (model · thinking, tokens, cost, elapsed), and a footer count: `agents: N running · M done · alt+a`. |
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
| `/brigadev:tidy` | With pi-tidy: shows the change that adds `subagent` to pi-tidy's `alwaysShowTools` in `~/.pi/agent/settings.json` (so subagent rows with their model stay visible) and writes it only after you confirm; `/reload` applies it |
| `/brigadev:doctor [fix-bridge-hooks]` | Diagnostics, including the repo docs folder; turn off your Claude Code hooks inside claude-bridge turns |
| `/brigadev:profile …` | Model routing profiles (see below) |
| `/brigadev:cost` | Session cost: orchestrator per model, subagents per agent, cache hit rate |
| `/brigadev:usage` | Subscription usage windows (5h, weekly) and their resets |
| `/brigadev:ui footer\|phase\|dashboard on\|off` | Turn the status bar, the phase label, or the launch dashboard off and on |
| `ctrl+shift+t` / `ctrl+shift+a` | Collapse the todo card / the agents card |
| `alt+g` or `/brigadev:changes` | Changes viewer: uncommitted files and their diffs (`o` opens the file in `$VISUAL` / `$EDITOR`) |
| `alt+k` or `/brigadev:commands` | Command palette: search the brigadev commands, Enter runs one |
| `alt+a` or `/brigadev:runs` | Agents viewer: sync and async subagent runs with their live threads and saved folder. On a running run, `Enter` opens an input line that steers it (or queues a follow-up between turns), `x` twice aborts it, `Esc` goes back |
| `/btw <question>` | Side question: a read-only `brigadev-explore` agent answers in the background; the answer is shown to you and never enters the session's model context |
| `/brigadev:ps` | Background terminals: list, read the output of, and kill (`x`) the processes started with `bg_start` |
| `/brigadev:pr` | The current branch's pull request: number, title, state, reviews, checks, URL (needs `gh`) |
| `/brigadev:copy-all` | Copy the conversation's user and assistant text to the clipboard (`pbcopy`, `wl-copy`, `xclip`, `xsel`, or `clip`) |
| `alt+o` or `/brigadev:panel` | Side panel: todos, agents, changes, and session at a glance. Needs a terminal at least 140 columns wide. It draws over the right 44 columns of the transcript while open; a docked rail would need private Pi internals. (`alt+p` is Pi's own "previous model" key on Windows and WSL, so the panel uses `alt+o`.) |
| `/brigadev:mode [normal\|yolo\|dsp\|default <mode>\|status]` | Permission mode for this session (`dsp` asks once to confirm), or the default for new sessions; `status` also shows how many commands DSP auto-allowed |
| `/brigadev:force-commit` | One-shot: the next `git commit` of the current working tree skips the evidence gate (see below). Only you can run it |
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
- **Subagents:** the run is retried on the next model from the start (a subagent child is a separate `pi --mode rpc` process whose model is fixed at start, so the retry restarts the run from the start).
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

### DSP — dangerously skip permissions

`/brigadev:mode dsp` (after one confirmation dialog; `/brigadev:mode default dsp` makes it the default and `/brigadev:doctor` warns about that) skips brigadev's execution questions: local work runs without asking. **Remote and default-branch actions always ask**, one dialog per command, never remembered for the session, and are denied without a UI. The footer shows `⚠ DSP`. Only brigadev's own guard is affected; Pi's and the CLI's permission checks are untouched, and subagents never inherit DSP's permissions (the guard denies their risky commands without asking, as in the other modes), but their shell commands run in the credential lock (see Subagents). DSP needs a POSIX shell (sh, bash, zsh) as Pi's shell: with `fish`, `nu`, `pwsh`, `elvish`, `xonsh` (or `csh`/`tcsh`) set as `shellPath` in Pi's settings, `/brigadev:mode dsp` refuses and says why, a saved DSP session starts in normal mode, and `/brigadev:doctor` shows that the lock is not applied.

#### What runs without asking

| Command kind | DSP |
| --- | --- |
| ordinary, `git commit` on a feature branch, dependency installs (`npm install`, `pip install`) | run (audited when normal would have asked) |
| `rm -r`, `find -delete`, `truncate`, `dd of=file` inside the project or the system temp dir; writes outside the project to ordinary paths | run |
| local discards: `git reset --hard\|--merge\|--keep`, `rebase`, `branch -D`, `clean -f`, `checkout -- .`/`-f`, `restore`, `switch --discard-changes`, `stash drop\|clear`, `worktree remove -f`, `update-ref`, `reflog expire\|delete`, `gc --prune`, `filter-branch\|filter-repo` | run after an automatic backup |
| read-only remote: `git fetch`, `git pull` on a feature branch, `gh pr view\|list\|checks`, `gh api` GET | run |
| a test runner (`node --test`, `vitest`, `jest`, `mocha`, `ava`, `tap`, `pytest`/`python -m pytest`, `go test`, `cargo test`, named bare or as `node_modules/.bin/<runner>`; or a package script such as `npm test` whose body runs one) whose only remote findings come from the files it loads (the test files it is given and their imports), such as a `git push` or a credential file name used as a fixture or string literal | run, locked (no credentials), recorded in the audit log as `test-runner-locked`. A push or PR typed in the command line (`node --test x.ts && git push`), a package script's own text or non-runner segments (`"pretest": "git push"`, `"test": "node deploy.js"`), a file named like a runner (`./jest`, `scripts/vitest`; the runner file itself is the command, never exempt), `python deploy.py -m pytest` (the flag belongs to the script), or a script that is not a test runner, still asks |

#### What always asks

| Command kind | DSP |
| --- | --- |
| remote: `git push` (any form), `gh pr\|issue\|release\|repo` writes, `gh api` with a non-GET method or fields, `gh workflow run`, publish (`npm publish`, `cargo publish`, `twine upload`, `docker push`, ...), HTTP writes (`curl`/`wget`/`http`/`xh` with POST/PUT/PATCH/DELETE or data) to non-local hosts, `git remote add\|set-url\|remove\|rename`, `git config` of `remote.*`, `url.*`, `alias.*`, `credential.*`, `core.hooksPath`, `push.*`, `gh auth\|alias\|config`, `git send-pack`, `git remote-<helper>` (`remote-https`, ...), `git http-push`, `curl -K`/`--config` (a config file can carry any method) | **always ask** (dialog `brigadev DSP: remote action — needs your OK`) |
| raw remote access: `ssh`/`mosh <host> …`, `scp`/`sftp`/`rsync` with a `host:` or `user@host:` operand (`rsync` between local paths runs), `nc`/`ncat`/`netcat`/`socat`/`telnet`/`ftp`, `openssl s_client`, and bash `/dev/tcp/…` or `/dev/udp/…` redirections (dialog kind "remote shell/copy") | **always ask** |
| default branch: `git commit`, `merge`, `rebase`, `cherry-pick`, `revert`, `am`, `reset`, `pull` while on it (also on a detached HEAD or when the branch cannot be read), and moving or deleting its ref; the same history commands after a `git switch`/`checkout` or `cd` in the same command (`git switch main && git merge x`), or with `git -C <dir>`, because the branch they land on is not the one the guard read | **always ask** |
| a local discard after a directory move (`cd`, `pushd`) or aimed at another repository (`git -C`, `--git-dir`, `--work-tree`, `GIT_DIR=`, `GIT_WORK_TREE=`, `env -C`): the automatic backup can only protect the session's repository | ask |
| `sudo`, `curl … \| sh`, destructive remote or data commands (`gh repo delete`, `gh api -X DELETE`, `dropdb`, `prisma migrate reset`, `db:drop`, `docker system prune`), destructive commands outside the project, commands the guard cannot read | ask |
| catastrophic (`rm -rf ~`, `mkfs`, `dd of=/dev/…`) | block |

#### Backups

Before a local discard the guard writes a snapshot commit of the whole working tree (tracked and untracked files that are not ignored, built with a temporary index, parent `HEAD`) to `refs/brigadev/backup/<UTC timestamp>-<reason>`, plus one ref for each ref about to be lost (a deleted branch's tip, a dropped stash). Restore with `git checkout <ref> -- .` or `git branch <name> <ref>`. If the backup fails, the command asks (or is denied without a UI); when the command already asked (a remote action, or a discard that also needs your OK) and the backup then fails, a second dialog ("the automatic backup failed (…); run without a backup?") asks again, and without a UI it is denied. Backup refs older than 14 days are removed, at most 50 per run. Ignored files are not part of a snapshot, so a discard that deletes them (`git clean -x`, `git checkout -f` over ignored files) cannot be restored from it.

#### Audit

Every command DSP ran without asking that normal mode would have asked about is appended to `~/.brigadev/<repo>/audit/dsp.jsonl` (time, branch, command preview, kind, backup refs). The preview has obvious secrets taken out (`Authorization`/`Bearer`/`…token` header values, `user:pass@` in URLs, `--token`/`--password` values, `_authToken=`, the values of variables the credential lock removes); this is a text filter, not a guarantee. The `audit/` directory is created with mode 0700 and the file with 0600. The model cannot write that file (the same textual protection as `evidence/`), and `/brigadev:mode status` shows `DSP: N auto-allowed this session`.

#### What else asks: bypass prevention

The remote rules also see through `env`, `command`, `builtin`, `exec`, `nice`, `nohup`, `time`, `timeout`, `xargs`, `sh -c`, `eval`, `$( )` and backticks, `git -C`/`-c`/`--git-dir`, full paths, `hub`, `git-push`-style dashed names, and git aliases (resolved with `git config --get alias.<name>`). Command runners are unwrapped when the inner command is literal: `su [user] -c '…'`, `runuser`, `sg`, `script -c '…'` and `script file command…`, `flock`, `chroot`, `unshare`, `setsid`, `stdbuf`, `caffeinate`, `doas`, `sshpass`, `parallel` (the command template, or the `:::` arguments when there is none) and `osascript -e 'do shell script "…"'`; `su`, `runuser` and `chroot` also count as elevated privileges and ask. Here-strings (`bash <<< 'git push'`) are scanned like heredocs. Commands whose remote-ness cannot be decided ask: `eval`/`sh -c`/a here-string with variable or substitution text, a command name or a git/package-manager subcommand that is a variable, a script that is written and run in one command, `xargs`/`parallel` whose command, subcommand or HTTP options come from their input or from `{}` (`echo push | xargs git`, `xargs -I{} git {}`; plain `xargs -n1 echo` runs), `parallel` or `osascript` commands that come from a file, standard input, a script file or text assembled at run time, and inline interpreter code that starts processes (`python -c` with `os.system`/`subprocess`, `node -e` with `child_process`/`exec(`/`spawn`, `perl`/`ruby`/`php -e|-r` with `system`, `exec`, backticks, `deno eval`, `bun -e`, `lua -e`), because the command it runs can be assembled at run time (inline code that only computes or prints runs). All of this also applies to the text of a script, Makefile recipe or package script that is scanned; a merge or rebase after a `git switch`/`checkout` in the script is a hit too. Running a script (`bash x.sh`, `./x.sh`, `node x.js`, `python x.py`), a `make` target, or an `npm run` script is scanned (up to 256 KB, a few levels of nesting); a remote form inside asks, and an unreadable or too large file asks. Protected paths ask in DSP even though writes outside the project are otherwise allowed: `~/.pi/`, this package's install root (unless the project is the checkout itself), `~/.gitconfig`, `~/.config/git/`, `~/.config/gh/`, `.git/config`, `.git/hooks/`, shell startup files, and the audit log (blocked). Reading secrets (`.env`, keys) still asks.

#### Credential lock

Besides reading the command, DSP takes your push credentials away from the agent's shells. In DSP every `bash` call and every `bg_start` of the parent session starts without them, so a push, PR or publish that slipped past the text rules fails on its own; only a call you approved in the remote dialog (that one call, never remembered) runs with your real credentials. The lock removes `SSH_AUTH_SOCK`, `SSH_AGENT_PID` and every variable whose name has a `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`, `API_KEY`, `ACCESS_KEY[_ID]`, `SECRET_ACCESS_KEY`, `SESSION_TOKEN`, `PRIVATE_KEY`, `CREDENTIAL[S]` or `AUTH` word between underscores (`GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `NODE_AUTH_TOKEN`, `CARGO_REGISTRY_TOKEN`, `TWINE_PASSWORD`, `AWS_SECRET_ACCESS_KEY`; `PATH`, `TOKENIZERS_PARALLELISM` and `AUTHOR_NAME` stay). It sets `GH_CONFIG_DIR` and `DOCKER_CONFIG` to `/var/empty/brigadev` (a path nobody can create under the read-only system folder `/var/empty`; where that folder is missing or writable, `/dev/null/brigadev`, which cannot exist either), `NPM_CONFIG_USERCONFIG` and `AWS_SHARED_CREDENTIALS_FILE` to `/dev/null`, `GIT_TERMINAL_PROMPT=0`, `GCM_INTERACTIVE=never`, and `GIT_ASKPASS`/`SSH_ASKPASS` to the system `false` (its absolute path, found once). For git it appends two `GIT_CONFIG_*` entries after any you already have: an empty `credential.helper` (which resets every helper, including the macOS keychain helper from the system config) and a `core.sshCommand` (also `GIT_SSH_COMMAND`) that uses no agent and no identity files. The lock needs no file and no directory the agent's processes could write (a lock script in a writable temp dir could be rewritten by a background loop, so there is none). For `bash` the guard decides and asks about the command as the model wrote it, then puts one inline line before it: `unset -v <the variables present>&&export GIT_SSH_COMMAND=…&&export <the overrides> || exit 1`, then a newline, then the command. The line is static text computed once per session from the environment Pi started with (about 570 characters, about 150 tokens per call, no file read or written); every step is chained so a command never runs half-locked, and the exit code, working directory, stdin and `$?` are the command's (checked under `sh`, `bash`, `zsh` and `dash`). For `bg_start` the same values go through the process environment. Because nothing is copied, npm private-registry auth (`~/.npmrc` tokens) and docker plugins and contexts from your user config (`cli-plugins`, `contexts`, `auths`, credential helpers) are not available in locked commands (docker finds no config at all); installs from public registries work. With `gh` the lock means not logged in: on a system with `/var/empty` `gh` says so, with the `/dev/null` fallback `gh` refuses to start ("failed to read configuration"); read commands need your token anyway. `HOME` is unchanged: fetches and pulls of public remotes still work. `normal` and `yolo` are unchanged, and `/brigadev:doctor` shows the lock in DSP. What the lock does not cover is listed once, under Known gaps.

#### Text layer around the lock

What else asks in DSP (the text layer around the lock, so the agent does not take it off or reach the credentials another way, except in the files a test runner loads: see Known gaps): assigning, exporting or `env`-setting a credential variable (`SSH_AUTH_SOCK`, `GH_CONFIG_DIR`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`, `GIT_ASKPASS`, `NPM_CONFIG_USERCONFIG`, `DOCKER_CONFIG`, `AWS_SHARED_CREDENTIALS_FILE`, or any name the removal pattern matches); `unset` and `env -u|-i` of the overrides; `launchctl getenv|asuser`, `security find-*-password|dump-keychain|export`, `ssh-add`, `ssh -i`, `gh auth token|login|switch|refresh`, `git credential*`; the `read` tool on credential files (`~/.git-credentials`, `~/.docker/config.json`, `~/.config/gh/*`, `~/.ssh/`, `~/.netrc`, `~/.npmrc`, `~/.aws/`; normal and yolo do not ask) and shell commands that read them; command strings in git options and config keys that hold a remote form (`-c core.sshCommand='…'`, `GIT_SSH_COMMAND`, `fetch --upload-pack`, `core.fsmonitor`, `core.pager`, `rebase --exec`, `submodule foreach`, `bisect run`, `difftool -x`) are scanned like the command itself; and so are package runners and wrappers (`npx`, `pnpm exec|dlx`, `yarn exec`, `npm exec`, `bunx`, `uv run`, `poetry run`, `bundle exec`, `busybox`, `toybox`, `taskset`, `tmux`, `screen`, `env -S`, …): a remote form inside them asks.

#### Subagents

A subagent never gets DSP's permissions: its guard has no DSP rules and denies risky commands without asking, as in the other modes. While the parent session is in DSP, every subagent it launches carries `BRIGADEV_DSP_LOCK=1` in its environment, and that subagent's guard runs every one of its `bash` calls behind the same credential-lock line (a subagent has no remote dialog, so its calls are never unlocked). The subagent process itself keeps the parent's environment, because it needs its provider keys to talk to the model; only the shell commands it runs are locked. Subagents launched while the parent is in normal or yolo mode are unchanged.

#### Known gaps

DSP is a textual guard plus an environment lock, not a sandbox. Treat it as "do not interrupt me for local work", not as a safe place for untrusted instructions. What it does not cover:

- The text layer does not ask about files a test runner loads (`node --test`, `vitest`, `jest`, `pytest`, a package `test` script that runs one, ...): they run credential-locked, but a loaded file that reads credentials the lock does not hide, such as `~/.netrc`, an `ssh -i` key or a project `.env`, is not caught. A remote action typed in the command line, in the package script's own text, or run by anything that is not a runner still asks.
- A program that opens its own network connection (a compiled binary, a script that builds its command from data, hooks, a Makefile that includes another, a script file whose spawned commands are assembled at run time, interpreters not listed above) is not detectable by text.
- Credentials the lock cannot take away: `~/.netrc` (libcurl reads it for git over https; `/brigadev:doctor` in DSP warns when the file exists), `~/.git-credentials` read by a program, password managers (`op`, `pass`, `bw`), cloud CLIs other than AWS's credentials file, yarn/pnpm config files, a project `.npmrc`, the OS keychain read by other tools, programs with their own network and credential stores, a passphrase-less key used by a direct `ssh -i` (the text layer asks about it when it is typed in the command line, not when a file a test runner loads does it), credentials in a file a command reads itself, and secret variables whose names the pattern does not match.
- `gh` keeps its token in the OS keyring on some systems; with `GH_CONFIG_DIR` pointed away `gh` finds no account, but a keyring fallback was not verified on every platform and `gh` version.
- Task runners whose task names are not resolved to their recipes (only `make`, `just`, and `npm`/`pnpm`/`yarn`/`bun` scripts are read), and `mise run` tasks.
- `at -f <file>`: the job starts from a service with your environment and the file is not scanned.
- The lock line is computed once per session from the environment Pi started with: a secret variable that appears in Pi's own environment later is not in it (`bg_start` reads the environment at each start).
- Ignored files are not in a backup snapshot: `git clean -x` and `git checkout -f` over ignored files cannot be restored.
- Non-POSIX shells are not supported: with one as Pi's `shellPath`, DSP refuses (see above). Only Pi's `shellPath` setting (the project's `.pi/settings.json`, then the global one) is read; a shell chosen another way is not detected.

## Evidence gate

Every check command (tests, lint, typecheck, build) run through bash, by you or by any subagent, is recorded with its command, exit code, time, directory, agent, and output tail in `~/.brigadev/<repo>/evidence/<branch>.jsonl`, an append-only log keyed to the content of the working tree it ran on. Outside git nothing is recorded. The log stores commands and output tails in plaintext (file mode 0600), so treat it as sensitive.

A `git commit` with source changes anywhere in the repository (not only the session's folder) is blocked unless a passing test run is recorded for the current working tree. Any edit after the last passing run changes the tree and blocks the commit until the tests run again; committing without new edits does not. Only the `test` kind counts (`npm test`, `node --test`, `pytest`, `go test`, ...), not lint or build. A commit that runs in another directory or on another branch cannot be checked, so it is blocked too. The gate fails closed: if the working tree cannot be computed (git takes longer than 10 seconds, or fails), the commit is blocked with that reason, and only the guard dialog can force it (`/brigadev:force-commit` needs a computable tree). Outside git nothing is gated.

The exit-code rule: a run counts only when its exit code is the test's. The test must be the command itself (`npm test`, `CI=1 npx vitest`), in its own bash command or an `&&` chain; naming it as an argument (`echo npm test`, `grep "node --test" package.json`) does not count. A `||`, `;`, `&`, `!`, `#` comment, subshell, `$(...)`, backtick, or a `|` after the test hands the exit code to something else, and so does an `exit`, `exec`, `eval`, or `source` before it, so the run is recorded as unknown and does not pass the gate. The one exception is a leading `set -o pipefail;`, which allows a pipe after the test. A `cd` before the test must stay inside the repository.

A run is also keyed to the tree only if the tree was the same before and after it. An edit made while the tests ran (a parallel tool call, `tests && edit`) is not vouched for: that run is recorded as unknown with a `note`.

Only you can force it. With a UI, the guard shows why the commit is blocked and asks whether to commit anyway. Without one, run `/brigadev:force-commit` before the commit: it applies once and only to the working tree as it is now, so editing a file first cancels it. Each force is logged in the evidence file, and only when the commit then goes ahead (a later guard rule that declines it spends nothing). There is no flag or environment variable that forces the gate, and subagents never reach it (they cannot commit).

This is a best-effort guard, not a sandbox. It recognises commits the way the command classifier does, so commit forms it does not recognise (shell aliases, plumbing such as `git commit-tree`, wrappers, scripts) are not gated. Deliberate tricks with runner options or environment can still fake a pass, so a package-manager test run (`npm`, `pnpm`, `yarn`, `bun`) counts only as plain `npm test` (optionally `-s`/`--silent`, with arguments after `--`) and without `npm_config_*` variables; run workspace or filtered tests through the runner directly or as `npm test -- <args>` in that package's directory. To keep a model from forging a pass, `write`/`edit` calls into the evidence folder and bash commands that name it together with a write (redirection, `tee`, `cp`, `mv`, `rm`, `sed`, an interpreter, ...) are blocked, while reading stays allowed; a deliberately obfuscated command (a path built from variables, `cd` then a relative write) is not prevented.

Changes that touch only prose (`.md`, `.markdown`, `.rst`, `.adoc`, `LICENSE`, `NOTICE`, `COPYING`, `AUTHORS`) pass without a test run; `.txt` and `.mdx` count as source (`requirements.txt`, `CMakeLists.txt`). The gate applies in every permission mode, including yolo.

## Repo docs folder

Harness documents live outside the project, in `~/.brigadev/<repo>/` (`BRIGADEV_HOME` overrides `~/.brigadev`): feature documents in `tasks/`, review ledgers in `reviews/`, and one folder per subagent run in `runs/<runId>/` (`task.md`, `transcript.json`, `result.json`, user-only permissions; pruned at session start: folders older than 14 days go, then the oldest beyond 200, at most 50 per session start; age comes from the folder name, and entries not named like a run id are never touched). `<repo>` is the basename of the main worktree root, so every worktree of a repository shares one folder; outside git it is the directory name. The parent session writes there without asking; subagents still cannot write outside the project. `/brigadev:status` and `/brigadev:doctor` print the resolved folder.

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

- **Agents**: override any package agent by name in `~/.pi/agent/agents/<name>.md` or `.pi/agents/<name>.md` (trusted projects). Frontmatter: `name`, `description`, `tools`, `model`, `thinking`, `writer: true`, `admission: risk`, `output: <file>.schema.json` (a JSON Schema next to the agent file: the agent must return its result through a `structured_output` tool, the parent validates it, and a run without a valid result fails after one reminder).
- **Orchestrator rules**: edit `assets/orchestrator.md` and the lazy files next to it.
- **Skills**: edit `skills/*/SKILL.md`, then `/reload`.
- **Default mode**: `/brigadev:mode default yolo` (or `normal`, `dsp`) writes `~/.pi/agent/brigadev.json`.

## Development

```bash
npm test   # node --test, no build step (Node ≥ 22.19 runs TypeScript directly)
```

Pure logic lives in `lib/` and is covered by `tests/`. Extensions are thin adapters over the Pi API.

## claude-bridge and Claude Code hooks

`pi-claude-bridge` starts Claude Code with your user settings on every turn, so your Claude Code hooks and plugin hooks run inside Pi turns and inject their output. `/brigadev:doctor` detects it; `/brigadev:doctor fix-bridge-hooks` adds one line (`disableAllHooks: true`) to the installed bridge. Normal Claude Code sessions keep their hooks. A bridge update undoes the line: the doctor warns at the next session start; run the fix again.

## Known limits (MVP)

- Edit surfaces and `bash`: `write` and `edit` are blocked outside a writer's surfaces. For `bash`, the guard blocks calls that write a literal project path outside the surfaces (`>`, `>>`, `&>`, `tee`, `sed -i`, `cp`/`mv`/`install`/`ln` destinations, `touch`, `mkdir`, `truncate`). This is best effort: variables, globs, substitutions, and scripts run by an interpreter (`python3 - <<EOF`) are not parsed. In a git repository the guard also compares the working tree before and after each writer `bash` call and flags any file changed outside the surfaces, after the fact: it reports the paths and marks the result as an error, and never reverts anything. Ignored files and repositories without git are not covered by that check. After a launch with writers, the `subagent` result also lists files changed outside the writers' surfaces. Writes outside the project root (such as the system temp dir) are not restricted by these checks.
- Async subagent launches live in the running Pi process: results do not survive a reload or restart (children are stopped at session shutdown), and a finished run cannot be resumed or continued, only read from its saved folder. Run folders under `~/.brigadev/<repo>/runs/` are kept up to 14 days (at most 200) and may contain anything a child read.
- Profiles have no per-repository pin and are not frozen at session start: a session without its own profile follows the default as it changes.
- No "auto" permission mode (classifier-based approvals).
- Memory mirroring of feature documents is used only when a memory tool such as `mem_save` is available.

## License

MIT © 2026 Marcos Juan (see `LICENSE`). brigadev-harness builds on ideas and adapted material from [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) and Pi's subagent example; credits and their license notices are in `NOTICE.md`.
