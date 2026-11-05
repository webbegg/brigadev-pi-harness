# Changes viewer editor launch and command palette
Objective: two independent units: `o` opens the selected file in the editor from the Changes viewer; `alt+k` / `/brigadev:commands` command palette. Branch: `try/dogfood2`. Delivery: ask-on-risk, no commits. Tests: `npm test` (`node --test tests/*.test.ts`).

## Specs
- S1: Changes viewer: "`o` opens the selected file in $VISUAL or $EDITOR". Check: pure lib helper test (env precedence VISUAL over EDITOR, none set).
- S2: "passing the path as a literal argument (never through a shell)". Check: lib test that argv keeps the path as one element (spaces, `;`, `$()`), and spawn uses `shell: false`.
- S3: "restoring the TUI afterwards". Check: extension wiring suspends and restores the TUI around the editor, including on failure (verified by reading; pi TUI API unverified, node_modules absent).
- S4: "reporting a launch failure as a warning". Check: failure path calls `ctx.ui.notify(..., "warning")`; lib result type test.
- S5: Command palette: "`alt+k` and `/brigadev:commands` open a searchable list of every registered brigadev command with its description". Check: pure lib test for filtering/search and entries; extension registers shortcut and command.
- S6: "Enter runs the selected one". Check: lib selection test; wiring reads by reading.
- Constraints (from exploration): `isChildSession` guard on registration; non-TUI guard like `changes-view.ts:69`; `o` must not collide with bound keys; `alt+k` must not collide with `alt+g`/`alt+a`; skip deleted entries (status D) for `o`; use `spawn` with `shell: false` (pattern `extensions/subagents.ts:156`).
- Assumption A1: pi's API for enumerating registered commands and suspending the TUI is unverified; writers must use the narrowest-risk approach and report what they could not verify.
- Parent-owned shared files (writers must not edit): `package.json` (new extension entry), `README.md`, `CHANGELOG.md`, `extensions/orchestrator.ts` status list.

## Tasks
- T1 [S1,S2,S3,S4] delegated (writer, parallel) — done; S3 API confirmed from installed types, not run live. RED (module missing) → GREEN 6 pass
- T2 [S5,S6] delegated (writer, parallel) — done; listing and run APIs confirmed from installed types, not run live. RED → GREEN 9 pass
- T3 [S1-S6] inline: package.json entry, README, CHANGELOG, status list, full suite — done; `npm test` 134 pass, 0 fail

## Log
- L1 (2026-11-05): "Add two independent features, each its own unit with lib code, extension wiring, and tests: 1) Changes viewer: `o` opens the selected file in $VISUAL or $EDITOR, passing the path as a literal argument (never through a shell), restoring the TUI afterwards, and reporting a launch failure as a warning. 2) Command palette: `alt+k` and `/brigadev:commands` open a searchable list of every registered brigadev command with its description; Enter runs the selected one. Launch both units as two parallel brigadev-worker writers in one subagent call. Do not commit."
- L3: Writers returned. Unverified against pi (node_modules absent): TUI stop/start on `tui`, `pi.getCommands()`, `pi.sendUserMessage("/brigadev:<name>")` running a command, pi-tui key names. No typecheck run. Needs a real pi session or installed types.
- L4: User approved `npm install`. Read the installed pi types: `pi.getCommands(): SlashCommandInfo[]` (name, description) exists; `tui.stop()`/`start()`/`requestRender(force)` exist; `sendUserMessage` goes through `prompt()`, which runs extension commands first, even while streaming. Removed the feature-detect casts in both extensions. Both extensions import cleanly; `npm test` 134 pass, 0 fail. No tsc in the dependency tree, so no typecheck. Generated package-lock.json removed.
- L2: Exploration done (brigadev-explore). Pi API for command listing/TUI suspend unverified.
