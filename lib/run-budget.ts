// Optional wall-clock budget for one subagent run (agent frontmatter `budgetMinutes`). When it is spent the child is
// asked once to wrap up and return what it has; a child that still has not finished after the wrap-up grace is
// terminated as a failure. No Pi imports: runChild (lib/child-run.ts) owns the timers and the child.

/** How long a child has to return its result after the wrap-up request. */
export const DEFAULT_WRAP_UP_GRACE_MS = 3 * 60_000;
/** The longest delay setTimeout honours; a longer one fires after 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;
/** The prefix of every over-budget failure; lib/fallback.ts never falls back on it. */
export const OVER_BUDGET_PREFIX = "over budget: ";

export interface RunBudget {
	budgetMs: number;
	graceMs: number;
}

/** A positive, finite number of minutes from frontmatter (YAML number or numeric string), else undefined. */
export function budgetMinutesOf(value: unknown): number | undefined {
	const minutes = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
	return Number.isFinite(minutes) && minutes > 0 ? minutes : undefined;
}

/** The run's budget, or undefined when the agent has none or `BRIGADEV_RUN_BUDGET=off`. */
export function resolveRunBudget(budgetMinutes: number | undefined, env: Record<string, string | undefined>): RunBudget | undefined {
	if (budgetMinutes === undefined || env.BRIGADEV_RUN_BUDGET?.trim().toLowerCase() === "off") return undefined;
	const raw = env.BRIGADEV_WRAP_UP_GRACE_MS;
	const grace = Number(raw);
	const graceMs = raw?.trim() && Number.isFinite(grace) && grace > 0 ? grace : DEFAULT_WRAP_UP_GRACE_MS;
	return { budgetMs: Math.min(budgetMinutes * 60_000, MAX_TIMER_MS), graceMs: Math.min(graceMs, MAX_TIMER_MS) };
}

const minutes = (ms: number) => Math.round((ms / 60_000) * 10) / 10;

export const wrapUpMessage = (budgetMinutes: number): string =>
	`[brigadev runtime] Your ${budgetMinutes} min run budget is spent. Start no new work. In your next turn, return your result now (through structured_output when your instructions require it) with what you have established, and list everything you did not get to as unverified or not done.`;

/** What became of the wrap-up request: the over-budget failure says whether the child ever got it. */
export type WrapUpDelivery =
	| { state: "accepted" }
	| { state: "held" }
	| { state: "sent" }
	| { state: "not_delivered" }
	| { state: "rejected"; error: string };

const undelivered = (delivery: WrapUpDelivery): string | undefined => {
	switch (delivery.state) {
		case "accepted":
			return undefined;
		case "held":
			return "the wrap-up request was never sent: the child started no turn";
		case "sent":
			return "the child never acknowledged the wrap-up request";
		case "not_delivered":
			return "the wrap-up request was not delivered: the child's input was closed";
		case "rejected":
			return `the child rejected the wrap-up request: ${delivery.error}`;
	}
};

/** Never retried on another model (lib/fallback.ts): a second model would run just as long. */
export const overBudgetMessage = (budgetMinutes: number, graceMs: number, delivery: WrapUpDelivery = { state: "accepted" }): string => {
	const reason = undelivered(delivery);
	return reason
		? `${OVER_BUDGET_PREFIX}no result ${minutes(graceMs)} min after the ${budgetMinutes} min budget; ${reason}`
		: `${OVER_BUDGET_PREFIX}no result ${minutes(graceMs)} min after the ${budgetMinutes} min wrap-up request`;
};
