---
name: "Feature"
description: "Build something new; the agent picks the size, or you choose a quick change or plan first"
order: 10
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
  - id: size
    label: "How big is it?"
    kind: choice
    options: ["Let the agent decide", "Quick change", "Plan first"]
    default: "Let the agent decide"
---
Feature request, started from the workflow menu. Explore first, then implement.

- What to build: {{what}}
- Area or files: {{area}}
- Acceptance criteria: {{criteria}}
- Ticket or link: {{ticket}}
- Size: {{size}}

"Quick change" means work inline, test first, in one work unit and its commit, with no feature document; if it needs more than that, stop and say so instead of growing it. "Plan first" means track it per `odd-tracking.md` with this request quoted verbatim as L1, then show the plan and stop for the user's approval before the first source write. "Let the agent decide" means apply the usual size rules.
