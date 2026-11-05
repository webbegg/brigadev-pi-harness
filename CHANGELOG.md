# Changelog

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
