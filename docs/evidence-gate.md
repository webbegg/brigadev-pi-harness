# Evidence and the PR gate

Every check command (tests, lint, typecheck, build) run through `bash` or the `check` tool, by you or by any subagent, is recorded with its command, exit code, time, directory, agent, and output tail in `~/.brigadev/<repo>/evidence/<branch>.jsonl`: an append-only log keyed to the content of the working tree it ran on. Outside git nothing is recorded. The log holds commands and output tails in plaintext (mode 0600), so treat it as sensitive.

Commits are never gated on it: commit as often as you like. The log is checked once, where the change leaves your machine: `gh pr create`.

## The rule

Before `gh pr create`, a branch that commits source since its base needs a passing `test` run recorded for the **committed HEAD**: a run whose working tree was exactly HEAD's tree, or HEAD's tree without doc paths (doc edits after the run are fine). In practice: commit, then run `check` on the clean working tree, then open the PR.

- **The latest suite run decides.** A later failing run of the suite on HEAD's tree revokes an earlier pass; a pass after it counts again.
- **Full suite only.** When the project's test command is known (`check.test` in `brigadev.json`, or detected: a `package.json` test script, pytest, Cargo, Go), only a run of exactly that command counts. A `check` with `focus` or another `command` is recorded but does not vouch for HEAD. With no known test command, any recognized test run counts.
- **Uncommitted edits do not matter.** HEAD is what the PR opens, so a run with uncommitted source edits keys a different tree and does not count, and edits you have not committed do not block the PR.
- **Docs-only branches** need no test run. Docs are `*.md`, `*.markdown`, `*.rst`, `*.adoc`, and `LICENSE`/`NOTICE`/`CHANGELOG`/`COPYING`/`AUTHORS`. `.txt` and `.mdx` count as source. An unknown base branch, or a `git diff` that fails, counts as source changed; deletions and renames of source count as source.
- **It asks instead of passing** when it cannot look: HEAD's tree cannot be computed, the evidence log cannot be read, or the directory of `gh pr create` cannot be resolved.

The same gate also asks for a `brigadev-verify` run on a T2 branch and for a RED→GREEN repro test after verify blockers (see [configuration.md](configuration.md)). In normal mode its reasons ride the PR confirmation, in one dialog; in yolo it asks on its own, only when there is a reason; without a UI it blocks. Only you can open the PR past it, in that dialog. Subagents never reach it: they cannot open PRs.

## The exit-code rule

A run counts only when its exit code is the test's. The test must be the command itself (`npm test`, `CI=1 npx vitest`), alone or in an `&&` chain; naming it as an argument (`echo npm test`) does not count. A `||`, `;`, `&`, `!`, `#` comment, subshell, `$(...)`, backtick, `exit`, `exec`, `eval`, or `source` hands the exit code to something else, so the run is recorded as unknown and does not pass. A `cd` before the test must stay inside the repository.

When a recognized test command is piped (`npm test | tail -20`), the guard runs it with `set -o pipefail;` in front so the exit code is the runner's. A leading `set -o pipefail;` you wrote yourself is also accepted. The `check` tool avoids all of this: it runs the test itself and records a trusted run.

A run is keyed to the tree only if the tree was the same before and after it. An edit made while the tests ran is not vouched for: that run is recorded as unknown with a `note`. A package-manager test run (`npm`, `pnpm`, `yarn`, `bun`) counts only as plain `npm test` (optionally `-s`, arguments after `--`) without `npm_config_*` variables.

Nested repositories: a test run is recorded against the repository of its cwd (`cd nested && npm test` lands in `nested`'s log), and `gh pr create` after a literal `cd <dir> &&` is judged against that repository.

## Limits

It is quality control, not a security boundary. It recognizes `gh pr create` (and gh's alias `gh pr new`) the way the command classifier does, so a PR opened another way (`gh api`, the web UI, a script) is not gated. To keep a model from forging a pass, `write`/`edit` into the evidence folder and bash commands naming it together with a write are blocked; a deliberately obfuscated command is not prevented.

Older logs may hold `type: "force"` records from the removed commit gate (`/brigadev:force-commit`); `brigadev-branch-pr` still discloses them in the PR body.
