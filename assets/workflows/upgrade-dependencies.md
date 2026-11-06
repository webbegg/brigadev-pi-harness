---
name: "Upgrade dependencies"
description: "Upgrade packages within a version range and verify the result"
order: 90
questions:
  - id: packages
    label: "Which packages? A list, or all outdated ones"
    kind: text
    default: "All outdated packages"
  - id: range
    label: "Allowed version range"
    kind: choice
    options: ["Patch", "Minor", "Major"]
    default: "Minor"
  - id: verify
    label: "How should the upgrade be verified?"
    kind: text
    default: "{{testScript}}"
---
Dependency upgrade request, started from the workflow menu. Follow the normal ODD flow: read the current versions and the changelogs of what will change before touching anything. Dependency commands ask through the guard; run only the ones this request needs.

- Packages: {{packages}}
- Allowed range: {{range}}
- Verification: {{verify}}

Stay inside the allowed range: "Patch" means patch releases only, "Minor" means minor and patch, "Major" allows breaking releases, one package group at a time. Run the verification after each group and stop at the first failure, reporting which package caused it. Commit by work unit, following the `brigadev-work-unit-commits` skill.
