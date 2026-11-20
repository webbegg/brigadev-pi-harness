# brigadev-harness

An opinionated [Pi](https://pi.dev) package for a disciplined development loop: one accountable orchestrator in the parent session, a few focused subagents with per-agent model routing, an evidence gate in front of every commit, and a safety guard. It adds no UI beyond a status bar, a todo list, and two read-only viewers (changes, agents).

## Install

```bash
# Try it for one session
pi -e /path/to/brigadev-harness

# Install for every session (local path, loaded in place)
pi install /path/to/brigadev-harness

# Project-only
pi install -l /path/to/brigadev-harness
```

Check it loaded: `/brigadev:status`. Run `/brigadev:doctor` if something looks off.

## The loop

| Step | What happens | Mechanism |
| --- | --- | --- |
| 1. Ask | Questions and reviews stay read-only until you ask for a change; real design forks get one question with a recommended option. | `assets/orchestrator.md`, `ask_user_choice` |
| 2. Explore | One batch of `read`, `grep`, `find`, `ls` in the parent; a `brigadev-explore` subagent only when that does not settle it. | built-in tools, `subagent` |
| 3. Test first | RED, minimal change, GREEN; bugs follow a diagnosis routine. | `assets/diagnosis.md`, `brigadev-worker` for parallel writers |
| 4. Check | The focused test, then the suite, through one tool that returns a compact result and records evidence. | `check` tool, evidence gate |
| 5. Verify | A path-based risk tier (shown by `check`) decides the checks: T2 (data, security, contract) branches get one independent `brigadev-verify` before the PR; blocker fixes are proven by a repro test RED→GREEN. | `subagent`, `Risk: <category>` line |
| 6. Commit / PR | Each finished unit is committed on a `type/description` branch; push, PR, and merge go through the guard. `brigadev-review` runs only on request or once before the PR, with the tier's lenses ([review tiers](docs/configuration.md#review-tiers)). | `brigadev-branch-pr`, `brigadev-review` |

Large multi-session work gets one feature document in the repo docs folder (`/track`); small work leaves no artifacts. A long session compacts itself (see Configuration). Start a day-to-day task from `alt+w` or `/brigadev:start`: feature, ticket, bug fix, refactor, my PRs' feedback, or a team PR review.

## Safety

- **Modes:** `NORMAL` (default) and `YOLO`, switched with `/brigadev:mode`. The mode is announced as a context message, never written into the system prompt, so switching keeps the prompt cache.
- **Always asks, in both modes:** destructive commands (`rm -rf dir`, `git reset --hard`, force push), publish (`npm publish`, `gh pr merge`), privileged (`sudo`, `curl | sh`), dependency installs, writes outside the project, secret files, and protected paths (`.git/hooks`, shell rc files, `~/.pi`). Catastrophic commands (`rm -rf ~`, `mkfs`) are blocked. NORMAL also asks before `git push` and PR creation; YOLO runs them. Without a UI, "ask" means block.
- **Evidence gate:** a commit with source changes is blocked until a passing test run is recorded for the current working tree. Any later source edit invalidates it; docs-only edits do not. Piped test runs get `pipefail`, and commits through `git -C <dir>` or `cd <dir> &&` are checked against that repository. Only you can force a commit, with `/brigadev:force-commit` or the guard dialog.
- **Subagents** never wait on a person: the guard denies what would need confirmation, and writers are held to their allowed edit surfaces.

Details: [docs/safety.md](docs/safety.md), [docs/evidence-gate.md](docs/evidence-gate.md).

## Subagents and model routing

The `subagent` tool runs an agent in its own `pi --mode json` process, synchronously, at most 4 at once (`tasks[]` runs up to 8 in parallel). Every launch needs a `reason`. Agents:

- `brigadev-explore`: read-only exploration.
- `brigadev-worker`: bounded writer; needs narrow `allowedEditSurfaces`, parallel writers must be disjoint.
- `brigadev-verify`: independent verifier for high-risk changes; needs `Risk: <category>`; works with or without a feature document.
- `review-4r`: one pass over a frozen diff with the four lenses (Risk, Readability, Reliability, Resilience).

Children return a compact result (verdicts, blockers, paths) and the full one is saved under `~/.brigadev/<repo>/runs/<runId>/`. A stall watchdog stops a silent child.

A profile maps the orchestrator and each agent to a model and thinking level:

```bash
/brigadev:profile init                 # add economy / balanced / deep
/brigadev:profile use economy          # this session only
/brigadev:profile default balanced     # default for new sessions
/brigadev:profile set economy brigadev-worker claude-sonnet-5-5 high
```

Per field, a launch resolves: session profile, default profile, agent frontmatter, then the session's model. More in [docs/subagents.md](docs/subagents.md).

## Commands

| Command | Purpose |
| --- | --- |
| `/brigadev:status` | Version, paths, repo docs folder |
| `/brigadev:doctor` | Diagnostics and warnings (competing tools, large tool definitions, bridge hooks) |
| `/brigadev:mode [normal\|yolo\|default <mode>\|status]` | Permission mode for this session or the default |
| `/brigadev:codemode [on\|off]` | Pi's `codemode` tool in the parent session, on by default; saved for new sessions |
| `alt+w`, `/brigadev:start [workflow]` | Workflow menu |
| `/brigadev:profile …` | Model routing profiles |
| `/brigadev:cost` | Session cost by model and agent, cache hit rate, subscription usage windows |
| `/brigadev:stats [all\|<N>d]` | Cost by phase, context percentiles, cache rebuilds, gate blocks from Pi's session logs |
| `alt+g`, `/brigadev:changes` | Uncommitted files and diffs (read-only) |
| `alt+a`, `/brigadev:runs` | Agents viewer: every subagent run with its thread (read-only) |
| `/brigadev:ps` | Background processes started with `bg_start` |
| `/brigadev:pr` | The current branch's pull request (needs `gh`) |
| `/brigadev:force-commit`, `/brigadev:yolo-dir` | One-shot commit override; folders where writes run without asking |
| `/track`, `/review` | Force feature-document tracking; 4R review of a frozen change |

Also: `/brigadev:agents`, `/brigadev:harness on|off`, `/brigadev:ui footer on|off`; `ctrl+shift+t` and `ctrl+shift+a` collapse the todo and agents cards.

## Configuration

`~/.pi/agent/brigadev.json` (all keys optional):

| Key | Meaning |
| --- | --- |
| `defaultMode` | `normal` (default) or `yolo` for new sessions |
| `secureYoloDirs` | Folders outside the project where the parent's `write`/`edit` skip the question (`/brigadev:yolo-dir`) |
| `codemode` | `false` stops the harness from enabling Pi's `codemode` tool in the parent session (`/brigadev:codemode`) |
| `bridgePricing` | `false` stops pricing zero-cost `claude-bridge` turns at the API list price |
| `ui.footer`, `ui.compactTools` | `false` turns off the status bar or the one-line tool rows |
| `check.test` | Test command for the `check` tool; detected from the project when absent |
| `context.enabled`, `context.compactAt`, `context.idleCompactMinutes`, `context.idleCompactMin` | Automatic compaction: at 160,000 tokens at a turn boundary, or on a request after 60 idle minutes with at least 100,000 tokens; `enabled: false` turns it off |

Profiles live in `~/.pi/agent/brigadev-profiles.json`. Paths, environment variables, and agent overrides: [docs/configuration.md](docs/configuration.md).

## Development

```bash
npm test   # node --test tests/*.test.ts; no build step (Node >= 22.19 runs TypeScript directly)
```

Pure logic lives in `lib/` and is covered by `tests/`; extensions in `extensions/` are thin adapters over the Pi API.

## Known limits

- The guard recognizes executable command forms; it is not a sandbox. Aliases, scripts, and obfuscated commands can slip past the classifier and the evidence gate.
- Edit surfaces for `bash` are best effort (literal paths only); a writer's changes outside its surfaces are reported after the call, not reverted.
- A read-only child can still write through `bash`.
- Subagent runs live in the running Pi process: a finished run cannot be resumed, only read from its saved folder (kept 14 days, at most 200).
- No classifier-based "auto" permission mode.
- `pi-claude-bridge` runs your Claude Code hooks inside Pi turns: see [docs/claude-bridge.md](docs/claude-bridge.md).

## License

MIT © 2026 Marcos Juan (see `LICENSE`). brigadev-harness builds on ideas and adapted material from [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) and Pi's subagent example; credits and their license notices are in `NOTICE.md`.
