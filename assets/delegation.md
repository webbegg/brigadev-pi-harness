# brigadev — Delegation (lazy-loaded)

Parent session only. Load before launching a writer or verifier, or when one returns. Subagents run synchronously: the call returns their result.

| Agent | Role | Tools | Admission `reason` |
| --- | --- | --- | --- |
| `brigadev-explore` | Read-only mapping, ≤ ~2k token handoff with `path:line` | read, grep, find, ls | exploration |
| `brigadev-worker` | Bounded writer, no commits | read, grep, find, ls, edit, write, bash | parallel writers or context handoff, with `allowedEditSurfaces` |
| `brigadev-verify` | Independent spec-derived verification | read, grep, find, ls, bash | `Risk: <category> (why)` |
| `review-4r` | One-pass 4R review (via `brigadev-review`) | read, grep, find, ls | review request |

`/brigadev:agents` shows the effective list, including user and trusted project overrides.

## Writers

- A unit is one independent behavior with its code, tests, and docs; never split it by file type. A unit that depends on one still in progress is not independent. Units of ~100 changed lines or less run inline.
- Launch every independent unit in ONE parallel `subagent` call, or work inline. Never edit a running writer's surfaces.
- Each task names the helpers the writer must reuse for shared state and the invariants they keep (parallel writers cannot see each other), and the exact test commands under a `Verification` heading.
- Pass `featureDoc` (absolute path in the repo docs folder) when one exists. Otherwise put the requirements verbatim in the task, numbered `A1..An`. Writers read it; only you update it.
- `allowedEditSurfaces`: derive them yourself, never ask the human for paths. Narrow repository-relative paths or globs for the files to touch and directories where files may be created; never `.`, the root, absolute paths, or `..`. A surface wider than the task is a defect. The runtime blocks edits outside them and rejects overlapping parallel writers. On `interaction_required` for a path, offer its candidate paths as one approve/decline choice.

After a writer returns: read its report (covered `S#`/`A#`, commands with observed results, open items); re-run one reported command yourself; after parallel units, run one full-suite command to catch seams; set the Risk line from the actual diff, not the summary.

## Verification

Risk `none`: your checks and the spot check suffice. A named risk category: verify once per branch, before the PR (not per unit), with `reason: "Risk: <category> (why)"` and the task's `S#`. Work in a worktree: pass `cwd: ".worktrees/<name>"`, so the verify judges and reviews that branch, not the main checkout (read-only agents only).

Handoff: `featureDoc` and the linked `S#`, or the task's numbered acceptance criteria `A1..An` when there is no feature document; the baseline commit; the exact test, CLI, and typecheck commands it may run. It probes in a `mktemp -d` scratch copy, never the workspace, and returns a compact result (verdicts, blockers, paths); its full result is in the run folder.

Corrections are bounded: one batch of blockers plus at most 5 defect WARNINGs in the same files; the rest is one line each in **Follow-ups**. Prove each fix with its repro test, observed RED→GREEN via `check`. A recheck only for security/data blockers, at most one, with `recheck <ids>` in the reason (enforced); otherwise no new `brigadev-verify`. Leftovers become one **Needs your decision**; advisories never start a correction. If verifier setup fails once, stop with **Needs your decision** naming the missing prerequisite and the unrun checks.
