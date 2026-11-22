// The cost cap (S1): one dollar cap per loop (a doc's `start`: its tickets, the PR loop's verify and fix tickets), kept durably and checked before new spend.
//
// Spend is read from pi-durable's `pi.usage` (`UsageDoc`: per conversation, `models` and `tools` buckets, failed and aborted attempts included): the sum of
// `usage.cost.total` over every conversation the loop owns, directly or through its descendant tasks. The loop's conversations are listed in a durable ledger, a
// Session document keyed by the loop task's id, which every place that creates a worker or verify conversation appends to in the same commit that creates it; so
// no other loop's conversation is ever read, and the same ledger holds the cap (`start --cap`, `resume --cap` write it).
//
// Checked at the boundaries (the loop before a ticket, a ticket before each attempt, the PR loop before verify and before a fix ticket): at or over the cap the loop parks
// needs-you. Inside a conversation the cap is a `beforeTool` block (src/guard.ts): the conversation carries `{ base, cap }` (the loop's spend before it started, and the
// cap it started under), which is exact because a loop runs one conversation at a time, so one `pi.usage` read decides a call. A provider that reports no cost for a
// response counts as $0: nothing here can see what is not reported.
import { defineDoc, defineDocFamily, UsageDoc } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ConversationId, DocumentReader, HookApi, ToolHookCall, Tx, UsageState } from "@earendil-works/pi-durable";
import { VERDICT_TOOL } from "./verify.ts";

export { UsageDoc };

/** The cap of a loop whose `start` gave none, in dollars. */
export const DEFAULT_CAP = 5;
/** Costs are sums of floats: "at the cap" tolerates their rounding. */
const EPSILON = 1e-9;

export const dollars = (amount: number): string => `$${amount.toFixed(2)}`;
/** What a loop that parks at its cap says. */
export const capMessage = (spent: number, cap: number): string => `cost cap reached: ${dollars(spent)} of ${dollars(cap)} spent`;
/** Whether `spent` is at or over `cap`. */
export const reached = (spent: number, cap: number): boolean => spent + EPSILON >= cap;
/** A cap is a positive, finite number of dollars. */
export const validCap = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > 0;

// ---------------------------------------------------------------------------------------------------------------------
// Documents

export type LedgerState = { cap: number; convs: number[] };
/** The loop's cap and the conversations it owns (appended in the commit that creates each), keyed by the loop task's id. */
export const LedgerDoc = defineDocFamily<LedgerState, { cap: number }>({
	kind: "brigadev.cost-ledger",
	version: 1,
	scope: "session",
	family: true,
	initial: (seed) => ({ cap: seed.cap, convs: [] }),
	checkpointWhen: () => true,
});

export type GuardState = { cap: number; base: number };
/** What a worker or verify conversation was started under (`cap: 0`: no cap): the loop's spend before it, and the cap. */
export const CostGuardDoc = defineDoc<GuardState>({
	kind: "brigadev.cost-guard",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ cap: 0, base: 0 }),
	checkpointWhen: () => true,
});

/** The dollars of one conversation's `pi.usage` (an absent document is $0). */
export function usageCost(state: Readonly<UsageState> | undefined): number {
	let total = 0;
	for (const bucket of [state?.models, state?.tools]) {
		for (const usage of Object.values((bucket ?? {}) as Record<string, { cost?: { total?: number } } | undefined>)) {
			const amount = usage?.cost?.total;
			if (typeof amount === "number" && Number.isFinite(amount)) total += amount;
		}
	}
	return total;
}

/** In the commit that creates `conversation`: list it in the loop's ledger and record what it starts under. */
export async function track(tx: Tx, loop: string, conversation: ConversationId, guard: GuardState): Promise<void> {
	const ledger = await tx.doc(LedgerDoc, loop, { cap: guard.cap });
	if (!ledger.convs.includes(conversation)) ledger.convs.push(conversation);
	const own = await tx.doc(CostGuardDoc, conversation);
	own.cap = guard.cap;
	own.base = guard.base;
}

/** Set the loop's cap, in the caller's commit. */
export async function setCap(tx: Tx, loop: string, cap: number): Promise<void> {
	(await tx.doc(LedgerDoc, loop, { cap })).cap = cap;
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading the spend

export interface Spend {
	spent: number;
	cap: number;
}

/**
 * Reads a loop's spend from its ledger. A conversation that is not the newest of its loop is over (a loop runs one at a time, and a rerun after a crash continues the
 * newest), so its total is remembered; only the newest is read again. One meter per runner: ids are the store's.
 */
export class CostMeter {
	private readonly settled = new Map<number, number>();

	async conversation(reader: Pick<DocumentReader, "snapshot">, id: ConversationId, context: Context, final = false): Promise<number> {
		const known = this.settled.get(id);
		if (known !== undefined) return known;
		const total = usageCost(await reader.snapshot(UsageDoc, id, context));
		if (final) this.settled.set(id, total);
		return total;
	}

	async read(reader: Pick<DocumentReader, "snapshot">, loop: string, context: Context): Promise<Spend> {
		const ledger = await reader.snapshot(LedgerDoc, loop, context);
		const convs = ledger?.convs ?? [];
		let spent = 0;
		for (let index = 0; index < convs.length; index += 1) spent += await this.conversation(reader, convs[index] as ConversationId, context, index < convs.length - 1);
		return { spent, cap: ledger?.cap ?? DEFAULT_CAP };
	}
}

// ---------------------------------------------------------------------------------------------------------------------
// Inside a conversation

const warnToStderr = (message: string): void => console.error(message);

/**
 * The `beforeTool` decision of the cap: a reason once the conversation's loop is at or over its cap, else undefined. Cheap (two committed reads of this conversation's own
 * documents) and fail safe: spend that cannot be read does not block on that ground, and is logged. The verdict tool, which is how a verify run ends, is let through.
 */
export async function costBlock(call: Pick<ToolHookCall, "name">, api: Pick<HookApi, "conversationId" | "snapshot">, context: Context, warn: (message: string) => void = warnToStderr): Promise<string | undefined> {
	if (call.name === VERDICT_TOOL) return undefined;
	try {
		const guard = await api.snapshot(CostGuardDoc, api.conversationId, context);
		if (!guard || !(guard.cap > 0)) return undefined;
		const own = usageCost(await api.snapshot(UsageDoc, api.conversationId, context));
		return reached(guard.base + own, guard.cap) ? `Blocked: the loop's cost cap (${dollars(guard.cap)}) is reached; finish now.` : undefined;
	} catch (error) {
		warn(`cost cap: cannot read the spend of conversation ${String(api.conversationId)} (${error instanceof Error ? error.message : String(error)}); not blocking on that ground`);
		return undefined;
	}
}
