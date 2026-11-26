---
name: "Docs change"
description: "Change documentation only: no tests to write, a glance review"
order: 60
questions:
  - id: what
    label: "What should change in the docs?"
    kind: long
    required: true
  - id: files
    label: "Files or pages"
    kind: text
  - id: ticket
    label: "Ticket or link"
    kind: text
---
Docs change request, started from the workflow menu. Change documentation only: prose files such as `.md`, `.rst`, and `.adoc`, and comments that describe the code.

- What to change: {{what}}
- Files or pages: {{files}}
- Ticket or link: {{ticket}}

Read the code the docs describe before writing, and state only what it does today. Work on a `docs/<short-slug>` branch with one commit per docs unit, following `brigadev-branch-pr`. This lane has no test-first and no `brigadev-verify`: a docs-only branch is tier T0, and the PR body says `Review depth: glance (T0)`. If the change needs a source change (code, config, tests, or an example that must run), stop and say so instead of making it; that is a feature or bug, not a docs change.
