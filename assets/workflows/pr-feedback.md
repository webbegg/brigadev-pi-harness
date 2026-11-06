---
name: "Answer PR feedback"
description: "Work through review comments on a pull request"
order: 50
key: "f"
group: "ship"
questions:
  - id: pr
    label: "PR number or URL"
    kind: text
    required: true
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

"Apply changes and reply" means make the requested changes as work units with their tests, then reply to each comment. "Draft replies only" means change no code and post nothing: show the drafted replies for approval. Posting replies or pushing goes through the guard.
