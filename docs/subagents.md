# Subagents and model routing

## The `subagent` tool

`extensions/subagents.ts` runs each agent in its own `pi --mode json --no-session --no-skills` process, synchronously. At most 4 run at once; `tasks[]` takes up to 8 independent units in one call. Fields: `agent`, `task`, `reason` (required), `allowedEditSurfaces` (writers), `featureDoc` (read until `## Log`), `skills` (passed by exact path).

- `brigadev-explore`: read-only exploration, used when one batch of `read`/`grep`/`find`/`ls` does not settle it.
- `brigadev-worker`: bounded writer. It needs narrow repo-relative `allowedEditSurfaces`; parallel writers must be disjoint; it never commits.
- `brigadev-verify`: independent read-only verifier for high-risk changes (`admission: risk`, so the launch must say `Risk: <category>`). It works from the feature document's specs or, without one, from the task's own numbered acceptance criteria.
- `review-4r`: one pass over a frozen diff with the four lenses (Risk, Readability, Reliability, Resilience), CRITICAL/WARNING findings by default. Used through the `brigadev-review` skill.

Children never wait on a person: the guard denies what would need confirmation, and every dialog a child extension opens is answered as cancelled. A child returns a compact result to the parent (verdicts, blockers, paths); the full result is saved in `~/.brigadev/<repo>/runs/<runId>/` (`task.md`, `transcript.json`, `result.json`, user-only permissions). Run folders older than 14 days are pruned at session start, then the oldest beyond 200. Agents that declare an `output` schema return through a `structured_output` tool; the parent validates it and a run without a valid result fails after one reminder.

A stall watchdog stops a child that produces no events for 4 minutes (30 minutes while a tool call runs); set `BRIGADEV_STALL_TIMEOUT_MS` and `BRIGADEV_TOOL_STALL_TIMEOUT_MS` to change them. A launch is stopped with one process-group kill.

While agents run, a card above the editor shows model, thinking, tokens, cost, and elapsed time (`ctrl+shift+a` collapses it). `alt+a` or `/brigadev:runs` opens the read-only viewer with every run and its thread.

## Agent overrides

Override any package agent by name in `~/.pi/agent/agents/<name>.md` or, for trusted projects, `.pi/agents/<name>.md`; `/brigadev:agents` lists the effective set. Frontmatter: `name`, `description`, `tools`, `model`, `thinking`, `writer: true`, `admission: risk`, `output: <file>.schema.json` (a JSON Schema next to the agent file).

## Model routing profiles

A profile maps the orchestrator and each agent to a model and thinking level. Keys are agent names, prefix globs (`review-*`), `*` for every other agent, and `orchestrator`. An example is in `assets/profiles.example.json`.

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

Precedence for each subagent launch, per field: session profile, default profile, agent frontmatter, then the session's model. Thinking is inherited from the session only together with its model. A route to an unknown model rejects the launch with the fix. Bare model ids resolve against the session's provider first. Profiles are stored in `~/.pi/agent/brigadev-profiles.json`; they have no per-repository pin, and a session without its own profile follows the default as it changes.

## Cost

`pi-claude-bridge` runs Claude Code on your subscription and records every turn at $0. brigadev prices those turns, subagents included, at the Anthropic list price of the same model, so Pi's footer and `/brigadev:cost` show what the tokens would cost on the API. It is a comparison number, not your subscription bill; `{"bridgePricing": false}` turns it off.
