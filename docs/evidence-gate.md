# Evidence gate

Every check command (tests, lint, typecheck, build) run through `bash` or the `check` tool, by you or by any subagent, is recorded with its command, exit code, time, directory, agent, and output tail in `~/.brigadev/<repo>/evidence/<branch>.jsonl`: an append-only log keyed to the content of the working tree it ran on. Outside git nothing is recorded. The log holds commands and output tails in plaintext (mode 0600), so treat it as sensitive.

## The rule

A `git commit` with source changes anywhere in the repository is blocked unless a passing `test` run is recorded for the current working tree. Any source edit after the last passing run changes the tree and blocks the commit until the tests run again; committing without new edits does not. Only the `test` kind counts (`npm test`, `node --test`, `pytest`, `go test`, ...), not lint or build. The gate applies in every permission mode, including yolo, and fails closed: if the working tree cannot be computed (git takes longer than 10 seconds, or fails), the commit is blocked with that reason.

- **Docs-only changes** pass without a test run, and doc edits after a passing run do not invalidate it. Docs are `*.md`, `*.markdown`, `*.rst`, `*.adoc`, files under the top-level `docs/`, and `LICENSE`/`NOTICE`/`CHANGELOG`/`COPYING`/`AUTHORS`. `.txt` and `.mdx` count as source.
- **Nested repositories:** a commit through `git -C <dir>` or `cd <dir> && git commit` (literal path) is checked against that repository, and a test run is recorded against the repository of its cwd. A commit whose directory or branch cannot be resolved (branch switch, `GIT_DIR`, `--git-dir`, `--work-tree`, a `;` or `||` after `cd`, a path with a variable) is blocked.

## The exit-code rule

A run counts only when its exit code is the test's. The test must be the command itself (`npm test`, `CI=1 npx vitest`), alone or in an `&&` chain; naming it as an argument (`echo npm test`) does not count. A `||`, `;`, `&`, `!`, `#` comment, subshell, `$(...)`, backtick, `exit`, `exec`, `eval`, or `source` hands the exit code to something else, so the run is recorded as unknown and does not pass. A `cd` before the test must stay inside the repository.

When a recognized test command is piped (`npm test | tail -20`), the guard runs it with `set -o pipefail;` in front so the exit code is the runner's. A leading `set -o pipefail;` you wrote yourself is also accepted. The `check` tool avoids all of this: it runs the test itself and records a trusted run.

A run is keyed to the tree only if the tree was the same before and after it. An edit made while the tests ran is not vouched for: that run is recorded as unknown with a `note`. A package-manager test run (`npm`, `pnpm`, `yarn`, `bun`) counts only as plain `npm test` (optionally `-s`, arguments after `--`) without `npm_config_*` variables.

## Forcing

Only you can force it. With a UI the guard shows why the commit is blocked and asks whether to commit anyway. Without one, run `/brigadev:force-commit` first: it applies once, only to the working tree as it is now (editing a file cancels it) and is logged in the evidence file. It cannot help while the tree cannot be computed. There is no flag or environment variable that forces the gate, and subagents never reach it.

## Limits

It recognizes commits the way the command classifier does, so aliases, plumbing such as `git commit-tree`, wrappers, and scripts are not gated. To keep a model from forging a pass, `write`/`edit` into the evidence folder and bash commands naming it together with a write are blocked; a deliberately obfuscated command is not prevented.
