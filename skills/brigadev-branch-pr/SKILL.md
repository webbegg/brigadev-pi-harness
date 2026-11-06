---
name: brigadev-branch-pr
description: "Trigger: create PR, open pull request. Prepare branches and PRs from evidence, following the repo's policy."
metadata:
  author: brigadev
  version: "0.1"
---

## When to use

Creating or preparing a pull request, or preparing a branch for submission.

## Target and authorization

- Establish one unambiguous target: `git remote get-url origin` → host and `owner/repo`. Never assume the default branch is `main`; read it from the remote.
- Push and PR creation are separate human decisions. Preparing a candidate locally is not permission to deliver it. The runtime guard asks before `git push` and `gh pr create` in normal mode.
- Read the target's contribution policy first: `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, required labels, and required CI.

## Workflow

1. No issue is required. Link one only when the user mentions it, and ask whether it closes (`Closes #N`) or only references (`Refs #N`) it.
2. Work on a `type/description` branch from the verified default branch (normally already started by the work-unit flow).
3. Implement in work units (`brigadev-work-unit-commits`), test-first where applicable, running the applicable checks.
4. If the change exceeds ~400 changed lines, load `brigadev-chained-pr` before opening anything.
5. **Review before the PR**: run `brigadev-review` on `<default>...HEAD` (only the lenses that fit) and write the ledger to `reviews/<branch with / as ->.md` in the repo docs folder named in the orchestrator prompt. Show the ledger. If it has blockers, ask the user before opening the PR.
6. Draft the PR body from the repository template and observed evidence. Show it to the user.
7. On explicit authorization: push, then open the PR with explicit `--repo` and `--base`.
8. Report required CI status; never call a PR merge-ready on an unverified green claim.

## Branch naming

`^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`, for example `feat/user-login`, `fix/null-session-crash`.

## PR body

Use the repository template when present. Otherwise:

```markdown
## Summary
- <1–3 bullets: what and why>

## Changes
| File | Change |
| --- | --- |

## Test plan
- `<exact command>`: <observed result>

## Risk
none | item N (reason)
```

Add `Closes #N` or `Refs #N` only when the user named an issue. Record only commands you actually ran. Leave unverified checklist items unchecked.

## Commands

```bash
git remote get-url origin
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr create --repo <owner/repo> --base <default-branch> --title "<conventional title>" --body-file <file>
gh pr checks <number> --repo <owner/repo>
```
