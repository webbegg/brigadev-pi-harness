// Doctor checks that need no Pi (S17): tools other packages register that compete with brigadev or bloat every request.

import { realpathSync } from "node:fs";
import { sep } from "node:path";
import { PACKAGE_ROOT } from "./runtime.ts";

/** The part of `pi.getAllTools()` entries the check reads. */
export interface ToolInfo {
	name: string;
	description?: string;
	parameters?: unknown;
	sourceInfo?: { path?: string; source?: string };
}

/** Other packages' tool definitions beyond this many chars in total are reported. */
export const TOOL_CHARS_LIMIT = 8000;

const DELEGATION = /delegat(?:e|ion)|subagent|spawn[\s_-]*agents?/i;

const roots = (() => {
	const list = [PACKAGE_ROOT];
	try {
		list.push(realpathSync(PACKAGE_ROOT));
	} catch {}
	return list.map((r) => r + sep);
})();

const isBrigadev = (tool: ToolInfo): boolean => roots.some((r) => (tool.sourceInfo?.path ?? "").startsWith(r));
const isShipped = (tool: ToolInfo): boolean => tool.sourceInfo?.source === "builtin" || tool.sourceInfo?.source === "sdk";
const sizeOf = (tool: ToolInfo): number => JSON.stringify({ name: tool.name, description: tool.description, parameters: tool.parameters }).length;
const origin = (tool: ToolInfo): string => tool.sourceInfo?.source ?? tool.sourceInfo?.path ?? "unknown source";
const n = (x: number): string => x.toLocaleString("en-US");

export interface ToolReport {
	/** Tools from packages other than brigadev (Pi built-ins and sdk tools excluded). */
	foreign: Array<ToolInfo & { chars: number }>;
	/** Foreign tools that look like a delegation tool. */
	delegation: ToolInfo[];
	totalChars: number;
	oversized: boolean;
	warnings: string[];
}

export function analyzeTools(tools: readonly ToolInfo[]): ToolReport {
	const foreign = tools.filter((t) => !isShipped(t) && !isBrigadev(t)).map((t) => ({ ...t, chars: sizeOf(t) }));
	const delegation = foreign.filter((t) => DELEGATION.test(t.name) || DELEGATION.test(t.description ?? ""));
	const totalChars = foreign.reduce((sum, t) => sum + t.chars, 0);
	const oversized = totalChars > TOOL_CHARS_LIMIT;
	const warnings: string[] = [];
	if (delegation.length) warnings.push(`another package registers a delegation tool that competes with subagent: ${delegation.map((t) => `${t.name} (${origin(t)})`).join(", ")}`);
	if (oversized) {
		const top = [...foreign].sort((a, b) => b.chars - a.chars).slice(0, 3);
		warnings.push(`other packages' tool definitions are ${n(totalChars)} chars (limit ${n(TOOL_CHARS_LIMIT)}), sent on every request: ${top.map((t) => `${t.name} ${n(t.chars)}`).join(", ")}`);
	}
	return { foreign, delegation, totalChars, oversized, warnings };
}
