---
name: brigadev-review
description: "Trigger: review, code review, 4R. Risk-scoped review of one frozen change with the 4R lenses."
metadata:
  author: brigadev
  version: "0.1"
---

## When to use

The user asks for a review, or `brigadev-branch-pr` is about to open a PR and the user chose a review scope (review the branch once, after the work units are done). Never review per commit during the work loop: a high-risk branch gets one `brigadev-verify` before the PR. Review is proportionate: name only the lenses that fit unless the user asks for a full review.

## Rules

- Review exactly one **frozen candidate**, never a moving working tree.
- Pick only the lenses that fit what changed, and state the reason for each.
- One read-only `review-4r` subagent applies the chosen lenses in a single pass; you own the ledger and every decision.
- A review never replaces functional checks and never authorizes push, PR, or merge.

## Lens selection

| Lens | Pick when the candidate touches |
| --- | --- |
| R1 Risk | auth, permissions, secrets, input handling, dependencies, data exposure |
| R2 Readability | prompt/docs diffs or on request only |
| R3 Reliability | behavior changes, contracts, tests, edge-case-heavy logic |
| R4 Resilience | I/O, network, retries, migrations, long-running or concurrent code |

When the user asks for a full review, name all four.

## Execution

1. **Freeze** the candidate into a patch file outside the repository:

```bash
SCRATCH=$(mktemp -d) && echo "$SCRATCH"             # note the printed path for step 5
git diff <base>...HEAD > "$SCRATCH/candidate.patch"   # committed range
git diff HEAD > "$SCRATCH/candidate.patch"            # uncommitted work
git diff --stat <base>...HEAD
```

2. **Launch** one `review-4r` subagent. The task names the lenses (each with its reason), the patch path, the base, the touched files, and the feature document if one exists. `reason`: "review: <lenses> because <what the candidate touches>".
3. **Ledger**: the reviewer returns schema-checked JSON (`findings`, `reviewed`). A failed run is never clean: relaunch it once, then report the change as not reviewed. Dedupe by location and claim, and keep IDs. Classify:
   - **blocker**: `introduced` or `worsened` BLOCKER/CRITICAL with concrete evidence;
   - **follow-up**: `pre-existing` findings;
   - **advisory**: WARNING and SUGGESTION.
   Discard claims without evidence, and say so.
4. **Correct** (only when the user authorized changes): one batch of blockers plus at most 5 defect WARNINGs in the same files; the other advisories are one line each in Follow-ups and never start a correction. Prove each fix with its repro test observed RED→GREEN, not a re-review; re-review the lens only for a security-parser fix. Blockers still open become one **Needs your decision**.
5. **Save** the final ledger (the Output block) to `reviews/<branch with / as ->.md` in the repo docs folder named in the orchestrator prompt, replacing the branch's earlier ledger, and show it. It lives outside the project; never write it into the repository. Before a PR, blockers still open mean asking the user before the PR is opened.
6. Remove the scratch directory when done with the literal path `mktemp -d` printed (`rm -rf /var/folders/.../tmp.XXXX`), never `$(…)` or a variable: the guard runs a literal temp-dir path without a confirmation.

## Output

```
Candidate: <base>..<head> (<files>, +<add>/-<del>)
Lenses: <lens — reason>
Blockers: <id, location, claim, evidence, in full>
Follow-ups: ...
Advisories: <top 5 advisories, one line each>; SUGGESTION count: <n>
Verdict: clean | blockers fixed | needs your decision
```
