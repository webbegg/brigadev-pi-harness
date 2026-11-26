# Safety guard

`extensions/guard.ts` classifies every `bash` and `bg_start` command and every `write`/`edit` of the parent session and its subagents. It recognizes executable forms; it is not a sandbox.

## Permission modes

`/brigadev:mode normal|yolo` sets the mode for this session; `/brigadev:mode default <mode>` stores `defaultMode` in `~/.pi/agent/brigadev.json`; `/brigadev:mode status` shows both. A stored mode that is neither is ignored and the session starts in NORMAL. The mode reaches the model as a context message, so the system prompt is identical in every mode.

| Command kind | normal | yolo | subagent |
| --- | --- | --- | --- |
| ordinary (`npm test`, `git status`) | run | run | run |
| `git push`, `gh pr create` (and `gh pr new`): always your approval | ask | ask | block |
| other delivery (`gh issue create`, `gh pr comment`) | ask | run | block |
| `git commit` on a feature branch | run | run | block |
| `git commit` on the default branch, on a detached HEAD, or when the default branch is unknown | ask | run | block |
| destructive (`rm -rf dir`, `git reset --hard`, `git push --force`, `DROP TABLE`; ref rewrites such as `git update-ref`) | ask | ask | block |
| publish (`npm publish`, `gh pr merge`, `gh release`) | ask | ask | block |
| privileged (`sudo`, `curl … \| sh`) | ask | ask | block |
| dependency (`npm install`, `pip install`) | ask | ask | block |
| catastrophic (`rm -rf ~`, `rm -rf /`, `mkfs`, `dd of=/dev/…`) | block | block | block |

`rm -r`/`rm -f` of temp paths is ordinary, not destructive: literal paths strictly inside `/tmp`, `/private/tmp`, or `os.tmpdir()` (also after symlinks resolve), `$TMPDIR/<path>` when the guard's `TMPDIR` is set and every mention of `TMPDIR` in the command is such a read, and a quoted `"$d"` when the command's first statement is `d=$(mktemp …) &&` (or `;`, or a newline) with a default `mktemp` (`-d`, `-q`, `-t <prefix>`; no template or `-p` folder) and every other mention of `d` is a quoted read (`"$d"`, `"$d/…"`). The variable rules are off in a command that uses `eval`, `source`/`.`, functions, aliases, `printf`, `read`, `mapfile`, `select`, `declare`/`local`/`unset`, `set`, `IFS`, or `PATH=`, and for inherited or shell variables (`PWD`, `HOME`, …). A temp root itself, globs, `..`, `$d/<path>`, and anything mixed with other targets still ask.

MCP tools that stand for these commands follow the same rows, matched by tool name (`mcp__<server>__<tool>`): `pull_request_create` and `create_pull_request` (T3 Code, GitHub) are a PR creation and run the PR gate on the session's directory; `pull_request_merge` and `merge_pull_request` are a publish; `push_files`, `create_or_update_file`, and `delete_file` are a push; PR and issue writes (`pull_request_review`, `pull_request_respond`, `pull_request_update`, `add_issue_comment`, `create_issue`, …) are other delivery. Other MCP tools are not classified. Subagents never inherit environment variables named for an MCP server (`T3_MCP_URL`, `T3_MCP_BEARER_TOKEN`, `GITHUB_MCP_TOKEN`), so they cannot call those servers from bash. The parent's own `bash` still can: the guard does not recognize a `curl` to an MCP endpoint.

A commit runs without asking only when it targets the session's repository on a branch other than the default branch (the one `origin/HEAD` points to, else a lone local `main` or `master`). It still asks after a `cd`, a branch switch, or `git -C`/`--git-dir`/`--work-tree` earlier in the same command, and a chained `git push` keeps its own prompt. If git cannot answer, it asks. Without a UI (print mode), "ask" means block.

## Files and paths

- `read`, `grep`, `find`, and `ls` check their `path` against the sensitive-path rules (secret files ask or block).
- `write`/`edit` outside the project ask, except the repo docs folder, the system temp dir (`/tmp`, `/private/tmp`, `$TMPDIR`), and your secure-yolo folders. `/brigadev:yolo-dir list|add <folder>|remove <folder>` manages them (`secureYoloDirs`). Refused as secure-yolo folders: the root, your home folder or a folder holding it, and folders that are, hold, or sit in `~/.pi/agent`, `~/.brigadev`, the brigadev install root, or a credential folder (`~/.ssh`, `~/.aws`, `~/.docker`, `~/.gnupg`, `~/.kube`, `~/.config/gh|git|fish`). A temp root that is your home folder or holds it is not trusted.
- Protected paths (`.git/config`, `.git/hooks/`, shell startup files, `~/.pi/`, git and gh config) ask in every mode, even inside a trusted folder.
- Subagents are blocked outside the project and, for writers, outside their allowed edit surfaces.

## Edit surfaces

`write` and `edit` are blocked outside a writer's `allowedEditSurfaces`. For `bash`, the guard blocks calls that write a literal project path outside the surfaces (`>`, `>>`, `&>`, `tee`, `sed -i`, `cp`/`mv`/`install`/`ln` destinations, `touch`, `mkdir`, `truncate`). That is best effort: variables, globs, substitutions, and scripts run by an interpreter are not parsed. In a git repository the guard also compares the working tree before and after each writer `bash` call and flags files changed outside the surfaces after the fact; it reports them and never reverts anything. Ignored files and repositories without git are not covered.
