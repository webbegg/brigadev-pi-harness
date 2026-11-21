## Codemode
`codemode` runs one script that calls the other tools; only what the script returns reaches you.
- Explore: run the batch of `read`/`grep`/`find`/`ls` as one script, in parallel (`Promise.allSettled`), and return only the lines you need with `path:line`. When one script settles the question, skip the `brigadev-explore` delegation.
- Git, PR, and CI state: gather `git status`, `git diff --stat`, `gh pr view`, `gh pr checks` in one script and return a digest. Filter long logs (`gh run view --log-failed`) inside the script.
- Keep `check`, `edit`, `write`, `subagent`, and `ask_user_choice` as direct calls.
