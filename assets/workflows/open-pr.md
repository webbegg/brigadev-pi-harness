---
name: "Open a PR"
description: "Review the branch, then prepare and open its pull request"
order: 60
key: "p"
group: "other"
questions:
  - id: base
    label: "Base branch"
    kind: text
    default: "{{defaultBranch}}"
  - id: ticket
    label: "Ticket or link"
    kind: text
  - id: notes
    label: "Notes for reviewers"
    kind: long
---
Open-a-PR request, started from the workflow menu. Use the `brigadev-branch-pr` skill. Before the PR, ask the review scope with `ask_user_choice` (its step 5: full 4R, fitting lenses, or skip); a `brigadev-review` of the branch saves its ledger to the `reviews/` folder of the repo docs folder. Open the PR only after the review's findings are handled or reported, or the user skipped the review; pushing and opening it still go through the guard.

- Base branch: {{base}}
- Ticket or link: {{ticket}}
- Notes for reviewers: {{notes}}

When no base branch is given, use the repository's default branch. Follow the repository's PR template; add an issue link only if one is given above.
