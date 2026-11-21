// The end of a command's output, as the brief and the doc show it: the last lines, bounded in size.
const TAIL_LINES = 40;
const TAIL_CHARS = 4000;

export function tailOf(output: string): string {
	const lines = output.trimEnd().split("\n");
	const tail = lines.slice(-TAIL_LINES).join("\n");
	return tail.length > TAIL_CHARS ? tail.slice(-TAIL_CHARS) : tail;
}
