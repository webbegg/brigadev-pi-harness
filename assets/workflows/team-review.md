---
name: "Review a team PR"
description: "Review a teammate's PR read-only and draft the review comments"
order: 30
key: "r"
group: "main"
questions:
  - id: pr
    label: "PR number or URL (empty: pick from the PRs waiting for your review)"
    kind: text
  - id: focus
    label: "Which lens matters most?"
    kind: choice
    options: ["All fitting lenses", "Risk", "Reliability", "Readability", "Resilience"]
    default: "All fitting lenses"
  - id: notes
    label: "Anything to pay attention to?"
    kind: long
---
Team PR review request, started from the workflow menu. Use the `brigadev-review` skill: review one frozen change with the 4R lenses that fit its risk, and save the ledger to the `reviews/` folder of the repo docs folder.

- Pull request: {{pr}}
- Focus: {{focus}}
- Pay attention to: {{notes}}

When no pull request is given, run `gh pr list --search "review-requested:@me" --state open`, show the list, and ask the user to pick one with the ask tool.

Review read-only: read the PR with `gh pr view` and `gh pr diff`, or check it out in a separate worktree; never change the author's branch and never change the code. "All fitting lenses" means let the risk of the change pick the lenses; any other focus names the lens to weigh first.

Then draft the review comments with the `brigadev-comment-writer` skill, each tied to a `path:line`, and show them. Post nothing unless the user asks; posting goes through the guard.
