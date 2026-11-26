---
name: "Bug fix"
description: "Reproduce, fix at the root cause, and prove it with a test"
order: 50
questions:
  - id: where
    label: "Where does it happen?"
    kind: text
    required: true
  - id: environment
    label: "Environment: browser, device, app version, or feature flag"
    kind: text
  - id: steps
    label: "Steps to reproduce"
    kind: long
    required: true
  - id: expected
    label: "What did you expect?"
    kind: text
    required: true
  - id: actual
    label: "What happens instead? Include errors or logs"
    kind: long
    required: true
  - id: ticket
    label: "Ticket or link"
    kind: text
---
Bug fix request, started from the workflow menu. Reproduce the problem first, add a failing regression test when a deterministic one applies, then fix the root cause.

- Where it happens: {{where}}
- Environment: {{environment}}
- Steps to reproduce: {{steps}}
- Expected: {{expected}}
- Actual (errors or logs): {{actual}}
- Ticket or link: {{ticket}}

Follow the diagnosis loop in `diagnosis.md` in the assets root named in the orchestrator prompt. Its `Reproduced:` block (the failing command, its output, the test path) comes before any source edit.

If the problem cannot be reproduced from the details above, end with its `Not reproduced:` block (what was tried) instead of guessing at a fix.
