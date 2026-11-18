# brigadev — Tracking (lazy-loaded)

Parent session only. Load for multi-session work, work waiting on something external, or work delivered in separate PRs, or when the user asks to track it. Everything else is resumable from the request and `git diff`, and gets no artifacts.

## Feature document

Create `tasks/<feature-name>.md` in the repo docs folder (never inside the project) right after exploration, without asking. Use a descriptive, filename-safe name; reuse it on resume; never overwrite another feature's document. Subagents read it by reference, so keep this order (stable first, growing log last):

1. **Header** (2–3 lines): objective, branch, delivery strategy, test runner.
2. `## Specs`: numbered `S1..Sn` requirements, constraints, and acceptance criteria with their checks. Quote the user's exact strings, error messages, commands, and examples verbatim, in the user's language. Never add requirements the user did not ask for; mark assumptions as assumptions.
3. `## Tasks`: one line per task: stable ID, linked `S#`, route (inline or delegated + reason), status, commit or RED/GREEN evidence.
4. `## Log`: `L1` is the user's original request verbatim; later corrections verbatim with their date; then analysis, rationale, verification evidence, next step. Brief.

```markdown
# <Feature title>
Objective: <one line>. Branch: `<branch>`. Delivery: <strategy>. Tests: `<runner command>`.

## Specs
- S1: <requirement, quoting the user verbatim>. Check: <how it is verified>.

## Tasks
- T1 [S1] inline — pending

## Log
- L1 (<date>): "<original request, verbatim>"
```

- Update with targeted edits, never a whole-file rewrite. A requirement change appends its verbatim `## Log` entry, rewrites only the affected `S#`, and reopens only its linked tasks.
- Check off only observed outcomes with proof; record failed, skipped, or pending checks honestly. Obsolete tasks become `dropped` with the reason in `## Log`; tasks waiting on something outside the list become `blocked`, naming what unblocks them.
- `todo` is an optional visible view of `## Tasks` with the same IDs; the document is the only authority.

## Resume

Read the feature document. Reconcile requirements, code, and proof, then continue the next unfinished task. Reproduce a reported failure by running it; reading code is not reproduction.

## Close gate

Before the final answer, continue any pending task or quote the user sentence that orders the stop. One **Needs your decision** result naming the open blockers is also a valid stop.

## Delivery

Commit, PR, and slicing rules live in `brigadev-branch-pr`. When it has you choose a slicing strategy, record the choice in the header and the slice boundaries in `## Tasks`.
