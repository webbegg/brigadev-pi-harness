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

1. Confirm the linked issue if the repository requires one, and ask whether the reference closes it (`Closes #N`) or not (`Refs #N`).
2. Create a `type/description` branch from the verified default branch when asked.
3. Implement in work units (`brigadev-work-unit-commits`), test-first where applicable, running the applicable checks.
4. If the change exceeds ~400 changed lines, load `brigadev-chained-pr` before opening anything.
5. Draft the PR body from the repository template and observed evidence. Show it to the user.
6. On explicit authorization: push, then open the PR with explicit `--repo` and `--base`.
7. Report required CI status; never call a PR merge-ready on an unverified green claim.

## Branch naming

`^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`, for example `feat/user-login`, `fix/null-session-crash`.

## PR body

Use the repository template when present. Otherwise:

```markdown
## Summary
- <1–3 bullets: what and why>

## Linked issue
Closes #N | Refs #N | none

## Changes
| File | Change |
| --- | --- |

## Test plan
- `<exact command>`: <observed result>

## Risk
none | item N (reason)
```

Record only commands you actually ran. Leave unverified checklist items unchecked.

## Commands

```bash
git remote get-url origin
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr create --repo <owner/repo> --base <default-branch> --title "<conventional title>" --body-file <file>
gh pr checks <number> --repo <owner/repo>
```
