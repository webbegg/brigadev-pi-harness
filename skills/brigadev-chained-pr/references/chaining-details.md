# Chained PR details

## Feature branch chain

```text
<default branch>
 └── feat/my-feature              ← tracker (draft, do not merge until the chain is done)
      └── feat/my-feature-01-core       PR #1 → base feat/my-feature
           └── feat/my-feature-02-api   PR #2 → base feat/my-feature-01-core
```

1. Create the tracker branch from the verified default branch; open a draft tracker PR to the default branch.
2. PR #1 targets the tracker; each later child targets its immediate parent.
3. Merge children in order; merge the tracker last.

## Stacked to the default branch

```text
<default branch> ← PR 1: foundation
                    └── PR 2: built on PR 1
                         └── PR 3: built on PR 2
```

PR #1 targets the default branch; each later PR targets its parent until the parent merges, then rebase or retarget so only the current slice shows.

## Chain Context section

Append to each child PR body (never for a single PR):

```markdown
## Chain Context

| Field | Value |
| --- | --- |
| Chain | <feature name> |
| Position | <N of total> |
| Base | `<target branch>` |
| Depends on | <PR or "None"> |
| Follow-up | <next PR or "None"> |
| Review budget | <changed lines> / 400 |

```text
<default branch>
 └── #NNN Previous PR
      └── 📍 #NNN This PR
           └── #NNN Next PR
```

### Scope
- Includes: <this unit>
- Excludes: <deferred work>
```

## Commands

```bash
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr view <N> --json additions,deletions,changedFiles,baseRefName
gh pr create --repo <owner/repo> --base <parent-branch> --title "<title>" --body-file <file>
gh pr edit <N> --base <new-base>   # retarget after a parent merges
```
