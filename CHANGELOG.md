# Changelog

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
