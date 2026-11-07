---
name: "Big feature (plan first)"
description: "A large feature: tracked in a feature document, planned and approved before any code"
order: 15
group: "feature"
questions:
  - id: what
    label: "What should be built?"
    kind: long
    required: true
  - id: criteria
    label: "Acceptance criteria"
    kind: long
  - id: ticket
    label: "Ticket or link"
    kind: text
  - id: constraints
    label: "Constraints: deadlines, compatibility, things not to touch"
    kind: long
---
Big feature request, started from the workflow menu. Track it as Large per `odd-tracking.md`: explore first, then create the feature document with this request quoted verbatim as L1, the requirements as specs, and the tasks. Show the plan and stop for the user's approval before the first source write. Once approved, follow the normal ODD flow, resumable from the document. When the forecast or running count exceeds ~400 changed lines, split delivery with `brigadev-chained-pr`.

- What to build: {{what}}
- Acceptance criteria: {{criteria}}
- Ticket or link: {{ticket}}
- Constraints: {{constraints}}
