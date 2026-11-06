---
name: "Refactor a component"
description: "Restructure a component without changing what it does"
order: 80
questions:
  - id: component
    label: "Component path"
    kind: text
    required: true
  - id: goal
    label: "What should the refactor achieve?"
    kind: long
    required: true
  - id: constraints
    label: "Constraints"
    kind: choice
    options: ["Keep the public API", "The public API may change"]
    default: "Keep the public API"
  - id: tests
    label: "Test coverage"
    kind: choice
    options: ["Tests exist", "Add tests first"]
    default: "Tests exist"
---
Refactor request, started from the workflow menu. Follow the normal ODD flow: explore the component and its callers first. Behavior must not change; refactor in small steps with the tests passing after each one.

- Component: {{component}}
- Goal: {{goal}}
- Constraints: {{constraints}}
- Test coverage: {{tests}}

"Add tests first" means write characterization tests that pass on the current code before any restructuring. Commit by work unit, following the `brigadev-work-unit-commits` skill.
