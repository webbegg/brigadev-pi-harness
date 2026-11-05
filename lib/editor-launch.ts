/**
 * Pure helpers for opening a file in the user's editor. The editor string is
 * split into command + args by hand and the file path is appended as ONE argv
 * element, so nothing is ever interpreted by a shell.
 */

export type EditorLaunch =
	| { ok: true; command: string; args: string[] }
	| { ok: false; reason: "no-editor"; message: string };

/** $VISUAL wins over $EDITOR; blank values count as unset. */
export function resolveEditor(env: Record<string, string | undefined>): string | undefined {
	for (const name of ["VISUAL", "EDITOR"]) {
		const value = env[name]?.trim();
		if (value) return value;
	}
	return undefined;
}

/** Split on whitespace, honouring single and double quotes. No expansion, no escapes. */
export function splitCommand(input: string): string[] {
	const parts: string[] = [];
	let current = "";
	let quote: string | undefined;
	let started = false;
	for (const char of input) {
		if (quote) {
			if (char === quote) quote = undefined;
			else current += char;
		} else if (char === '"' || char === "'") {
			quote = char;
			started = true;
		} else if (/\s/.test(char)) {
			if (started) parts.push(current);
			[current, started] = ["", false];
		} else {
			current += char;
			started = true;
		}
	}
	if (started) parts.push(current);
	return parts;
}

export function buildEditorLaunch(env: Record<string, string | undefined>, absolutePath: string): EditorLaunch {
	const [command, ...args] = splitCommand(resolveEditor(env) ?? "");
	if (!command) return { ok: false, reason: "no-editor", message: "No editor configured. Set $VISUAL or $EDITOR." };
	return { ok: true, command, args: [...args, absolutePath] };
}
