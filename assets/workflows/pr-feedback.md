---
name: "My PRs: feedback"
description: "Work through the review comments on one of your pull requests"
order: 40
key: "f"
group: "main"
questions:
  - id: pr
    label: "PR number or URL (empty: pick from your open PRs)"
    kind: text
  - id: which
    label: "Which comments?"
    kind: choice
    options: ["Unresolved comments only", "All comments"]
    default: "Unresolved comments only"
  - id: mode
    label: "What should happen with them?"
    kind: choice
    options: ["Apply changes and reply", "Draft replies only"]
    default: "Apply changes and reply"
---
PR feedback request, started from the workflow menu. Read the comments on the pull request, then handle them one by one. Write every reply with the `brigadev-comment-writer` skill: short, warm, direct.

- Pull request: {{pr}}
- Comments to handle: {{which}}
- Mode: {{mode}}

When no pull request is given, run `gh pr list --author @me --state open` (add `--json number,title,url,reviewDecision` to see each review decision), show the list, and ask the user to pick one with the ask tool.

"Apply changes and reply" means make the requested changes as work units with their tests, then reply to each comment. "Draft replies only" means change no code and post nothing: show the drafted replies for approval. Replies are drafts until the user approves them; posting replies or pushing goes through the guard.
