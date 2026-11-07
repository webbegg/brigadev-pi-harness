---
name: "Feature"
description: "Build something new through the normal ODD flow; the agent picks the size"
order: 10
group: "feature"
questions:
  - id: what
    label: "What should be built?"
    kind: long
    required: true
  - id: area
    label: "Area or files involved"
    kind: text
  - id: criteria
    label: "Acceptance criteria"
    kind: long
  - id: ticket
    label: "Ticket or link"
    kind: text
---
Feature request, started from the workflow menu. Follow the normal ODD flow: explore first, then plan and implement. Apply the usual size rules: a small change is done inline without a feature document; a large one is tracked per `odd-tracking.md`.

- What to build: {{what}}
- Area or files: {{area}}
- Acceptance criteria: {{criteria}}
- Ticket or link: {{ticket}}

When a feature document is created, quote the request above verbatim as L1.
