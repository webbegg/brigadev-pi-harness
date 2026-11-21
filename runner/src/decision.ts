// S9 / S4: a ticket that needs a product or design choice parks instead of guessing, and a command the guard denied can be approved
// by the answer. Three parts: the worker's `ask_user_choice` tool, the answer rule, and the one-time command approval the guard reads.
//
// How the tool ends the worker's attempt without a failure: the tool records the question in a conversation document
// (`DecisionDoc`, on the worker's own conversation) in the call's commit and returns `control: { terminate: true }`, which ends the
// run without another model request. The ticket's `check` phase then reads that document instead of running the done check, so a
// decision is neither a pass nor a failed attempt. (The call's result entry is not readable from a task: a task reads only its own
// conversation's history, so a document is the way the tool hands data to the ticket task.)
import { defineDoc, defineTool } from "@earendil-works/pi-durable";
import type { HookApi, ToolHookCall } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { arr, num, obj, opt, str } from "@earendil-works/pi-schema";
import { type Answer } from "./signals.ts";

export const ASK_TOOL = "ask_user_choice";
/** An option whose label starts with this, chosen with `command` set, approves the command. */
export const APPROVE_PREFIX = "Approve";

export interface Option {
	label: string;
	description?: string;
}

/** What the worker asked: `recommended` is a 1-based option number, `command` an exact bash command it needs approved (null: none). */
export interface Decision {
	question: string;
	options: Option[];
	recommended: number | null;
	command: string | null;
}

/** A decision with the user's answer, as the rerun's brief carries it. */
export interface AnsweredDecision extends Decision {
	answer: string;
	approved: boolean;
}

/**
 * The approval rule, kept simple: a decision with a `command` approves it when the answer is `--approve`, or when the chosen option's
 * label starts with `Approve` (the answer equals the label of such an option: by its number, or by typing the label).
 */
export function approves(decision: Decision, answer: Answer): boolean {
	if (decision.command === null) return false;
	if (answer.approve === true) return true;
	const label = answer.option !== undefined ? decision.options[answer.option - 1]?.label : answer.choice;
	return label !== undefined && label.startsWith(APPROVE_PREFIX) && decision.options.some((option) => option.label === label);
}

// ---------------------------------------------------------------------------------------------------------------------
// The tool

type DecisionState = { asked: boolean; question: string; options: Array<{ label: string; description: string }>; recommended: number; command: string };

/** The decision a worker conversation asked for (`asked: false` until it does). Strings and `0`/`""` stand for absent, since a document holds JSON. */
export const DecisionDoc = defineDoc<DecisionState>({
	kind: "brigadev.decision",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ asked: false, question: "", options: [], recommended: 0, command: "" }),
	checkpointWhen: () => true,
});

export function decisionOf(state: Readonly<DecisionState> | undefined): Decision | undefined {
	if (!state?.asked) return undefined;
	return {
		question: state.question,
		options: state.options.map((option) => (option.description === "" ? { label: option.label } : { label: option.label, description: option.description })),
		recommended: state.recommended > 0 ? state.recommended : null,
		command: state.command === "" ? null : state.command,
	};
}

const Parameters = obj({
	question: str({ description: "One focused question" }),
	options: arr(obj({ label: str(), description: opt(str({ description: "Consequence or tradeoff" })) }), { description: "2-6 options" }),
	recommended: opt(num({ description: "1-based recommended option" })),
	command: opt(str({ description: "An exact bash command you need approved (the runner denied it as `needs you`). Include an option whose label starts with `Approve`." })),
});

const text = (value: string) => [{ type: "text" as const, text: value }];

export function createAskTool() {
	return defineTool({
		name: ASK_TOOL,
		description:
			"Ask the user one focused question with concrete options, for a real product, design, or delivery decision only. You never pick such an option yourself, not even a reversible one. Calling this ends your attempt: the ticket parks until the user answers, then runs again with the answer. Set `command` when you need an exact bash command approved, with an option whose label starts with `Approve`.",
		parameters: Parameters,
		replay: "safe",
		async execute(args, api, context) {
			const options = args.options;
			if (options.length < 2 || options.length > 6) return { isError: true, output: text("Error: give 2-6 options") };
			if (options.some((option) => option.label.trim() === "")) return { isError: true, output: text("Error: every option needs a label") };
			if (args.recommended !== undefined && (!Number.isInteger(args.recommended) || args.recommended < 1 || args.recommended > options.length)) {
				return { isError: true, output: text(`Error: recommended is a 1-based option number (1-${options.length})`) };
			}
			await api.commit(async (tx) => {
				const doc = await tx.doc(DecisionDoc, api.conversationId);
				if (doc.asked) return; // the first question of an attempt stands; a rerun of this call finds it recorded
				doc.asked = true;
				doc.question = args.question;
				doc.options = options.map((option) => ({ label: option.label, description: option.description ?? "" }));
				doc.recommended = args.recommended ?? 0;
				doc.command = args.command ?? "";
			}, context);
			return {
				output: text("Your question is recorded. The ticket parks until the user answers; make no further tool calls."),
				control: { terminate: true },
			};
		},
	});
}

// ---------------------------------------------------------------------------------------------------------------------
// Command approval

type ApprovalState = { command: string };

/** The one command the user approved for this worker conversation (`""`: none). Written when the rerun's conversation is created. */
export const ApprovalDoc = defineDoc<ApprovalState>({
	kind: "brigadev.approval",
	version: 1,
	scope: "conversation",
	history: "latest",
	fork: "initial",
	initial: () => ({ command: "" }),
	checkpointWhen: () => true,
});

type Part = { type?: string; id?: string; name?: string; arguments?: { command?: unknown } };

/**
 * Whether the guard may lift its confirm-class denial of `command` for this call: the conversation holds an approval for exactly this
 * string, and no earlier call of the conversation ran it (one use). Entries are the conversation's own history, so the count survives a
 * restart; a call the guard itself blocked used nothing. Fails closed: a nested call (`call.parent`), a call not found in the history,
 * or any read error means no approval. Scope is the ticket, because only the ticket's rerun creates the conversation with the document.
 */
export async function commandApproved(api: HookApi, call: ToolHookCall, command: string, context: Context): Promise<boolean> {
	try {
		if (call.parent !== undefined) return false;
		const approval = await api.snapshot(ApprovalDoc, api.conversationId, context);
		if (!approval || approval.command === "" || approval.command !== command) return false;

		// Calls of this command in history order, and the ones the guard blocked.
		const identical: string[] = [];
		const blocked = new Set<string>();
		let cursor: Awaited<ReturnType<HookApi["entries"]>>["next"];
		do {
			const page = await api.entries({ order: "ascending" }, 200, cursor, context);
			for (const entry of page.items) {
				const message = entry.model?.[0];
				if (message?.role === "assistant" && Array.isArray(message.content)) {
					for (const part of message.content as Part[]) {
						if (part.type === "toolCall" && part.name === "bash" && part.id !== undefined && part.arguments?.command === command) identical.push(part.id);
					}
				} else if (message?.role === "toolResult") {
					const diagnostics = (entry.data as { diagnostics?: Array<{ code?: string }> } | undefined)?.diagnostics ?? [];
					if (diagnostics.some((diagnostic) => diagnostic.code === "blocked")) blocked.add(message.toolCallId);
				}
			}
			cursor = page.next;
		} while (cursor !== undefined);

		const at = identical.indexOf(call.id);
		if (at === -1) return false;
		return identical.slice(0, at).every((id) => blocked.has(id));
	} catch {
		return false;
	}
}
