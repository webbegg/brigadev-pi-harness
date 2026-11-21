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
| `/brigadev:web [start\|open\|stop\|status]` | Local web UI for this session: a board of the loop (subagents, checks, commits, your decisions, prompts waiting on you), detail panels, and a composer (send, steer, abort). `open` prints a new one-time link |
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

## Web UI

`/brigadev:web` starts a server for the current parent session on `127.0.0.1` (ephemeral port, or `BRIGADEV_WEB_PORT`). It prints a one-time link; the session data (`/events`) and every action need the session secret the page gets from it. The page is one static file with no dependencies. It follows the session over SSE and replays what happened before it was opened.

How the link works:

- The link carries a single-use `code` (32 random bytes) that is valid for 60 seconds. The page reads it, removes it from the address bar at once, and trades it for a session secret with one `POST /session`. The code authorizes nothing else, and a second use of it is refused.
- The secret is random, lives in the server's memory and in one JavaScript variable of the page, and travels in an `Authorization: Bearer` header (the page reads the event stream with `fetch`). It is never in the URL, browser storage, a cookie, or the browser's history, and a token in a query string is refused. Each tab has its own secret; `/brigadev:web stop` revokes them all.
- A reload, a second tab, or a used or expired link has no code, so the page says: "This link was already used or expired. In pi, run /brigadev:web open for a new one." `/brigadev:web open` prints a new link for the running server (starting again does the same), and `status` shows the address without a code. If that message appears on a link you just opened, something else used the code first.
- What this does not stop: a process of your own user that reads the code before the page uses it, or that reads the page's memory. The code is live from the moment pi prints it until the page loads, so that is seconds, not milliseconds (for example, something scraping your terminal or clipboard). If another process wins, the page shows the message above; run `/brigadev:web stop` and start again. A session secret lasts until `stop`, even after its tab closes.
- An answer to a prompt that already closed (answered in the terminal, or its run aborted) is refused, and the page says so.

The page is a board with one column per loop step: Explore, Decide, Implement, Check, Commit, and a red **Needs you** column.

- Every subagent run, check, commit, choice you made, and batch of the main agent's own tool calls is a card in the step where it happened.
- Cards show status, verdict, model, tokens, cost, and elapsed time; a running card pulses and can be cancelled.
- Guard confirmations and `ask_user_choice` questions wait in **Needs you** and can be answered there.
- Clicking a card opens a side panel: a subagent's output, recent tool calls, and full task; a check's counts; the conversation. The message box stays usable while the panel is open.

The extensions publish their state as snapshots on the brigadev bus, which is typed `brigadev:*` channels on `pi.events` ([lib/bus.ts](lib/bus.ts)):

- the loop phase, inferred from tool activity and labeled as inferred;
- todos and check results;
- subagent tasks;
- open and settled prompts;
- guard decisions and the permission mode.

Guard confirmations and `ask_user_choice` can be answered in the terminal or the browser. The first answer wins and the other dialog closes.

The same channels feed [pi-agent-dashboard](https://github.com/BlackBeltTechnology/pi-agent-dashboard) when it is installed. They are declared for its event forwarding, along with a loop breadcrumb and footer segments. Its own prompt bus shows guard dialogs.

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
- The web UI covers one session per server, and its loop phase is a guess from tool activity. Approving a guard prompt from the browser has the same effect as approving it in the terminal, so open the link only in a browser you trust. Credentials in commands (URLs with a password, `Authorization` headers, token-like strings, password flags) are masked before they reach the page or the bus; this is a best-effort filter.
- `pi-claude-bridge` runs your Claude Code hooks inside Pi turns: see [docs/claude-bridge.md](docs/claude-bridge.md).

## License

MIT © 2026 Marcos Juan (see `LICENSE`). brigadev-harness builds on ideas and adapted material from [gentle-shell](https://github.com/Gentleman-Programming/gentle-shell) and Pi's subagent example; credits and their license notices are in `NOTICE.md`.
