---
name: "New feature"
description: "Build something new through the normal ODD flow"
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
  - id: tracking
    label: "How should it be tracked?"
    kind: choice
    options: ["Let the agent decide", "Track it as large", "Keep it small"]
    default: "Let the agent decide"
---
New feature request, started from the workflow menu. Follow the normal ODD flow: explore first, then plan and implement.

- What to build: {{what}}
- Area or files: {{area}}
- Acceptance criteria: {{criteria}}
- Ticket or link: {{ticket}}
- Tracking preference: {{tracking}}

"Track it as large" means treat this as a large ODD task the way `/track` does: feature document and todo before the first source write. "Keep it small" means do not create a feature document. "Let the agent decide" means apply the usual size rules. When a feature document is created, quote the request above verbatim as L1.
