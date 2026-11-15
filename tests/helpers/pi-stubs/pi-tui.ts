// TEST-ONLY stub of `@earendil-works/pi-tui` (a Pi runtime package that is not installed in this repo).
// Only the names extensions/subagents.ts and lib/tui-adapters.ts import. The components just keep their constructor
// arguments; nothing renders.

export const visibleWidth = (text: string): number => text.length;
export const truncateToWidth = (text: string, width: number, ellipsis = ""): string => (text.length <= width ? text : text.slice(0, Math.max(0, width - ellipsis.length)) + ellipsis);
export const matchesKey = (data: string, key: string): boolean => data === key;
/** `Key.enter` is "enter", `Key.pageDown` is "pageDown", and so on. */
export const Key: Record<string, string> = new Proxy({}, { get: (_target, name) => String(name) });

class Component {
	args: unknown[];
	children: unknown[] = [];
	constructor(...args: unknown[]) {
		this.args = args;
	}
	addChild(child: unknown): void {
		this.children.push(child);
	}
	render(): string[] {
		return [];
	}
	invalidate(): void {}
}

export class Box extends Component {}
export class Container extends Component {}
export class Markdown extends Component {}
export class Spacer extends Component {}
export class Text extends Component {}
