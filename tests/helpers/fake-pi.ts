// TEST-ONLY fakes of Pi's ExtensionAPI (`pi`) and ExtensionContext (`ctx`) that record what an extension does with them.

type Handler = (event: any, ctx: any) => unknown;

export interface FakeTool {
	name: string;
	parameters: any;
	description?: string;
	execute: (id: string, params: any, signal?: AbortSignal, onUpdate?: unknown, ctx?: any) => Promise<any>;
	[key: string]: unknown;
}

export interface FakePi {
	tools: Map<string, FakeTool>;
	handlers: Map<string, Handler[]>;
	messages: Array<{ message: any; options: any }>;
	renderers: Map<string, unknown>;
	commands: Map<string, any>;
	shortcuts: Map<string, any>;
	entries: Array<{ type: string; data: unknown }>;
	registerTool(tool: FakeTool): void;
	on(event: string, handler: Handler): void;
	sendMessage(message: unknown, options?: unknown): void;
	registerMessageRenderer(type: string, renderer: unknown): void;
	registerCommand(name: string, command: unknown): void;
	registerShortcut(key: string, shortcut: unknown): void;
	appendEntry(type: string, data: unknown): void;
	exec(command: string, args: string[], options?: unknown): Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>;
	/** Runs every handler registered for `event`, in order, and awaits each. */
	fire(event: string, payload: unknown, ctx: unknown): Promise<void>;
	tool(name: string): FakeTool;
}

export function createFakePi(): FakePi {
	const pi: FakePi = {
		tools: new Map(),
		handlers: new Map(),
		messages: [],
		renderers: new Map(),
		commands: new Map(),
		shortcuts: new Map(),
		entries: [],
		registerTool: (tool) => void pi.tools.set(tool.name, tool),
		on: (event, handler) => void pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]),
		sendMessage: (message, options) => void pi.messages.push({ message, options }),
		registerMessageRenderer: (type, renderer) => void pi.renderers.set(type, renderer),
		registerCommand: (name, command) => void pi.commands.set(name, command),
		registerShortcut: (key, shortcut) => void pi.shortcuts.set(key, shortcut),
		appendEntry: (type, data) => void pi.entries.push({ type, data }),
		exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
		async fire(event, payload, ctx) {
			for (const handler of pi.handlers.get(event) ?? []) await handler(payload, ctx);
		},
		tool(name) {
			const tool = pi.tools.get(name);
			if (!tool) throw new Error(`tool ${name} was not registered`);
			return tool;
		},
	};
	return pi;
}

export interface FakeCtx {
	hasUI: boolean;
	cwd: string;
	/** What `ctx.isIdle()` answers; tests flip it. */
	idle: boolean;
	notifications: Array<{ message: string; type?: string }>;
	statuses: Array<{ key: string; text: string | undefined }>;
	widgets: Array<{ key: string; content: unknown }>;
	[key: string]: unknown;
}

export function createFakeCtx(options: { cwd: string; hasUI?: boolean; idle?: boolean }): FakeCtx {
	const ctx: FakeCtx = {
		hasUI: options.hasUI ?? true,
		cwd: options.cwd,
		idle: options.idle ?? false,
		notifications: [],
		statuses: [],
		widgets: [],
		mode: "print",
		model: undefined,
		thinkingLevel: "off",
		isIdle: () => ctx.idle,
		isProjectTrusted: () => false,
		modelRegistry: { getAll: () => [], find: () => undefined },
		sessionManager: { getBranch: () => [] },
		ui: {
			notify: (message: string, type?: string) => void ctx.notifications.push({ message, type }),
			setStatus: (key: string, text: string | undefined) => void ctx.statuses.push({ key, text }),
			setWidget: (key: string, content: unknown) => void ctx.widgets.push({ key, content }),
			custom: async () => undefined,
		},
	};
	return ctx;
}
