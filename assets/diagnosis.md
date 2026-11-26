# Diagnosis loop

Read this when fixing a bug. A bug starts with a failing test (test-first as in the orchestrator prompt); RED and GREEN are observed, never assumed.

Redact secrets in every command, output, and log you show or record: write `<REDACTED>`.

## 1. A failing command first

Before any hypothesis, run one command that fails because of this bug, and show its output. No theory from reading code until it exists.

- Best seam first: a failing test, then a script or CLI call with a fixture, a request against a dev server, a replayed captured input, a throwaway harness, and bisection or old-vs-new diffing when the bug appeared between two states.
- It must assert the user's exact symptom, not "runs without error", and be fast, deterministic, and runnable unattended. For a flaky bug, loop it until the failure rate is debuggable.
- A recognised test or check command is recorded in the evidence log automatically, and the PR body quotes the failing run as the RED. Run it as the command itself; a pipe is fine, but `||` or `;` after it records the run as unknown.
- A CI failure: with `codemode`, fetch the log (`gh run view <id> --log-failed`) inside one script and return only the failing steps and errors, not the whole log.
- No loop possible: stop, list what you tried, and ask for access, a redacted artifact, or permission for temporary instrumentation. Do not guess.

Close this step with one block, before any source edit:

- `Reproduced:` the command, an excerpt of its failing output that shows the symptom, and the test path (or `no test yet` when the command is a script).
- `Not reproduced:` what was tried, each with its result, and what would unblock it. Then stop.

## 2. Minimise

Cut inputs, callers, config, data, and steps one at a time, re-running after each cut. Stop when every remaining element is load-bearing: removing any one makes the command pass. This is the regression test.

## 3. Rank hypotheses before testing

Write 3 to 5 hypotheses, ranked. Each states a prediction: "If X is the cause, changing Y makes the bug disappear (or Z makes it worse)". Discard what cannot be falsified. State the ranked list, then test in that order without waiting.

## 4. Probe one variable at a time

Each probe maps to one prediction. Prefer a debugger or a targeted log at a boundary that tells hypotheses apart; never log everything. Tag every temporary log with a unique prefix such as `[DEBUG-a4f2]`. For performance bugs, measure a baseline first, then bisect.

## 5. Fix and prove

1. Turn the minimised repro into the failing test (RED) at the seam where the bug really occurs. If only a shallow seam exists, say so: that is a finding, not a licence for a test that cannot catch the bug.
2. Make the minimum root-cause change, then run the same command again (GREEN) and the suite.
3. Re-run the step 1 command on the original, un-minimised scenario.

## 6. Clean up

Run `grep -rn "DEBUG-a4f2" .` with your prefix and remove every hit; delete throwaway harnesses. State the hypothesis that proved correct in the commit message so the next debugger learns from it. End with the Risk line.
