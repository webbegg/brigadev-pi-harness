---
name: brigadev-branch-pr
description: "Trigger: commit, create PR, split a large change. Work-unit commits, branches, and PRs from evidence."
metadata:
  author: brigadev
  version: "0.1"
---

## When to use

Deciding what goes into each commit, creating or preparing a pull request, or splitting a change over ~400 lines.

## Target and authorization

- Establish one unambiguous target: `git remote get-url origin` → host and `owner/repo`. Never assume the default branch is `main`; read it from the remote.
- Push and PR creation are separate human decisions. Preparing a candidate locally is not permission to deliver it. The runtime guard asks before `git push` and `gh pr create` in normal mode.
- Read the target's contribution policy first: `CONTRIBUTING.md`, `.github/PULL_REQUEST_TEMPLATE.md`, required labels, and required CI.

## Workflow

1. No issue is required. Link one only when the user mentions it, and ask whether it closes (`Closes #N`) or only references (`Refs #N`) it.
2. Work on a `type/description` branch from the verified default branch (normally already started).
3. Implement in work units (see Commits), test-first where applicable, running the applicable checks.
4. If the change exceeds ~400 changed lines, follow Oversized changes before opening anything.
5. **Review before the PR**, once the work units are done: read the branch tier from the last `check` risk line. T0: no review; say so in the PR body's Risk line. T1: ask the scope with one `ask_user_choice`: **Full 4R** (all four lenses), **Fitting lenses** (recommended: the tier's lenses), or **Skip the review** (then say so in the Risk line). T2: ask the same; the recommended pick adds `brigadev-verify` to the tier's lenses in one parallel call, unless the branch already has its verify. Without a UI, ask in your reply and stop. Then run `brigadev-review` on `<default>...HEAD` with the chosen scope and write the ledger to `reviews/<branch with / as ->.md` in the repo docs folder named in the orchestrator prompt. Show the ledger. If it has blockers, ask the user before opening the PR.
6. Draft the PR body from the repository template (or, with none, the evidence-based body below) and observed evidence. Show it to the user.
7. On explicit authorization: push, then open the PR with explicit `--repo` and `--base`.
8. Report required CI status; never call a PR merge-ready on an unverified green claim.

## Branch naming

`^(feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)\/[a-z0-9._-]+$`, for example `feat/user-login`, `fix/null-session-crash`.

## Commits

- One commit = one deliverable behavior, fix, migration, or docs unit, with its tests and docs. Never split by file type (models, then services, then tests). A high-risk unit gets its own commit.
- Commit each finished unit unasked; the guard lets a feature-branch commit run without a dialog.
- Before each commit: one clear purpose; builds and tests pass with only this commit; reverting it reverts nothing unrelated.
- Conventional Commits: `type(scope): description` (`!` for breaking), describing the outcome, not the file list. No `Co-Authored-By` trailers unless asked. Match `git log --oneline -5`.
- In tracked work, record each task's commit in the feature document's `## Tasks`.

## Oversized changes

Above ~400 changed lines (additions + deletions, generated files excluded), slice by work unit; the budget shapes slicing, never the code: never delete comments, docs, or tests, or compress code, to fit. One honest slicing pass; if no cohesive split fits, report the count and why. Wide mechanical refactors slice as expand–contract.

Unless the feature document already records a strategy, ask once with `ask_user_choice`, in this order: **Feature branch chain** (draft tracker PR; children target the tracker or their parent; nothing lands until the chain completes), **Stacked to the default branch** (each slice lands in order), **One single PR** (least recommended). Record the choice as the delivery strategy; it does not authorize push or PR creation. Branch mechanics and the Chain Context block: `references/chaining-details.md`. A polluted diff (another slice's changes) is a base bug: retarget or rebase.

## PR body

Use the repository template when present. Otherwise build the body from the evidence log (next section):

```markdown
## Summary
- <1–3 bullets: what and why>

## Changes
| File | Change |
| --- | --- |

## Blast radius
- Consumers: <who or what uses the changed surfaces: callers, exports, CLI flags, config, other packages>
- Undo: <easy (revert the PR) | hard (data, published artifact, contract others consume) and why>

## Evidence
- Before: `<command>` → <fail, with the symptom from its tail> (the run that reproduced the bug, or the RED run)
- After: `<command>` → <pass> (the last passing run)
- Other checks: `<command>` → <outcome>
- Forced commits: <disclosure, only when the log has any>

## Risk
none | <data|security|contract|concurrency|delivery|untested> (reason)
```

Add `Closes #N` or `Refs #N` only when the user named an issue. Record only commands you actually ran. Leave unverified checklist items unchecked.

### Evidence log

The log is `<repo docs>/evidence/<branch with / as ->.jsonl`, in the repo docs folder named in the orchestrator prompt. Read it with `read` or `grep`; it is JSON lines, and the guard blocks writing it, so never edit it.

- `type:"run"` records: `command`, `kind` (`test` or `check`), `exitCode`, `outcome` (`pass`, `fail`, or `unknown`), `ts`, `tree`, `srcTree` (the tree without doc paths), `root` (the repository the run belongs to; a nested repository's own, not the session's), `agent`, and `tail` (the end of the output).
- `type:"force"` records (older logs only; the commit gate is gone): the user forced a commit past it. State this in the body under Forced commits, with its time; never leave it out.
- Before `gh pr create`, the guard needs a passing full-suite `check` (no `focus`) on the committed HEAD: commit everything, run `check`, then open the PR.
- Before: the earliest `fail` run for the bug or the RED test, quoting its `command` and what `tail` shows. Without one (no bug, or nothing was recorded), write `none recorded` instead of inventing it.
- After: the latest `pass` run, quoting `command` and `outcome`. Prefer a `test` run whose `tree` is the final one. A run is also valid for the final tree when its `srcTree` equals the final tree's source tree (only docs changed after it); if a source edit came after it, say so.
- Quote commands as the model ran them, without the `set -o pipefail; ` the harness puts in front of a piped test run (it is not part of the command), and outcomes as logged. Treat `unknown` as not verified. Never claim a check that is not in the log; a check you ran outside the log may be listed as run without a log record.
- Secrets: the log stores commands and output tails in plaintext. Before showing the draft, check every command and output tail quoted from it for secrets, tokens, and credentials, and replace them with `<REDACTED>`.
- No log file: say the PR has no recorded evidence, and list only what you observed yourself.

### Blast radius

Name who or what consumes each changed surface (use `grep` for callers, exports, flags, and config keys), and how hard the change is to undo: a plain revert is easy; data, format, published, or contract changes that others already consume are hard. Keep it to what you found; if you did not look, say so.

## Commands

```bash
git remote get-url origin
gh repo view --json defaultBranchRef -q .defaultBranchRef.name
gh pr create --repo <owner/repo> --base <default-branch> --title "<conventional title>" --body-file <file>
gh pr checks <number> --repo <owner/repo>
```
