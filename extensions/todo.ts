/**
 * brigadev todo: the visible session projection of ODD tasks.
 *
 * The feature document stays the authority for large work; this list is the
 * UI view of it. State lives in tool result details so branching and /tree
 * restore the right list for each point in history.
 *
 * The list never enters the system prompt: changing it there would rewrite
 * the cached prompt prefix on every update. Each todo tool result already
 * carries the list in the conversation; only when the conversation lost it
 * (compaction) does the next run append it once as a hidden message.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isChildSession } from "../lib/runtime.ts";
import { isOpen, TODO_GLYPH as GLYPH, TODO_STATUSES as STATUSES, todoCard, type Todo, type TodoStatus as Status } from "../lib/todo-card.ts";

interface TodoDetails {
	todos: Todo[];
	error?: string;
}

const WIDGET_KEY = "brigadev-todo";
const COLLAPSE_KEY = "ctrl+shift+t";
const STATE_MESSAGE = "brigadev-todo-state";

const TodoItem = Type.Object({
	id: Type.String({ description: "Stable task ID, e.g. T1 (match the feature document)" }),
	text: Type.String(),
	status: Type.Optional(StringEnum(STATUSES)),
	note: Type.Optional(Type.String({ description: "For blocked: what it waits for and what unblocks it. For dropped: why." })),
});

const Params = Type.Object({
	action: StringEnum(["set", "update", "list", "clear"] as const, {
		description: "set: replace the whole list; update: change one item's status/note; list; clear",
	}),
	todos: Type.Optional(Type.Array(TodoItem, { description: "For set" })),
	id: Type.Optional(Type.String({ description: "For update" })),
	status: Type.Optional(StringEnum(STATUSES)),
	note: Type.Optional(Type.String()),
});

function summary(todos: Todo[]): string {
	return todos.map((t) => `${GLYPH[t.status]} ${t.id} ${t.text}${t.note ? ` — ${t.note}` : ""} [${t.status}]`).join("\n") || "No todos";
}

export default function (pi: ExtensionAPI) {
	if (isChildSession()) return;
	let todos: Todo[] = [];
	// Whether the model's current context already holds the latest list.
	let listInContext = false;
	let collapsed = false;
	// Agent runs since the last todo update while work is open (shown as "stale").
	let staleRuns = 0;
	let updatedThisRun = false;

	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		const card = todoCard(todos, { collapsed, staleRuns });
		if (!card) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(WIDGET_KEY, (_tui, theme) => ({
			invalidate() {},
			render(width: number): string[] {
				const hint = theme.fg("dim", ` ${COLLAPSE_KEY}`);
				const title = theme.fg(card.header.tone, theme.bold(card.header.text));
				const rule = theme.fg("borderMuted", "─".repeat(Math.max(0, width - card.header.text.length - COLLAPSE_KEY.length - 5)));
				return [
					truncateToWidth(`${theme.fg("borderMuted", "─ ")}${title} ${rule}${hint}`, width),
					...card.rows.map((r) => truncateToWidth(`  ${theme.fg(r.tone, r.text)}`, width)),
				];
			},
		}));
	};

	const reconstruct = (ctx: ExtensionContext) => {
		todos = [];
		listInContext = false;
		staleRuns = 0;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "compaction") listInContext = false;
			else if (entry.type === "custom_message" && entry.customType === STATE_MESSAGE) listInContext = true;
			else if (entry.type === "message" && entry.message.role === "toolResult" && entry.message.toolName === "todo") {
				const details = entry.message.details as TodoDetails | undefined;
				if (details?.todos) todos = details.todos;
				listInContext = true;
			}
		}
		refreshWidget(ctx);
	};

	pi.on("session_start", async (_event, ctx) => reconstruct(ctx));
	pi.on("session_tree", async (_event, ctx) => reconstruct(ctx));

	pi.on("session_compact", async () => {
		listInContext = false;
	});

	pi.on("agent_start", async () => {
		updatedThisRun = false;
	});

	pi.on("agent_end", async (_event, ctx) => {
		staleRuns = !updatedThisRun && todos.some(isOpen) ? staleRuns + 1 : 0;
		refreshWidget(ctx);
	});

	pi.registerShortcut(COLLAPSE_KEY, {
		description: "Collapse or expand the brigadev todo card",
		handler: async (ctx) => {
			collapsed = !collapsed;
			refreshWidget(ctx);
		},
	});

	pi.on("before_agent_start", async () => {
		const open = todos.filter(isOpen);
		if (open.length === 0 || listInContext) return undefined;
		listInContext = true;
		return {
			message: { customType: STATE_MESSAGE, content: `Open todo items (keep them current with the todo tool):\n${summary(todos)}`, display: false },
		};
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Visible task list for large ODD work only (never for small tasks). Mirror the feature document's ## Tasks with the same IDs. Statuses: pending, in_progress, done, blocked (note what unblocks it), dropped (note why).",
		parameters: Params,

		async execute(_id, params, _signal, _onUpdate, ctx) {
			const reply = (text: string, error?: string) => {
				listInContext = true;
				if (!error && params.action !== "list") {
					updatedThisRun = true;
					staleRuns = 0;
				}
				refreshWidget(ctx);
				return { content: [{ type: "text" as const, text }], details: { todos: todos.map((t) => ({ ...t })), error } as TodoDetails };
			};
			switch (params.action) {
				case "set": {
					const ids = new Set<string>();
					for (const t of params.todos ?? []) {
						if (ids.has(t.id)) return reply(`Duplicate todo id ${t.id}`, "duplicate id");
						ids.add(t.id);
					}
					todos = (params.todos ?? []).map((t) => ({ id: t.id, text: t.text, status: t.status ?? "pending", note: t.note }));
					return reply(summary(todos));
				}
				case "update": {
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) return reply(`Todo ${params.id ?? "(missing id)"} not found`, "not found");
					if (params.status) todo.status = params.status;
					if (params.note !== undefined) todo.note = params.note || undefined;
					if ((todo.status === "blocked" || todo.status === "dropped") && !todo.note) {
						return reply(`${todo.id} is ${todo.status}; add a note saying ${todo.status === "blocked" ? "what it waits for" : "why"}`, "note required");
					}
					return reply(summary(todos));
				}
				case "clear":
					todos = [];
					return reply("Cleared");
				default:
					return reply(summary(todos));
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.id) text += ` ${theme.fg("accent", args.id)}`;
			if (args.status) text += ` ${theme.fg("dim", args.status)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, _options, theme) {
			const details = result.details as TodoDetails | undefined;
			if (details?.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const list = details?.todos ?? [];
			if (list.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
			const color = (s: Status) => (s === "done" ? "success" : s === "blocked" ? "warning" : s === "dropped" ? "dim" : s === "in_progress" ? "accent" : "muted");
			return new Text(list.map((t) => theme.fg(color(t.status), `${GLYPH[t.status]} ${t.id} ${t.text}`)).join("\n"), 0, 0);
		},
	});
}
