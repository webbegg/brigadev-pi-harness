// What the runner requires of a feature document before it starts: the shared S7 rules plus the runner-only ones.
import { expectFailInner, parseTicketList, validateForRun } from "../../lib/ticket-list.ts";

/** Every reason the document cannot run unattended here; empty when it can. */
export function validateDoc(text: string): string[] {
	const list = parseTicketList(text);
	const errors = validateForRun(list);
	for (const ticket of list.tickets) {
		const unfinished = ticket.status !== "done" && ticket.status !== "dropped";
		// The runner can only run commands: an observable-outcome check has no one to evaluate it.
		if (unfinished && ticket.done && !ticket.doneIsCommand) errors.push(`${ticket.id} done: is not a command`);
		// A reproduction (`! <cmd>`) proves only that the bug is there: some ticket after it must make <cmd> pass, or the run ends with the bug committed as a test.
		if (unfinished && ticket.expectFail) {
			const inner = expectFailInner(ticket.done ?? "")!;
			const fixed = list.tickets.some((other) => other.deps.includes(ticket.id) && other.status !== "dropped" && other.doneIsCommand && other.done?.trim() === inner);
			if (!fixed) errors.push(`${ticket.id} reproduces with \`${inner}\` but no ticket depends on it with that command passing`);
		}
	}
	// Every finished ticket writes one `## Log` line; failing at the first ticket would be too late.
	if (!text.split("\n").some((line) => line.trim() === "## Log")) errors.push("the document has no ## Log section");
	return [...new Set(errors)];
}
