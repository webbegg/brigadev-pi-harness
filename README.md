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
| ODD tracking | `assets/odd-tracking.md`, `/track` | Large work gets one feature document at `odd/tasks/<name>.md` (Specs quoted verbatim, Tasks, Log) and a `todo` projection. Small work stays inline with no artifacts. |
| Subagents | `extensions/subagents.ts`, `assets/agents/` | `subagent` tool runs each agent in its own `pi` process. Every launch needs a `reason`; the verifier needs `Risk: item N`; writers need narrow `allowedEditSurfaces`, and parallel writers must be disjoint. Specs travel by reference (`featureDoc`), skills by exact path. |
| Review | `skills/brigadev-review`, `/review` | 4R lenses (Risk, Readability, Reliability, Resilience) on one frozen candidate; only the lenses that fit. |
| Judgment Day | `skills/brigadev-judgment-day`, `/skill:brigadev-judgment-day` | Two blind judges, frozen ledger, at most two scoped fix and re-judgment rounds. |
| Safety guard | `extensions/guard.ts` | Confirms destructive, delivery, publish, and privileged commands; hard-denies catastrophic ones; asks before writes outside the project or touching secret files. In subagents: blocks all of those and enforces allowed edit surfaces. |
| Todo | `extensions/todo.ts` | Visible task list with `pending / in_progress / done / blocked / dropped`. Kept out of the system prompt so updates never break the prompt cache. |
| Status bar | `extensions/shell-bar.ts` | One-line footer: repo, branch ±dirty, yolo, model · thinking, context gauge, cost, profile. |
| Phase label | `extensions/odd-phase.ts` | The working message shows the ODD phase (exploring, implementing, checking, delegating · agent). |
| Agents card | `extensions/subagents.ts` | Live rows above the editor while subagents run (model · thinking, tokens, cost, elapsed). |
| Ask dialog | `extensions/ask-user.ts` | `ask_user_choice`: focused questions as a dialog with a recommended option. |
| Model routing | `extensions/profiles.ts` | Named profiles route the orchestrator and every agent to a model and thinking level. |
| Cost | `extensions/cost.ts` | API-equivalent pricing for `claude-bridge` turns, session tally, `/brigadev:cost` breakdown. |
| Delivery skills | `skills/` | work-unit commits, branch/PR, chained PRs, issue creation, comment writer, skill creator. |

## Commands

| Command | Purpose |
| --- | --- |
| `/brigadev:status` | Version, prompt on/off, paths |
| `/brigadev:doctor [fix-bridge-hooks]` | Diagnostics; turn off your Claude Code hooks inside claude-bridge turns |
| `/brigadev:profile …` | Model routing profiles (see below) |
| `/brigadev:cost` | Session cost: orchestrator per model, subagents per agent, cache hit rate |
| `/brigadev:ui footer\|phase on\|off` | Turn the status bar or the phase label off and on |
| `ctrl+shift+t` / `ctrl+shift+a` | Collapse the todo card / the agents card |
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

## Cost visibility

`pi-claude-bridge` runs Claude Code on your subscription and records every turn at $0. brigadev prices those turns at the Anthropic list price of the same model when they end, so Pi's footer, session files, the `brigadev-cost` status, and `/brigadev:cost` show what the tokens would cost on the API. Subagent turns are priced the same way. This is a comparison number, not your subscription bill. Turn it off with `{"bridgePricing": false}` in `~/.pi/agent/brigadev.json`.

## Permission modes

| Command kind | normal | yolo | subagent |
| --- | --- | --- | --- |
| ordinary (`npm test`, `git status`) | run | run | run |
| delivery (`git commit`, `git push`, `gh pr create`) | ask | run | block |
| destructive (`rm -rf dir`, `git reset --hard`, `git push --force`, `DROP TABLE`) | ask | ask | block |
| publish (`npm publish`, `gh pr merge`, `gh release`) | ask | ask | block |
| privileged (`sudo`, `curl … \| sh`) | ask | ask | block |
| catastrophic (`rm -rf ~`, `rm -rf /`, `mkfs`, `dd of=/dev/…`) | block | block | block |

Without a UI (print mode), "ask" means block. The guard recognizes executable forms; it is not a sandbox.

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

- Edit-surface enforcement covers the `write` and `edit` tools; a writer's `bash` could still write elsewhere (the prompt forbids it, the runtime does not parse redirections).
- Subagents run in the foreground (parallel within one call). No background jobs, agent dashboard, or model fallback chains yet.
- Profiles have no per-repository pin and are not frozen at session start: a session without its own profile follows the default as it changes.
- No "auto" permission mode (classifier-based approvals).
- Memory mirroring of feature documents is used only when a memory tool such as `mem_save` is available.

See `NOTICE.md` for attribution.
