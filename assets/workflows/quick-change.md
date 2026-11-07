---
name: "Quick change"
description: "A small change, done inline: test first, one commit, no plan"
order: 5
group: "feature"
questions:
  - id: what
    label: "What should change?"
    kind: long
    required: true
  - id: area
    label: "Area or files involved"
    kind: text
---
Quick change request, started from the workflow menu. This is a Small task: work inline, test first when a deterministic test applies, in one commit, and never create a feature document or a plan.

- What to change: {{what}}
- Area or files: {{area}}

If the change turns out to need more than that (several work units, a contract change, or more than a few files), stop and say so instead of growing it.
