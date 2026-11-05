# brigadev — Delegation and verification (lazy-loaded)

Parent session only. Load when a writer is about to launch, a writer returns, or the Verification rule fires.

## Agents

| Agent | Role | Tools | Admission |
| --- | --- | --- | --- |
| `brigadev-explore` | Read-only mapping, ≤ ~2k token handoff | read, grep, find, ls | evidence budget |
| `brigadev-worker` | Bounded writer, no commits | read, grep, find, ls, edit, write, bash | allowed edit surfaces |
| `brigadev-verify` | Independent spec-derived verification | read, grep, find, ls, bash | `Risk: item N` in reason |
| `review-*` | 4R lenses (via `brigadev-review`) | read, grep, find, ls | review request |
| `jd-*` | Judgment Day (via `brigadev-judgment-day`) | see skill | explicit request |

Run `/brigadev:agents` to see the effective list, including user (`~/.pi/agent/agents`) and trusted project (`.pi/agents`) overrides.

## Writer launch

- A unit is one independent behavior with its code, tests, and docs. Never split one behavior into test, docs, and code writers. A unit that depends on another still in progress is not independent.
- Units of ~100 changed lines or less run inline; starting a worker costs more than writing them.
- Launch all independent units in ONE parallel `subagent` call. If they cannot launch together, work inline.
- Each writer prompt names the existing helpers it must reuse for shared state (records, lists, settings other commands also touch) and the invariants they keep. Parallel writers cannot see each other; this is the only place they learn them.
- Pass the test-first policy and the exact test commands under a `Verification` heading in the task.

## Allowed edit surfaces

Derive them yourself; never ask the human to author paths. List the files the unit must touch plus directories where it may create files, as narrow repository-relative paths or globs. Never `.`, the repository root, absolute paths, or `..`. A surface wider than the task is a defect. The runtime blocks edits outside them and rejects overlapping parallel writers.

If a writer returns `interaction_required` for a path, present its derived candidate paths to the user as an approve/decline choice.

## After a writer returns

1. Read its report: covered `S#`, commands run with observed results, open items.
2. Spot-check: re-run one reported command yourself.
3. After parallel units finish, run one inline full-suite command to catch seams between units.
4. Decide the Risk line from the actual diff, not the writer's summary.

## Verification rule

| Risk | Verification |
| --- | --- |
| none | writer or parent self-verification plus the parent spot check |
| named high-risk item | self-verification, then one `brigadev-verify` with `reason: "Risk: item N (why)"` |

Verifier handoff: the feature document (`featureDoc`), the unit and linked `S#`, the baseline commit, and the exact test/CLI/typecheck command forms it may run. It probes in a `mktemp -d` scratch copy, never the workspace.

Corrections are bounded: one correction batch that fixes every reported blocker, then one recheck limited to those blockers. A second correction only when the recheck shows the same blocker still failing; never for a new finding. Anything still open becomes one **Needs your decision**. Advisories never start a correction.

If verifier setup fails once, stop with **Needs your decision** naming the missing prerequisite and the unrun checks. Do not loop on repairing helpers.
