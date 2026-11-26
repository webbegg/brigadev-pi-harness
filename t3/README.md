# brigadev-t3

brigadev in T3 Code. An optional Pi extension that loads next to the brigadev harness. It does nothing outside T3 Code (no `T3CODE_THREAD_ID`) or in a brigadev subagent, and the harness never depends on it.

## What it adds

- **Status chips** in the T3 thread (Pi's `ctx.ui.setStatus`, which T3 shows per thread), next to the ones the harness already sets (permission mode, subagents, cost, PR, profile, background processes):
  - `brigadev ▸ <phase>` while a run is active (the loop phase, inferred from tool activity);
  - `todo 3/7` while the todo list has open items (T3 does not show the harness's todo widget);
  - `check ✓ 1665 passed` or `check ✗ 2 failed`, the last `check` run.
- **A prompt section** (`<brigadev_in_t3_code>`) that settles where brigadev's rules and T3's orchestration rules overlap: brigadev's `subagent` is the native subagent tool and `delegate_task` is for other providers, worktrees, and background children; PRs go through `pull_request_create` / `pull_request_merge`, which the guard and the PR gate cover; CI waits use `watch_pull_request`.

It reads only the public `brigadev:*` bus on `pi.events` ([lib/bus.ts](../lib/bus.ts)), with its own copy of the channel names; `tests/t3-contract.test.ts` in the harness fails when they drift.

## Install

In T3 Code's settings, add this to Pi's launch arguments:

```
-e /absolute/path/to/brigadev-pi-harness/t3
```

Start a new thread. The chips appear on the first brigadev activity.

## What already works without it

- Guard confirmations show as T3 approvals; `ask_user_choice` shows as a T3 question (Pi's select and input dialogs over RPC).
- `/brigadev:start` and the other `/brigadev:*` commands are in T3's slash command menu. Commands that need the terminal UI (`/brigadev:changes`, `/brigadev:runs`, `/brigadev:ps` viewer) do not work in T3.
- Subagent runs render in T3's subagent view.

## Known limits

- T3 shows a notice (`ctx.ui.notify`) only during an active turn; notices sent between turns (a background process that exits, a command's report) are dropped.
- T3's **Accept for session** on an approval auto-accepts later confirmations with the same title and text. For the guard that means the same command: after accepting `git push` for the session, the identical `git push` runs without asking again in that thread.
- MCP calls made from inside a codemode script reach the guard only if Pi reports them as tool calls; this has not been checked against a live T3 session.

## Development

```bash
npm test   # from the repository root: runs the harness's and this add-on's tests
```
