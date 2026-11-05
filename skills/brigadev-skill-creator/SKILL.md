---
name: brigadev-skill-creator
description: "Create or update concise LLM-first skills with valid frontmatter. Run with /skill:brigadev-skill-creator."
disable-model-invocation: true
metadata:
  author: brigadev
  version: "0.1"
---

## When to use

Creating or updating a reusable skill: a workflow or convention reused across sessions, project-specific constraints on generic behavior, or a decision tree that helps the agent choose safely. Not for one-off tasks or rules that belong in code or tests.

## Rules

- A skill is a runtime contract for the model, not human docs. Imperative instructions, concrete gates, no tutorials.
- Keep `SKILL.md` short: target 180–450 tokens, at most ~1000.
- `name`: lowercase letters, digits, and single hyphens; at most 64 characters; matches the directory name.
- `description`: one YAML-safe line, quoted, trigger words first, then what it does. At most 1024 characters. This is what routes the model to the skill.
- Use `disable-model-invocation: true` for skills that must run only via `/skill:name`.
- Templates and schemas go in `assets/`; long rationale and edge cases in `references/`, linked by relative path.
- Update an existing skill instead of creating an overlapping one.

## Placement

| Scope | Location |
| --- | --- |
| This harness (shared) | `skills/<name>/` in the brigadev-harness package |
| One project | `.pi/skills/<name>/` or `.agents/skills/<name>/` |
| Personal | `~/.pi/agent/skills/<name>/` |

## Template

```markdown
---
name: <skill-name>
description: "Trigger: <phrases users will say>. <What the skill does>."
metadata:
  author: brigadev
  version: "0.1"
---

## When to use
## Rules
## Execution
## Output
```

## Finish

Run `/reload`, then check the skill appears in Pi's startup diagnostics and loads with `/skill:<name>`. Report the files created or changed.
