---
name: "Work on a ticket"
description: "Work on a pasted ticket: branch, commits, and PR carry the ticket key"
order: 20
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
    options: ["Let the agent decide", "Quick change", "Plan first"]
    default: "Let the agent decide"
---
Ticket request, started from the workflow menu. The ticket below (key, kind, text, and link) is the requirement: quote it verbatim (as L1 in the feature document when one is created) and add nothing it does not ask for. Explore first, then implement.

- Ticket key: {{key}}
- Kind: {{kind}}
- Ticket text: {{text}}
- Design or other link: {{design}}
- Size: {{size}}

Normalize the key first: take the first match of `[A-Za-z][A-Za-z0-9]+-[0-9]+` in the ticket key answer (so a pasted ticket URL or a lowercase key works), uppercase it, and use that as <KEY> everywhere below. If there is no match, ask once for the key and stop.

"Bug" means follow the bug-fix flow: a failing test that reproduces it comes first, whatever the size, then fix the root cause following the diagnosis loop in `diagnosis.md` in the assets root named in the orchestrator prompt. "Story or task" means the normal feature flow.

"Quick change" means work inline, test first, in one work unit and its commit, with no feature document; if it needs more than that, stop and say so instead of growing it. "Plan first" means track it per `odd-tracking.md` with the whole request above (key, kind, ticket text, and link) as L1 verbatim, then show the plan and stop for the user's approval before the first source write. "Let the agent decide" means apply the usual tracking rule: only multi-session work gets a feature document.

Ticket conventions: name the branch `feat/<KEY>-<short-slug>`, or `fix/<KEY>-<short-slug>` for a Bug; end every commit message with a `Refs: <KEY>` footer; end the PR title with `(<KEY>)`. These conventions can be changed by overriding this workflow file.
