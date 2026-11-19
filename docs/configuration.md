# Configuration

## `~/.pi/agent/brigadev.json`

All keys are optional; `PI_CODING_AGENT_DIR` relocates the agent folder.

```json
{
  "defaultMode": "normal",
  "secureYoloDirs": ["/Users/you/scratch"],
  "bridgePricing": true,
  "ui": { "footer": true, "compactTools": true },
  "check": { "test": "npm test" },
  "context": { "enabled": true, "compactAt": 160000, "idleCompactMinutes": 60, "idleCompactMin": 100000 }
}
```

- `defaultMode`: `normal` or `yolo` (`/brigadev:mode default <mode>`). Anything else falls back to `normal`.
- `secureYoloDirs`: managed with `/brigadev:yolo-dir`; hand-edited entries that fail its checks are ignored (`/brigadev:yolo-dir list` says why).
- `bridgePricing`: price zero-cost `claude-bridge` turns at the API list price.
- `ui.footer` (`/brigadev:ui footer on|off`) and `ui.compactTools` (one-line rows for built-in tools; read at startup, `/reload` applies it).
- `check.test`: the test command the `check` tool runs; when absent it is detected (`npm test`, `pytest`, `cargo test`, `go test`). The tool also takes `command`, `focus` (appended, for example one test file) and `timeoutSeconds` (default 600).
- `context`: automatic compaction through Pi's `ctx.compact`. At a turn boundary it compacts when context reaches `compactAt` tokens (`0` turns that rule off); before a request that arrives after `idleCompactMinutes` idle minutes (`0` turns it off) it compacts if context holds at least `idleCompactMin` tokens, then continues. `enabled: false` disables both. It adds no text to the model's context; `/brigadev:doctor` shows the settings and the last compaction.

## Other files and variables

- `~/.pi/agent/brigadev-profiles.json`: model routing profiles ([subagents.md](subagents.md)).
- Repo docs folder `~/.brigadev/<repo>/` (`BRIGADEV_HOME` overrides `~/.brigadev`): feature documents in `tasks/`, review ledgers in `reviews/`, the evidence log in `evidence/`, and subagent runs in `runs/`. `<repo>` is the basename of the main worktree root, so every worktree of a repository shares one folder; outside git it is the directory name. The parent writes there without asking; subagents cannot. `/brigadev:status` and `/brigadev:doctor` print the resolved path.
- `BRIGADEV_STALL_TIMEOUT_MS`, `BRIGADEV_TOOL_STALL_TIMEOUT_MS`: child stall limits.
- Orchestrator rules live in `assets/orchestrator.md` and the lazy files next to it (`delegation.md`, `odd-tracking.md`, `diagnosis.md`), re-read on every prompt; skills in `skills/*/SKILL.md` (then `/reload`). `/brigadev:harness off` drops the orchestrator prompt for the session (A/B testing).

## Delivery

An authorized change on the default branch starts a `type/description` branch, and each finished work unit is committed (Conventional Commits, with its tests and docs). Push, PR, and merge stay your decisions and go through the guard. Before a PR the agent asks whether to run `brigadev-review` (full 4R, the lenses that fit, or skip) and saves the ledger to `reviews/`. The PR body follows the repository template, else Summary / Changes / Test plan / Risk. Chaining oversized changes is in `skills/brigadev-branch-pr/references/chaining-details.md`.
