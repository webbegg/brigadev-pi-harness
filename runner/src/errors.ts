// Errors the CLI tells apart from a crash. Kept apart from runner.ts so the CLI's refusal paths do not load pi-durable.

/** `start` for a doc whose loop already exists with other options: the loop's input (the PR loop on or off, the worktree) is fixed when it is first started. */
export class LoopStartedDifferently extends Error {
	name = "LoopStartedDifferently";
}
