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
  "context": { "enabled": true, "compactAt": 160000, "idleCompactMinutes": 60, "idleCompactMin": 100000 },
  "risk": { "paths": { "data": ["db/**"] }, "repos": { "my-repo": { "security": ["src/policy/**"] } } }
}
```

- `defaultMode`: `normal` or `yolo` (`/brigadev:mode default <mode>`). Anything else falls back to `normal`.
- `secureYoloDirs`: managed with `/brigadev:yolo-dir`; hand-edited entries that fail its checks are ignored (`/brigadev:yolo-dir list` says why).
- `bridgePricing`: price zero-cost `claude-bridge` turns at the API list price.
- `ui.footer` (`/brigadev:ui footer on|off`) and `ui.compactTools` (one-line rows for built-in tools; read at startup, `/reload` applies it).
- `check.test`: the test command the `check` tool runs; when absent it is detected (`npm test`, `pytest`, `cargo test`, `go test`). The tool also takes `command`, `focus` (appended, for example one test file) and `timeoutSeconds` (default 600).
- `context`: automatic compaction through Pi's `ctx.compact`. At a turn boundary it compacts when context reaches `compactAt` tokens (`0` turns that rule off); before a request that arrives after `idleCompactMinutes` idle minutes (`0` turns it off) it compacts if context holds at least `idleCompactMin` tokens, then continues. `enabled: false` disables both. It adds no text to the model's context; `/brigadev:doctor` shows the settings and the last compaction.
- `risk`: extra globs for the risk map (see Review tiers), per category (`data`, `security`, `contract`, `concurrency`, `delivery`) for every repository (`paths`) or one repository by its top-level folder name (`repos`). Additive only: entries raise a tier, never lower it; invalid entries are ignored and `/brigadev:doctor` lists them.

## Other files and variables

- `~/.pi/agent/brigadev-profiles.json`: model routing profiles ([subagents.md](subagents.md)).
- Repo docs folder `~/.brigadev/<repo>/` (`BRIGADEV_HOME` overrides `~/.brigadev`): feature documents in `tasks/`, review ledgers in `reviews/`, the evidence log in `evidence/`, and subagent runs in `runs/`. `<repo>` is the basename of the main worktree root, so every worktree of a repository shares one folder; outside git it is the directory name. The parent writes there without asking; subagents cannot. `/brigadev:status` and `/brigadev:doctor` print the resolved path.
- `BRIGADEV_STALL_TIMEOUT_MS`, `BRIGADEV_TOOL_STALL_TIMEOUT_MS`: child stall limits.
- Orchestrator rules live in `assets/orchestrator.md` and the lazy files next to it (`delegation.md`, `odd-tracking.md`, `diagnosis.md`), re-read on every prompt; skills in `skills/*/SKILL.md` (then `/reload`). `/brigadev:harness off` drops the orchestrator prompt for the session (A/B testing).

## Delivery

An authorized change on the default branch starts a `type/description` branch, and each finished work unit is committed (Conventional Commits, with its tests and docs). Push, PR, and merge stay your decisions and go through the guard. Before a PR the agent follows the branch's review tier (below) and saves any review ledger to `reviews/`. The PR body follows the repository template, else Summary / Changes / Test plan / Risk. Chaining oversized changes is in `skills/brigadev-branch-pr/references/chaining-details.md`.

## Review tiers

The branch's changed paths (against its merge-base with the default branch — `origin/HEAD`, `main`, `master`, `init.defaultBranch`, `develop`, or `trunk`, whichever resolves first — plus uncommitted changes; when none resolves, `check` prints no line and the PR gate asks) set a tier through a path-based risk map (`lib/risk-map.ts` defaults plus `risk` above). `check` prints it as one line when it changes, for example `risk T2 security(lib/guard-rules.ts) → before PR: brigadev-verify + R1,R3`.

| Tier | When | Before the PR |
| --- | --- | --- |
| T0 | only tests, fixtures, or plain docs | tests and the evidence gate; no review, disclosed in the PR Risk line |
| T1 | other source or prompt files | one `review-4r` pass with the fitting lenses: R3, plus R1 for security/delivery paths and R4 for data/concurrency paths; R2 only for prompt/docs diffs or on request |
| T2 | a data, security, or contract path | one `brigadev-verify` for the whole branch plus the fitting lenses, in one parallel call |

Verify runs once per branch, not per unit, and each run is recorded in the evidence log. A second branch verify on the same source tree is refused, and on a changed tree it asks. Blocker fixes are proven with a repro test that `check` sees fail, then pass. A recheck is allowed only for security or data blockers: at most one, launched with `recheck <ids>` in the reason, on the `brigadev-verify-recheck` profile route when the profile has one. A correction batch fixes the blockers plus at most five defect WARNINGs in the same files; the rest go to Follow-ups.

`gh pr create` asks, in every mode, when a T2 branch has no verify run or the latest verify's blockers have no fail-then-pass test run after it; in NORMAL mode this joins the usual PR confirmation. Without a UI it blocks. If the facts cannot be read (no git, detached HEAD), the gate does not run.
