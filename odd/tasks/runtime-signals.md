# Runtime signals for the orchestrator
Objective: parent-only runtime notices for the context backstop and the exploration budget. Branch: `feat/runtime-signals`. Delivery: ask-on-risk. Tests: `npm test`.

## Specs
- S1: Context backstop: "when the parents measured context first reaches min(150000 tokens, 50% of the models context window), append one notice to the next tool result telling the orchestrator to hand the next multi-step unit to a fresh brigadev-worker. Once per crossing, re-armed after compaction. Never in subagents." Check: unit tests for threshold, single fire per crossing, re-arm after compaction, unknown usage ignored; extension returns early when `isChildSession()`.
- S2: Exploration budget: "count the parents read/grep/find/ls calls per user request; after 5 lookups, append one notice suggesting a brigadev-explore delegation. Reset on each new request. Never in subagents." Check: unit tests for count, notice exactly once at the 5th lookup (assumption: "after 5" = on the result of the 5th call), non-lookup tools ignored, reset on new request; extension returns early for child sessions.
- S3: "update assets/orchestrator.md so triggers 2 and 7 say the runtime signals them." Check: both trigger lines mention the runtime notice.
- Assumption A1: each unit is its own lib file, extension file, test file, registered in `package.json` `pi.extensions`.
- Assumption A2: "measured" context = `ctx.getContextUsage().tokens` (non-null); null/unknown never fires.

## Tasks
- T1 [S1] inline — done (RED: ERR_MODULE_NOT_FOUND; GREEN: npm test 53 pass) (lib/context-backstop.ts, extensions/context-backstop.ts, tests/context-backstop.test.ts)
- T2 [S2] inline — done (RED: ERR_MODULE_NOT_FOUND; GREEN: npm test 57 pass) (lib/exploration-budget.ts, extensions/exploration-budget.ts, tests/exploration-budget.test.ts)
- T3 [S3] inline — done (orchestrator.md triggers 2 and 7 edited; npm test 57 pass, 0 fail) (assets/orchestrator.md, CHANGELOG.md)

## Log
- L1 (2026-11-05): "Add two runtime signals for the orchestrator, each its own unit with lib code, an extension hook, and tests: 1) Context backstop: when the parents measured context first reaches min(150000 tokens, 50% of
 the models context window), append one notice to the next tool result telling the orchestrator to hand the next multi-step unit to a fresh brigadev-worker. Once per crossing, re-armed after compaction. Never in subagents. 2) Exploration budget: count the parents read/grep/find/ls calls per user request; after 5
 lookups, append one notice suggesting a brigadev-explore delegation. Reset on each new request.
 Never in subagents.
   Then update assets/orchestrator.md so triggers 2 and 7 say the runtime signals them."
- L2 (2026-11-05): Exploration. Hooks available: `tool_result` (handler may return `{content}` to replace), `session_compact`, `input` / `before_agent_start`, `ctx.getContextUsage()` -> `{tokens|null, contextWindow, percent}`. Child detection: `isChildSession()` in lib/runtime.ts; extensions early-return as in extensions/orchestrator.ts. Pattern to copy: extensions/todo.ts (`session_compact`), extensions/cost.ts (`tool_result`). Pre-existing uncommitted formatCost change (lib/cost.ts, tests/cost.test.ts) is unrelated; do not include it in these commits.
- Risk forecast: none of the high-risk items (additive, no contracts changed; `package.json` only gains extension entries). Verification inline.
- L3 (2026-11-05): All tasks done, uncommitted: the user declined the work-unit commits. Extension hooks (`tool_result`, `input`, `session_compact`) are not exercised by tests (no Pi runtime here); only lib logic is. Unverified in a live Pi session.
