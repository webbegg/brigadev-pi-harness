---
name: "Work on a ticket"
description: "Work on a pasted ticket: branch, commits, and PR carry the ticket key"
order: 20
key: "j"
group: "main"
questions:
  - id: key
    label: "Ticket key, e.g. PROJ-123"
    kind: text
    required: true
  - id: kind
    label: "What kind of ticket is it?"
    kind: choice
    options: ["Story or task", "Bug"]
    default: "Story or task"
  - id: text
    label: "Paste the ticket: title, description, acceptance criteria"
    kind: long
    required: true
  - id: design
    label: "Design or other link"
    kind: text
  - id: size
    label: "How big is it?"
    kind: choice
    options: ["Let the agent decide", "Quick change", "Big feature (plan first)"]
    default: "Let the agent decide"
---
Ticket request, started from the workflow menu. The ticket text below is the requirement: quote it verbatim (in the feature document as L1 when one is created) and add nothing it does not ask for. Follow the normal ODD flow: explore first, then plan and implement.

- Ticket key: {{key}}
- Kind: {{kind}}
- Ticket text: {{text}}
- Design or other link: {{design}}
- Size: {{size}}

"Bug" means follow the bug-fix flow: reproduce the problem first and write a failing test first when a deterministic one applies, then fix the root cause. "Story or task" means the normal feature flow.

"Quick change" means a Small task: work inline, test first, one commit, never a feature document. "Big feature (plan first)" means Large per `odd-tracking.md`: feature document with the ticket text quoted verbatim as L1 and tasks, then show the plan and stop for the user's approval before the first source write; split delivery with `brigadev-chained-pr` when it exceeds ~400 lines. "Let the agent decide" means apply the usual size rules.

Ticket conventions: name the branch `feat/{{key}}-<short-slug>`, or `fix/{{key}}-<short-slug>` for a Bug; end every commit message with a `Refs: {{key}}` footer; end the PR title with `({{key}})`. These conventions can be changed by overriding this workflow file. Pushing and opening the PR still go through the guard.
